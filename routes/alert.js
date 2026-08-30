var stateModule = require("../utils/state");
var trayd = require("../utils/trayd");
var orbUtil = require("../utils/orb");
var yahoo = require("../utils/yahoo");
var pnlUtil = require("../utils/pnl");

var discord = null;
try { discord = require("../utils/discord"); } catch (e) { discord = null; }

async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") await discord[fn].apply(null, args);
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

async function notifyEntryAfterFill(ticker, side, order, optPrice, orbHigh, orbLow, close, opts) {
  var und = await underlyingForNotify(ticker, close);
  var useWebhookPrice = !(opts && opts.ignoreWebhookPrice);
  var fillPrice = (order && order.entryPrice > 0) ? order.entryPrice : (useWebhookPrice ? (optPrice || 0) : 0);
  var args = [ticker, side, fillPrice, orbHigh, orbLow, und];
  if (opts) args.push(opts);
  await notify("onEntry", args);
}

async function closeLiveOrLog(ticker, contracts, reason) {
  try {
    var result = await trayd.closePartialPosition({ ticker: ticker, contracts: contracts, reason: reason });
    if (result && result.ok === false) {
      stateModule.logEvent("ORDER_ERROR", ticker + " RH close failed: " + (result.error || "no matching position"));
      return false;
    }
    return true;
  } catch (e) {
    stateModule.logEvent("ORDER_ERROR", ticker + " RH close failed: " + e.message);
    return false;
  }
}

var DEDUP_WINDOW_MS = parseInt(process.env.ORB_DEDUP_MS, 10) || 30000;
var lastSignal = {};
var processing = {};

function recentlySeen(ticker, event) {
  var key = ticker + ":" + event;
  var now = Date.now();
  if (lastSignal[key] && (now - lastSignal[key]) < DEDUP_WINDOW_MS) {
    return (now - lastSignal[key]) || 1;
  }
  lastSignal[key] = now;
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
    var ago = recentlySeen(ticker, event);
    if (ago > 0) {
      stateModule.logEvent("DUP_BLOCKED", ticker + " " + event + " ignored — duplicate " + Math.round(ago / 1000) + "s ago");
      return { ok: true, deduped: true, message: ticker + " " + event + " duplicate ignored (" + Math.round(ago / 1000) + "s)" };
    }
    processing[ticker] = true;
    lockedTickers.push(ticker);
  }

  try {
    return await processEvent(payload, ticker, event, lockedTickers);
  } finally {
    lockedTickers.forEach(function(t) { processing[t] = false; });
  }
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

  if (event === "stop_long") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active long position" };
    if (pos.side !== "call") return { ok: true, message: ticker + " position is not a call" };
    var sl1 = stopLabel(pos);
    stateModule.logEvent("STOP_LOSS", ticker + " " + sl1 + " stop hit — closing long");
    var stopQty1 = pos.contracts;
    var stopEntry1 = pos.entryPrice;
    var stopSide1 = pos.side;
    if (!await closeLiveOrLog(ticker, stopQty1, sl1)) {
      return { ok: true, message: ticker + " stop skipped — RH close failed" };
    }
    await notify("onStop", [ticker, optPrice || 0, sl1]);
    if (optPrice) pnlUtil.logTradePnL(ticker, stopSide1, stopEntry1, optPrice, stopQty1);
    stateModule.closePosition(ticker, sl1);
    return { ok: true, message: ticker + " long stopped" };
  }

  if (event === "stop_short") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active short position" };
    if (pos.side !== "put") return { ok: true, message: ticker + " position is not a put" };
    var sl2 = stopLabel(pos);
    stateModule.logEvent("STOP_LOSS", ticker + " " + sl2 + " stop hit — closing short");
    var stopQty2 = pos.contracts;
    var stopEntry2 = pos.entryPrice;
    var stopSide2 = pos.side;
    if (!await closeLiveOrLog(ticker, stopQty2, sl2)) {
      return { ok: true, message: ticker + " stop skipped — RH close failed" };
    }
    await notify("onStop", [ticker, optPrice || 0, sl2]);
    if (optPrice) pnlUtil.logTradePnL(ticker, stopSide2, stopEntry2, optPrice, stopQty2);
    stateModule.closePosition(ticker, sl2);
    return { ok: true, message: ticker + " short stopped" };
  }

  if (event === "breakout_long") {
    var total = s.contracts[ticker];
    var half  = Math.ceil(total / 2);

    if (pos && !pos.stopped && pos.side === "put") {
      stateModule.logEvent("FLIP", ticker + " breakout long — closing put first");
      var flipQty1 = pos.contracts;
      var flipEntry1 = pos.entryPrice;
      var flipSide1 = pos.side;
      if (!await closeLiveOrLog(ticker, flipQty1, "ORB breakout flip to long")) {
        return { ok: true, message: ticker + " flip aborted — RH close failed" };
      }
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (optPrice) pnlUtil.logTradePnL(ticker, flipSide1, flipEntry1, optPrice, flipQty1);
      stateModule.closePosition(ticker, "flip to long");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " call @ breakout_long half=" + half + "/" + total);
      stateModule.openHalfPosition(ticker, "call", half, optPrice || 0);
      var order;
      try {
        order = await placeAndFill(ticker, "call", half);
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");
        stateModule.logEvent("ORDER_ERROR", ticker + " breakout_long failed: " + e.message);
      }
      await notifyEntryAfterFill(ticker, "call", order, optPrice, orbHigh, orbLow, close);

      var cross = null;
      var spyPos = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos || spyPos.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "cross_long");
        var spyHalf = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM long → SPY call half=" + spyHalf + " stop=SPY ORB low");
        stateModule.openHalfPosition("SPY", "call", spyHalf, optPrice || 0, { crossEntry: true, stopMode: "orb_low" });
        try {
          cross = await placeAndFill("SPY", "call", spyHalf);
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
        await notifyEntryAfterFill("SPY", "call", cross, null,
          s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, null,
          { channelIds: ["spy0dte"], ignoreWebhookPrice: true });
      }
      return { ok: true, entry: order || null, cross: cross, paper: !order };
    }

    if (pos.halfIn && !pos.stopped) {
      var addQty = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty + "c");
      try {
        await placeAndFill(ticker, "call", addQty);
        stateModule.addSecondHalf(ticker, addQty, optPrice || pos.entryPrice);
      } catch (e) {
        stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
      }
      await notify("onAdd", [ticker, optPrice || 0]);
      return { ok: true, message: ticker + " second half added on retest" };
    }

    return { ok: true, message: ticker + " already in long position" };
  }

  if (event === "breakout_short") {
    var total2 = s.contracts[ticker];
    var half2  = Math.ceil(total2 / 2);

    if (pos && !pos.stopped && pos.side === "call") {
      stateModule.logEvent("FLIP", ticker + " breakout short — closing call first");
      var flipQty2 = pos.contracts;
      var flipEntry2 = pos.entryPrice;
      var flipSide2 = pos.side;
      if (!await closeLiveOrLog(ticker, flipQty2, "ORB breakout flip to short")) {
        return { ok: true, message: ticker + " flip aborted — RH close failed" };
      }
      await notify("onFullClose", [ticker, optPrice || 0]);
      if (optPrice) pnlUtil.logTradePnL(ticker, flipSide2, flipEntry2, optPrice, flipQty2);
      stateModule.closePosition(ticker, "flip to short");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " put @ breakout_short half=" + half2 + "/" + total2);
      stateModule.openHalfPosition(ticker, "put", half2, optPrice || 0);
      var order2;
      try {
        order2 = await placeAndFill(ticker, "put", half2);
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");
        stateModule.logEvent("ORDER_ERROR", ticker + " breakout_short failed: " + e.message);
      }
      await notifyEntryAfterFill(ticker, "put", order2, optPrice, orbHigh, orbLow, close);

      var cross2 = null;
      var spyPos2 = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos2 || spyPos2.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "cross_short");
        var spyHalf2 = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM short → SPY put half=" + spyHalf2 + " stop=SPY ORB high");
        stateModule.openHalfPosition("SPY", "put", spyHalf2, optPrice || 0, { crossEntry: true, stopMode: "orb_high" });
        try {
          cross2 = await placeAndFill("SPY", "put", spyHalf2);
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
        await notifyEntryAfterFill("SPY", "put", cross2, null,
          s.orb.SPY.high || orbHigh || 0, s.orb.SPY.low || orbLow || 0, null,
          { channelIds: ["spy0dte"], ignoreWebhookPrice: true });
      }
      return { ok: true, entry: order2 || null, cross: cross2, paper: !order2 };
    }

    if (pos.halfIn && !pos.stopped) {
      var addQty2 = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty2 + "c");
      try {
        await placeAndFill(ticker, "put", addQty2);
        stateModule.addSecondHalf(ticker, addQty2, optPrice || pos.entryPrice);
      } catch (e) {
        stateModule.logEvent("RETEST_ERROR", ticker + " retest order failed: " + e.message);
      }
      await notify("onAdd", [ticker, optPrice || 0]);
      return { ok: true, message: ticker + " second half added on retest" };
    }

    return { ok: true, message: ticker + " already in short position" };
  }

  if (event === "bar_close") {
    return { ok: true, message: ticker + " bar_close ignored — profit manager handles tiers" };
  }

  if (event === "expected_move_hit") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active position" };
    if ((pos.lastProfitTier || 0) >= 300) {
      return { ok: true, message: ticker + " expected move exit already processed" };
    }
    var timeframe = payload.timeframe || "daily";
    var qty90 = Math.floor(pos.contracts * 0.9);
    if (qty90 < 1) return { ok: true, message: ticker + " not enough contracts" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move — selling 90% (" + qty90 + "c)");
    var closed = await trayd.closePartialPosition({ ticker: ticker, contracts: qty90, reason: timeframe + " expected move 90% exit" });
    if (closed && closed.ok === false) {
      stateModule.logEvent("ORDER_ERROR", ticker + " expected move close failed: " + (closed.error || "no RH position"));
      return { ok: true, message: ticker + " expected move RH close skipped" };
    }
    if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, qty90);
    stateModule.reduceContracts(ticker, qty90);
    stateModule.markProfitTier(ticker, 300);
    pos = stateModule.getPosition(ticker);
    if (!pos || pos.contracts <= 0) stateModule.closePosition(ticker, timeframe + " expected move 90% exit");
    return { ok: true, message: ticker + " 90% exit on expected move" };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
