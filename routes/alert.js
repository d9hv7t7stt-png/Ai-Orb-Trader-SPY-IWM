var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");
var orbUtil = require("../utils/orb");
var yahoo = require("../utils/yahoo");
var pnlUtil = require("../utils/pnl");
var settings = require("../utils/settings");

var discord = null;
try { discord = require("../utils/discord"); } catch (e) { discord = null; }

async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") return await discord[fn].apply(null, args);
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] " + fn + ": " + e.message); }
}

async function underlyingForNotify(ticker, close) {
  if (close && parseFloat(close) > 0) return parseFloat(close);
  return await yahoo.getUnderlyingPrice(ticker);
}

async function orbLevelsFor(ticker, payloadHigh, payloadLow) {
  if (payloadHigh && payloadLow) return { high: payloadHigh, low: payloadLow };
  var ensured = await orbUtil.ensureOrbForTicker(ticker);
  if (ensured) return ensured;
  var s = stateModule.getState();
  var orb = s.orb[ticker];
  if (orb && orb.set) return { high: orb.high, low: orb.low };
  return { high: payloadHigh || 0, low: payloadLow || 0 };
}

async function placeAndFill(ticker, side, contracts) {
  var order = await trayd.placeOrder({ ticker: ticker, side: side, contracts: contracts });
  stateModule.applyOrderFill(ticker, order);
  return order;
}

async function notifyPaperEntry(ticker, side, optPrice, orbHigh, orbLow, close, opts) {
  var und = await underlyingForNotify(ticker, close);
  var useWebhookPrice = !(opts && opts.ignoreWebhookPrice);
  var paperPrice = useWebhookPrice ? (optPrice || 0) : 0;
  var args = [ticker, side, paperPrice, orbHigh, orbLow, und];
  if (opts) args.push(opts);
  var opened = await notify("onEntry", args);
  if (!opened) await notify("onAdd", [ticker, paperPrice]);
  return opened;
}

async function closeLiveOrLog(ticker, contracts, reason) {
  return trayd.closeLiveOrLog(ticker, contracts, reason);
}

function liveEntryBlocked(ticker, action) {
  if (settings.isTradingEnabled()) return false;
  stateModule.logEvent("KILL_SWITCH", ticker + " live " + action + " blocked");
  return true;
}

function isRetryableRhError(msg) {
  var m = (msg || "").toLowerCase();
  return m.indexOf("token") !== -1 || m.indexOf("auth") !== -1 || m.indexOf("timeout") !== -1
    || m.indexOf("econn") !== -1 || m.indexOf("network") !== -1 || m.indexOf("503") !== -1
    || m.indexOf("502") !== -1 || m.indexOf("429") !== -1;
}

var DEDUP_WINDOW_MS = parseInt(process.env.ORB_DEDUP_MS, 10) || 30000;
var lastSignal = {};
var processing = {};

function seenAgo(ticker, event) {
  var key = ticker + ":" + event;
  var now = Date.now();
  if (lastSignal[key] && (now - lastSignal[key]) < DEDUP_WINDOW_MS) {
    return (now - lastSignal[key]) || 1;
  }
  return 0;
}

function markSeen(ticker, event) {
  lastSignal[ticker + ":" + event] = Date.now();
}

function recentlySeen(ticker, event) {
  var ago = seenAgo(ticker, event);
  if (ago > 0) return ago;
  markSeen(ticker, event);
  return 0;
}

async function handleAlert(payload) {
  stateModule.resetDay();
  var ticker = ((payload.ticker) || "").toUpperCase();
  var event  = (payload.event || "").toLowerCase();

  if (!ticker || !event) throw new Error("Missing ticker or event");
  if (ticker !== "SPY" && ticker !== "IWM") throw new Error("Unknown ticker: " + ticker);

  var TRADE_EVENTS = ["breakout_long", "breakout_short", "stop_long", "stop_short", "expected_move_hit"];
  var guarded = TRADE_EVENTS.indexOf(event) !== -1;
  var lockedTickers = [];

  if (guarded) {
    if (processing[ticker]) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — order in progress");
      return { ok: true, deduped: true, message: ticker + " " + event + " ignored (in progress)" };
    }
    var ago = seenAgo(ticker, event);
    if (ago > 0) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — duplicate " + Math.round(ago / 1000) + "s ago");
      return { ok: true, deduped: true, message: ticker + " " + event + " duplicate ignored (" + Math.round(ago / 1000) + "s)" };
    }
    processing[ticker] = true;
    lockedTickers.push(ticker);
  }

  try {
    var result = await processEvent(payload, ticker, event, lockedTickers);
    if (guarded && result && result.ok) markSeen(ticker, event);
    return result;
  } finally {
    lockedTickers.forEach(function(t) { processing[t] = false; });
  }
}

async function tryLiveHalfEntry(ticker, side, half, total, optPrice) {
  if (liveEntryBlocked(ticker, "entry")) return { order: null, retryable: false, blocked: true };
  stateModule.logEvent("ENTRY", ticker + " " + side + " @ half=" + half + "/" + total);
  stateModule.openHalfPosition(ticker, side, half, optPrice || 0);
  try {
    var order = await placeAndFill(ticker, side, half);
    return { order: order, retryable: false };
  } catch (e) {
    stateModule.closePosition(ticker, "entry order failed");
    stateModule.logEvent("ORDER_ERROR", ticker + " " + side + " entry failed: " + e.message);
    return { order: null, retryable: isRetryableRhError(e.message), error: e.message };
  }
}

async function tryIwmCrossEntry(side, spyOrbHigh, spyOrbLow, s, lockedTickers) {
  var spyPos = stateModule.getPosition("SPY");
  var stopMode = side === "call" ? "orb_low" : "orb_high";
  var spyHalf = Math.ceil(s.contracts.SPY / 2);
  if (liveEntryBlocked("SPY", "cross-entry")) return { order: null, retryable: false, blocked: true };
  if (!processing["SPY"] && (!spyPos || spyPos.stopped) && s.orb.SPY.set) {
    processing["SPY"] = true;
    lockedTickers.push("SPY");
    stateModule.logEvent("CROSS_ENTRY", "IWM " + side + " → SPY " + side + " half=" + spyHalf + " stop=" + stopMode);
    stateModule.openHalfPosition("SPY", side, spyHalf, 0, { crossEntry: true, stopMode: stopMode });
    try {
      var cross = await placeAndFill("SPY", side, spyHalf);
      recentlySeen("SPY", side === "call" ? "cross_long" : "cross_short");
      return { order: cross, retryable: false };
    } catch (e) {
      stateModule.closePosition("SPY", "cross entry failed");
      stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
      return { order: null, retryable: isRetryableRhError(e.message), error: e.message };
    }
  }
  return null;
}

async function notifyPaperAndMaybeLiveEntry(ticker, side, half, total, optPrice, orbHigh, orbLow, close, s, lockedTickers) {
  await notifyPaperEntry(ticker, side, optPrice, orbHigh, orbLow, close);
  var livePos = stateModule.getPosition(ticker);
  var liveFlat = !livePos || livePos.stopped;
  var entryResult = { order: null, retryable: false };
  if (liveFlat) entryResult = await tryLiveHalfEntry(ticker, side, half, total, optPrice);
  var cross = null;
  if (ticker === "IWM") {
    await notifyPaperEntry("SPY", side, null, s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, null,
      { channelIds: ["spy0dte"], ignoreWebhookPrice: true });
    cross = await tryIwmCrossEntry(side, s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, s, lockedTickers);
  }
  var retryable = !!(entryResult.retryable || (cross && cross.retryable));
  return {
    order: entryResult.order,
    cross: cross && cross.order,
    paper: true,
    live: !!entryResult.order,
    retryable: retryable,
    error: entryResult.error || (cross && cross.error)
  };
}

function stopLabel(pos) {
  if (pos.crossEntry && pos.stopMode === "orb_low") return "ORB Low (cross-entry)";
  if (pos.crossEntry && pos.stopMode === "orb_high") return "ORB High (cross-entry)";
  return "ORB Midpoint";
}

async function processEvent(payload, ticker, event, lockedTickers) {
  var s        = stateModule.getState();
  var pos      = stateModule.getPosition(ticker);
  var optPrice = payload.option_price ? parseFloat(payload.option_price) : null;
  var close    = payload.close ? parseFloat(payload.close) : null;
  var orbHigh  = payload.orb_high ? parseFloat(payload.orb_high) : null;
  var orbLow   = payload.orb_low  ? parseFloat(payload.orb_low)  : null;

  var TRADE_EVENTS = ["breakout_long", "breakout_short", "stop_long", "stop_short", "expected_move_hit"];
  if (TRADE_EVENTS.indexOf(event) !== -1) {
    await orbUtil.ensureOrbForTicker(ticker);
    if (ticker === "IWM") await orbUtil.ensureOrbForTicker("SPY");
    var levels = await orbLevelsFor(ticker, orbHigh, orbLow);
    orbHigh = levels.high;
    orbLow = levels.low;
  }

  if (event === "orb_set") {
    if (orbHigh && orbLow) {
      stateModule.setORB(ticker, orbHigh, orbLow, "webhook");
      return { ok: true, message: ticker + " ORB set (from TradingView)" };
    }
    stateModule.logEvent("ORB_WARN", ticker + " orb_set without levels — auto-fetching from Yahoo");
    var range = await orbUtil.fetchOpeningRange(ticker);
    if (range && range.high && range.low) {
      stateModule.setORB(ticker, range.high, range.low, "yahoo");
      return { ok: true, message: ticker + " ORB set (Yahoo fallback)" };
    }
    stateModule.logEvent("ORB_SET", ticker + " ORB levels unavailable yet");
    return { ok: true, message: ticker + " ORB set (no levels)" };
  }

  if (event === "stop_long" || event === "stop_short") {
    var wantSide = event === "stop_long" ? "call" : "put";
    var slPaper = "ORB Midpoint";
    var slLive = pos ? stopLabel(pos) : slPaper;
    stateModule.logEvent("STOP_LOSS", ticker + " " + slLive + " stop hit");
    await notify("onStop", [ticker, optPrice || 0, slPaper]);
    if (!pos || pos.stopped || pos.side !== wantSide) {
      return { ok: true, message: ticker + " paper stop sent (no matching live position)" };
    }
    var stopQty = pos.contracts;
    var stopEntry = pos.entryPrice;
    var stopSide = pos.side;
    var liveClosed = await closeLiveOrLog(ticker, stopQty, slLive);
    if (liveClosed) {
      if (optPrice) pnlUtil.logTradePnL(ticker, stopSide, stopEntry, optPrice, stopQty);
      stateModule.closePosition(ticker, slLive);
    }
    return {
      ok: true,
      message: ticker + (wantSide === "call" ? " long" : " short") + " paper stopped" +
        (liveClosed ? " · live closed" : " · live RH close failed (paper unaffected)")
    };
  }

  if (event === "breakout_long") {
    var total = s.contracts[ticker];
    var half  = Math.ceil(total / 2);

    if (pos && !pos.stopped && pos.side === "put") {
      stateModule.logEvent("FLIP", ticker + " breakout long — paper close + live close if possible");
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (await closeLiveOrLog(ticker, pos.contracts, "ORB breakout flip to long")) {
        if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
        stateModule.closePosition(ticker, "flip to long");
        pos = null;
      }
    }

    pos = stateModule.getPosition(ticker);
    if (pos && !pos.stopped && pos.side === "call") {
      await notify("onAdd", [ticker, optPrice || 0]);
      if (pos.halfIn) {
        stateModule.logEvent("RETEST", ticker + " retest add " + pos.totalContracts + "c");
        if (!liveEntryBlocked(ticker, "retest")) {
          try {
            var addOrder = await placeAndFill(ticker, "call", pos.totalContracts);
            stateModule.addSecondHalf(ticker, pos.totalContracts, (addOrder && addOrder.entryPrice) || optPrice || pos.entryPrice);
          } catch (e) {
            stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
            if (isRetryableRhError(e.message)) {
              return { ok: false, retryable: true, message: ticker + " retest RH failed: " + e.message };
            }
          }
        }
        return { ok: true, message: ticker + " paper retest sent" + (pos.halfIn ? " · live add attempted" : "") };
      }
      return { ok: true, message: ticker + " paper signal sent · live already in long" };
    }

    var opened = await notifyPaperAndMaybeLiveEntry(ticker, "call", half, total, optPrice, orbHigh, orbLow, close, s, lockedTickers);
    if (opened.retryable) {
      return { ok: false, retryable: true, message: ticker + " live entry failed: " + (opened.error || "RH error") };
    }
    return { ok: true, entry: opened.order, cross: opened.cross, paper: true, live: opened.live };
  }

  if (event === "breakout_short") {
    var total2 = s.contracts[ticker];
    var half2  = Math.ceil(total2 / 2);

    if (pos && !pos.stopped && pos.side === "call") {
      stateModule.logEvent("FLIP", ticker + " breakout short — paper close + live close if possible");
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (await closeLiveOrLog(ticker, pos.contracts, "ORB breakout flip to short")) {
        if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
        stateModule.closePosition(ticker, "flip to short");
        pos = null;
      }
    }

    pos = stateModule.getPosition(ticker);
    if (pos && !pos.stopped && pos.side === "put") {
      await notify("onAdd", [ticker, optPrice || 0]);
      if (pos.halfIn) {
        stateModule.logEvent("RETEST", ticker + " retest add " + pos.totalContracts + "c");
        if (!liveEntryBlocked(ticker, "retest")) {
          try {
            var addOrder2 = await placeAndFill(ticker, "put", pos.totalContracts);
            stateModule.addSecondHalf(ticker, pos.totalContracts, (addOrder2 && addOrder2.entryPrice) || optPrice || pos.entryPrice);
          } catch (e) {
            stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
            if (isRetryableRhError(e.message)) {
              return { ok: false, retryable: true, message: ticker + " retest RH failed: " + e.message };
            }
          }
        }
        return { ok: true, message: ticker + " paper retest sent" };
      }
      return { ok: true, message: ticker + " paper signal sent · live already in short" };
    }

    var opened2 = await notifyPaperAndMaybeLiveEntry(ticker, "put", half2, total2, optPrice, orbHigh, orbLow, close, s, lockedTickers);
    if (opened2.retryable) {
      return { ok: false, retryable: true, message: ticker + " live entry failed: " + (opened2.error || "RH error") };
    }
    return { ok: true, entry: opened2.order, cross: opened2.cross, paper: true, live: opened2.live };
  }

  if (event === "bar_close") {
    return { ok: true, message: ticker + " bar_close ignored — profit manager handles tiers" };
  }

  if (event === "expected_move_hit") {
    var timeframe = payload.timeframe || "daily";
    await notify("onExpectedMoveExit", [ticker, optPrice || 0, timeframe]);
    if (!pos || pos.stopped) {
      return { ok: true, message: ticker + " paper expected-move sent (no live position)" };
    }
    if ((pos.lastProfitTier || 0) >= 300) {
      return { ok: true, message: ticker + " paper expected-move sent · live already processed" };
    }
    var qty90 = Math.floor(pos.contracts * 0.9);
    if (qty90 < 1) return { ok: true, message: ticker + " paper expected-move sent · live not enough contracts" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move — selling 90% (" + qty90 + "c)");
    var closed = await trayd.closeLiveOrLog(ticker, qty90, timeframe + " expected move 90% exit");
    if (closed) {
      if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, qty90);
      stateModule.reduceContracts(ticker, qty90);
      stateModule.markProfitTier(ticker, 300);
      pos = stateModule.getPosition(ticker);
      if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, timeframe + " expected move 90% exit");
    }
    return {
      ok: true,
      message: ticker + " paper expected-move sent" + (closed ? " · live 90% exit" : " · live RH close failed (paper unaffected)")
    };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
