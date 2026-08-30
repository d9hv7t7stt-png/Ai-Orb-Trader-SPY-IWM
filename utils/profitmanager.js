// Profit Manager — polls open option positions every 30 seconds during market hours.
// Handles: cross-entry ORB level stops, breakeven, +20% scale-outs, EOD 50%, trailing stops.

var stateModule = require("./state");
var exitlogic = require("./exitlogic");
var trayd = require("./trayd");
var rh = require("./robinhood");
var yahoo = require("./yahoo");
var pnlUtil = require("./pnl");
var reconcile = require("./reconcile");

var lastReconcileMs = 0;
var RECONCILE_INTERVAL_MS = 5 * 60 * 1000;

async function checkCrossEntryStop(ticker, pos, s) {
  if (!pos.crossEntry || !pos.stopMode || pos.stopMode === "mid") return false;
  var orb = s.orb[ticker];
  if (!orb || !orb.set) return false;
  var und = await yahoo.getUnderlyingPrice(ticker);
  if (!und || und <= 0) return false;

  var hit = false;
  var reason = "";
  if (pos.side === "call" && pos.stopMode === "orb_low" && und < orb.low) {
    hit = true;
    reason = "Cross-entry stop — SPY closed below ORB low $" + orb.low.toFixed(2);
  }
  if (pos.side === "put" && pos.stopMode === "orb_high" && und > orb.high) {
    hit = true;
    reason = "Cross-entry stop — SPY closed above ORB high $" + orb.high.toFixed(2);
  }
  if (!hit) return false;

  var contracts = pos.contracts;
  stateModule.logEvent("STOP_OUT", ticker + " " + reason + " (underlying $" + und.toFixed(2) + ")");
  var rhPositions = await rh.getOpenOptionPositions();
  var rhPos = reconcile.findRhPosition(rhPositions, ticker, pos);
  var exitPrice = 0;
  if (rhPos) exitPrice = await rh.getOptionMarkByUrl(rhPos.option) || 0;
  var closed = await trayd.closeLiveOrLog(ticker, contracts, reason);
  if (!closed) return false;
  if (exitPrice > 0) {
    pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, exitPrice, contracts);
  } else if (rhPos) {
    stateModule.logEvent("PNL_WARN", ticker + " cross-entry stop — no exit mark, P&L skipped");
  }
  await notifyCrossEntryStop(ticker, exitPrice, reason);
  stateModule.closePosition(ticker, reason);
  return true;
}

async function notifyCrossEntryStop(ticker, optionPrice, reason) {
  try {
    var discord = require("./discord");
    if (discord && typeof discord.onStop === "function") {
      await discord.onStop(ticker, optionPrice || 0, reason);
    }
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] onStop: " + e.message); }
}

async function checkProfitTiers() {
  if (!exitlogic.isRegularMarketHours()) return;
  if (!rh.getToken()) return;
  var auth = await rh.checkAuthStatus();
  if (!auth.ok) return;

  var now = Date.now();
  if (now - lastReconcileMs >= RECONCILE_INTERVAL_MS) {
    lastReconcileMs = now;
    try {
      var recon = await reconcile.reconcileRhPositions();
      if (recon.ok && recon.synced && recon.synced.length) {
        stateModule.logEvent("RECONCILE", "mid-session sync: " + recon.synced.join(", "));
      }
    } catch (e) {
      console.log("[RECONCILE_ERROR]", e.message);
    }
  }

  var s = stateModule.getState();
  var tickers = ["SPY", "IWM"];
  var rhPositions = await rh.getOpenOptionPositions();

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var pos = stateModule.getPosition(ticker);
    if (!pos || pos.stopped) continue;

    if (await checkCrossEntryStop(ticker, pos, s)) continue;

    pos = await reconcile.backfillEntryFromRh(ticker, pos, rhPositions);
    if (!pos || pos.entryPrice <= 0) {
      console.log("[PROFIT_MGR] " + ticker + " waiting for entry price backfill");
      continue;
    }

    var rhPos = reconcile.findRhPosition(rhPositions, ticker, pos);
    if (!rhPos) {
      console.log("[PROFIT_MGR] No RH position found for " + ticker + " " + pos.side);
      continue;
    }

    if (Math.floor(parseFloat(rhPos.quantity)) !== pos.contracts) {
      stateModule.syncPositionQty(ticker, Math.floor(parseFloat(rhPos.quantity)));
      stateModule.applyOrderFill(ticker, {
        instrumentUrl: rhPos.option,
        strike: rhPos.strike_price,
        expiry: rhPos.expiration_date
      });
    }

    var optionPrice = await rh.getOptionMarkByUrl(rhPos.option);
    if (!optionPrice || optionPrice <= 0) {
      console.log("[PROFIT_MGR] Could not get option price for " + ticker);
      continue;
    }

    var entryPrice = pos.entryPrice;
    var contracts = pos.contracts;
    var decision = exitlogic.evaluate(pos, optionPrice);
    var gainPct = decision.gain;

    console.log("[PROFIT_MGR] " + ticker + " entry=$" + entryPrice.toFixed(2) +
      " current=$" + optionPrice.toFixed(2) + " gain=" + gainPct.toFixed(1) +
      "% tier=" + (pos.lastProfitTier || 0));

    pos.stopPct = decision.newStopPct;

    if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
      var eodQty = Math.max(1, Math.floor(contracts * exitlogic.EOD_SELL_FRAC));
      stateModule.logEvent("EOD_SELL", ticker + " 3:45 ET — selling 50% (" + eodQty + "c)");
      if (!await trayd.closeLiveOrLog(ticker, eodQty, "EOD 50% (15m before close)")) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, eodQty);
      stateModule.markEodSold(ticker, exitlogic.etDateKey());
      stateModule.reduceContracts(ticker, eodQty);
      if (pos.contracts <= 0) { stateModule.closePosition(ticker, "EOD flat"); continue; }
      contracts = pos.contracts;
    }

    if (decision.activateBreakeven) {
      stateModule.setBreakEven(ticker);
      stateModule.logEvent("BREAKEVEN", ticker + " +30% — stop moved to breakeven $" + entryPrice.toFixed(2));
    }

    if (decision.stopOut && !pos.stopped) {
      var reason = pos.breakEvenActivated
        ? "Trailing stop " + decision.newStopPct + "%"
        : "Initial stop -15%";
      stateModule.logEvent("STOP_OUT", ticker + " " + reason + " @ $" + optionPrice.toFixed(2));
      if (!await trayd.closeLiveOrLog(ticker, contracts, reason)) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, contracts);
      stateModule.closePosition(ticker, reason);
      continue;
    }

    if (decision.scaleOut) {
      var sellQty = Math.max(1, Math.floor(contracts * decision.sellFraction));
      stateModule.logEvent("PROFIT_TIER", ticker + " +" + gainPct.toFixed(1) +
        "% — selling 10% (" + sellQty + "c) @ $" + optionPrice.toFixed(2));
      if (!await trayd.closeLiveOrLog(ticker, sellQty, "+" + Math.floor(gainPct) + "% scale-out")) continue;
      pnlUtil.logTradePnL(ticker, pos.side, entryPrice, optionPrice, sellQty);
      stateModule.markProfitTier(ticker, decision.newTier);
      stateModule.reduceContracts(ticker, sellQty);
      pos = stateModule.getPosition(ticker);
      if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, "scaled out");
    }
  }
}

var profitBusy = false;

function startProfitManager() {
  console.log("[PROFIT_MGR] Starting — checks every 30s during market hours (ET)");
  setInterval(async function() {
    if (profitBusy) return;
    profitBusy = true;
    try {
      await checkProfitTiers();
    } catch (e) {
      console.log("[PROFIT_MGR_ERROR]", e.message);
    } finally {
      profitBusy = false;
    }
  }, 30 * 1000);
}

module.exports = { startProfitManager: startProfitManager, checkProfitTiers: checkProfitTiers };
