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

  if (event === "orb_set") {
    if (orbHigh && orbLow) {
      stateModule.setORB(ticker, orbHigh, orbLow, "webhook");
      return { ok: true, message: ticker + " ORB set (from TradingView)" };
    }
    stateModule.logEvent("ORB_WARN", ticker + " orb_set received without orb_high/orb_low — add levels to TradingView JSON; using Yahoo fallback");
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
    await notify("onStop", [ticker, optPrice || 0, sl1]);
    await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: sl1 });
    if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
    stateModule.closePosition(ticker, sl1);
    return { ok: true, message: ticker + " long stopped" };
  }

  if (event === "stop_short") {
    if (!pos || pos.stopped) return { ok: true, message: ticker + " no active short position" };
    if (pos.side !== "put") return { ok: true, message: ticker + " position is not a put" };
    var sl2 = stopLabel(pos);
    stateModule.logEvent("STOP_LOSS", ticker + " " + sl2 + " stop hit — closing short");
    await notify("onStop", [ticker, optPrice || 0, sl2]);
    await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: sl2 });
    if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
    stateModule.closePosition(ticker, sl2);
    return { ok: true, message: ticker + " short stopped" };
  }

  if (event === "breakout_long") {
    var total = s.contracts[ticker];
    var half  = Math.ceil(total / 2);

    if (pos && !pos.stopped && pos.side === "put") {
      stateModule.logEvent("FLIP", ticker + " breakout long — closing put first");
      await notify("onFullClose", [ticker, optPrice || 0]);
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to long" });
      if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to long");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " call @ breakout_long half=" + half + "/" + total);
      stateModule.openHalfPosition(ticker, "call", half, optPrice || close || 0);
      var und = await underlyingForNotify(ticker, close);
      await notify("onEntry", [ticker, "call", optPrice || 0, s.orb[ticker].high || orbHigh || 0, s.orb[ticker].low || orbLow || 0, und]);
      var order;
      try {
        order = await trayd.placeOrder({ ticker: ticker, side: "call", contracts: half });
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");
        throw e;
      }

      var cross = null;
      var spyPos = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos || spyPos.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "breakout_long");
        var spyHalf = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM long → SPY call half=" + spyHalf + " stop=SPY ORB low");
        stateModule.openHalfPosition("SPY", "call", spyHalf, optPrice || close || 0, { crossEntry: true, stopMode: "orb_low" });
        var spyUnd = await underlyingForNotify("SPY", null);
        await notify("onEntry", ["SPY", "call", 0, s.orb.SPY.high || 0, s.orb.SPY.low || 0, spyUnd]);
        try {
          cross = await trayd.placeOrder({ ticker: "SPY", side: "call", contracts: spyHalf });
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
      }
      return { ok: true, entry: order, cross: cross };
    }

    if (pos.halfIn && !pos.stopped) {
      var addQty = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty + "c");
      stateModule.addSecondHalf(ticker, addQty, optPrice || close || pos.entryPrice);
      try {
        await trayd.placeOrder({ ticker: ticker, side: "call", contracts: addQty });
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
      await notify("onFullClose", [ticker, optPrice || 0]);
      await trayd.closePartialPosition({ ticker: ticker, contracts: pos.contracts, reason: "ORB breakout flip to short" });
      if (optPrice) pnlUtil.logTradePnL(ticker, pos.side, pos.entryPrice, optPrice, pos.contracts);
      stateModule.closePosition(ticker, "flip to short");
      pos = null;
    }

    if (!pos || pos.stopped) {
      stateModule.logEvent("ENTRY", ticker + " put @ breakout_short half=" + half2 + "/" + total2);
      stateModule.openHalfPosition(ticker, "put", half2, optPrice || close || 0);
      var und2 = await underlyingForNotify(ticker, close);
      await notify("onEntry", [ticker, "put", optPrice || 0, s.orb[ticker].high || orbHigh || 0, s.orb[ticker].low || orbLow || 0, und2]);
      var order2;
      try {
        order2 = await trayd.placeOrder({ ticker: ticker, side: "put", contracts: half2 });
      } catch (e) {
        stateModule.closePosition(ticker, "entry order failed");
        throw e;
      }

      var cross2 = null;
      var spyPos2 = stateModule.getPosition("SPY");
      if (ticker === "IWM" && (!spyPos2 || spyPos2.stopped) && s.orb.SPY.set && !processing["SPY"]) {
        processing["SPY"] = true; lockedTickers.push("SPY");
        recentlySeen("SPY", "breakout_short");
        var spyHalf2 = Math.ceil(s.contracts.SPY / 2);
        stateModule.logEvent("CROSS_ENTRY", "IWM short → SPY put half=" + spyHalf2 + " stop=SPY ORB high");
        stateModule.openHalfPosition("SPY", "put", spyHalf2, optPrice || close || 0, { crossEntry: true, stopMode: "orb_high" });
        var spyUnd2 = await underlyingForNotify("SPY", null);
        await notify("onEntry", ["SPY", "put", 0, s.orb.SPY.high || 0, s.orb.SPY.low || 0, spyUnd2]);
        try {
          cross2 = await trayd.placeOrder({ ticker: "SPY", side: "put", contracts: spyHalf2 });
        } catch (e) {
          stateModule.closePosition("SPY", "cross entry failed");
          stateModule.logEvent("CROSS_ERROR", "SPY cross entry failed: " + e.message);
        }
      }
      return { ok: true, entry: order2, cross: cross2 };
    }

    if (pos.halfIn && !pos.stopped) {
      var addQty2 = pos.totalContracts;
      stateModule.logEvent("RETEST", ticker + " retest add " + addQty2 + "c");
      stateModule.addSecondHalf(ticker, addQty2, optPrice || close || pos.entryPrice);
      try {
        await trayd.placeOrder({ ticker: ticker, side: "put", contracts: addQty2 });
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
    var timeframe = payload.timeframe || "daily";
    var qty90 = Math.floor(pos.contracts * 0.9);
    if (qty90 < 1) return { ok: true, message: ticker + " not enough contracts" };
    stateModule.logEvent("PROFIT_TIER_3", ticker + " " + timeframe + " expected move — selling 90% (" + qty90 + "c)");
    await trayd.closePartialPosition({ ticker: ticker, contracts: qty90, reason: timeframe + " expected move 90% exit" });
    stateModule.markProfitTier(ticker, 300);
    return { ok: true, message: ticker + " 90% exit on expected move" };
  }

  throw new Error("Unknown event: " + event);
}

module.exports = { handleAlert: handleAlert };
