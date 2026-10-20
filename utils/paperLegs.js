// utils/paperLegs.js — dual-leg paper sizing, strikes, expected-move touch detection.

var expectedMoveUtil = require("./expectedMove");

var MOVE_HOT_ZONE_PCT = 0.0025;
var MONITOR_INTERVAL_MS = 15000;
var MARK_INTERVAL_MS = 10000;
var ONE_DTE_EXIT_FRAC = 0.75;
var ZERO_DTE_EXIT_FRAC = 1.0;

// Sizing rule (Oct 2026): never more than 10% of the account in options at once.
//   0DTE ATM leg = 4% · 1DTE expected-move leg = 4% · one-time retest add (0DTE leg) = 2%.
var LEG_PCT_0DTE = 4;
var LEG_PCT_1DTE = 4;
var RETEST_ADD_PCT = 2;
var MAX_EXPOSURE_PCT = 10;

function legKey(tradeTicker, dteTag) {
  return tradeTicker + ":" + dteTag;
}

function parseLegKey(key) {
  var parts = (key || "").split(":");
  return { tradeTicker: parts[0], dteTag: parseInt(parts[1], 10) || 0 };
}

function listLegsForTrade(positions, tradeTicker) {
  return Object.keys(positions || {}).filter(function(k) {
    var parsed = parseLegKey(k);
    return parsed.tradeTicker === tradeTicker && positions[k] && positions[k].contracts > 0;
  });
}

function legPctForDte(dteTag) {
  return dteTag === 0 ? LEG_PCT_0DTE : LEG_PCT_1DTE;
}

// Dollars still committed to one open leg: remaining contracts at their cost per contract.
// costBasis/totalContracts covers a retest add at a different price; falls back to entryPrice.
function legExposureDollars(pos) {
  if (!pos || !(pos.contracts > 0)) return 0;
  var perContract = (pos.costBasis > 0 && pos.totalContracts > 0)
    ? pos.costBasis / pos.totalContracts
    : (pos.entryPrice || 0) * 100;
  return pos.contracts * perContract;
}

// Total open options exposure for one account (all open legs, every ticker).
function openExposureDollars(positions) {
  return Object.keys(positions || {}).reduce(function(sum, k) {
    return sum + legExposureDollars(positions[k]);
  }, 0);
}

// Hard cap per account: 10% of balance (and never above maxRiskDollars when set, e.g. SPX $10k).
function exposureCapDollars(balance, maxRiskDollars) {
  if (!balance || balance <= 0) return 0;
  var cap = balance * (MAX_EXPOSURE_PCT / 100);
  if (maxRiskDollars != null && maxRiskDollars > 0) cap = Math.min(cap, maxRiskDollars);
  return cap;
}

// contracts = floor(pct × balance ÷ (premium × 100)), limited so open exposure stays ≤ the cap.
// Returns 0 when that is under 1 contract (caller skips the leg).
function sizeLegContracts(balance, legPct, premium, openExposure, maxRiskDollars) {
  if (!premium || premium <= 0 || !balance || balance <= 0 || !legPct || legPct <= 0) return 0;
  var budget = balance * (legPct / 100);
  var room = exposureCapDollars(balance, maxRiskDollars) - (openExposure || 0);
  if (room <= 0) return 0;
  if (room < budget) budget = room;
  var n = Math.floor(budget / (premium * 100));
  return n >= 1 ? n : 0;
}

function roundStrike(ticker, price) {
  if (!price || price <= 0) return null;
  if (ticker === "SPXW" || ticker === "SPX") return Math.round(price / 5) * 5;
  return Math.round(price);
}

function strikeForLegTicker(ticker, side, dteTag, atmPrice, moveTargets) {
  if (dteTag === 0) return roundStrike(ticker, atmPrice);
  if (!moveTargets) return roundStrike(ticker, atmPrice);
  if (side === "call") return roundStrike(ticker, moveTargets.upper);
  return roundStrike(ticker, moveTargets.lower);
}

function getEntryMoveTargets(tradeTicker) {
  return expectedMoveUtil.computeTickerMoves(tradeTicker).then(function(moves) {
    if (!moves) return null;
    var session = moves.sessions && moves.sessions[0];
    if (!session) return null;
    return {
      upper: session.upper,
      lower: session.lower,
      moveDollars: session.moveDollars,
      movePct: session.movePct
    };
  });
}

function distToTargetPct(price, target, side) {
  if (!price || !target) return 1;
  if (side === "call") return Math.abs(price - target) / target;
  return Math.abs(price - target) / target;
}

function isNearMoveTarget(pos, livePrice) {
  if (!pos || pos.moveExitDone) return false;
  if (pos.side === "call" && pos.targetUpper) {
    return distToTargetPct(livePrice, pos.targetUpper, "call") <= MOVE_HOT_ZONE_PCT;
  }
  if (pos.side === "put" && pos.targetLower) {
    return distToTargetPct(livePrice, pos.targetLower, "put") <= MOVE_HOT_ZONE_PCT;
  }
  return false;
}

function checkMoveTouch(pos, snap) {
  if (!pos || pos.moveExitDone || !snap) return null;
  var price = snap.price;
  var high = snap.high != null ? snap.high : price;
  var low = snap.low != null ? snap.low : price;
  if (pos.side === "call" && pos.targetUpper) {
    if (price >= pos.targetUpper || high >= pos.targetUpper) return "upper";
  }
  if (pos.side === "put" && pos.targetLower) {
    if (price <= pos.targetLower || low <= pos.targetLower) return "lower";
  }
  return null;
}

function exitFractionForLeg(dteTag) {
  return dteTag === 0 ? ZERO_DTE_EXIT_FRAC : ONE_DTE_EXIT_FRAC;
}

function sellQtyForLeg(pos, fraction) {
  if (!pos || pos.contracts <= 0) return 0;
  if (fraction >= 1) return pos.contracts;
  return Math.max(1, Math.floor(pos.contracts * fraction));
}

// ── held-leg expiry helpers ─────────────────────────────────────────────────
// A held leg is priced only on its own expiry. Never roll it to another date.
// expired: expiry before today ET, or expiry today once 4:00 PM ET has passed.
function isExpiredLeg(pos, todayYmd, afterCloseToday) {
  if (!pos || !pos.expiry || !todayYmd) return false;
  if (pos.expiry < todayYmd) return true;
  return pos.expiry === todayYmd && !!afterCloseToday;
}

// Settlement value per contract share: intrinsic at the closing underlying, else 0.
function settlementPrice(side, strike, close) {
  var k = parseFloat(strike), c = parseFloat(close);
  if (!isFinite(k) || !isFinite(c) || c <= 0) return 0;
  var v = side === "call" ? c - k : k - c;
  return v > 0 ? v : 0;
}

// 3:45 PM ET sell: legs expiring today close 100%; other legs keep the normal fraction.
function eodSellQty(pos, todayYmd, frac) {
  if (!pos || !(pos.contracts > 0)) return 0;
  if (pos.expiry && pos.expiry === todayYmd) return pos.contracts;
  return Math.max(1, Math.floor(pos.contracts * frac));
}

module.exports = {
  isExpiredLeg: isExpiredLeg,
  settlementPrice: settlementPrice,
  eodSellQty: eodSellQty,
  legKey: legKey,
  parseLegKey: parseLegKey,
  listLegsForTrade: listLegsForTrade,
  sizeLegContracts: sizeLegContracts,
  legPctForDte: legPctForDte,
  legExposureDollars: legExposureDollars,
  openExposureDollars: openExposureDollars,
  exposureCapDollars: exposureCapDollars,
  LEG_PCT_0DTE: LEG_PCT_0DTE,
  LEG_PCT_1DTE: LEG_PCT_1DTE,
  RETEST_ADD_PCT: RETEST_ADD_PCT,
  MAX_EXPOSURE_PCT: MAX_EXPOSURE_PCT,
  roundStrike: roundStrike,
  strikeForLegTicker: strikeForLegTicker,
  getEntryMoveTargets: getEntryMoveTargets,
  isNearMoveTarget: isNearMoveTarget,
  checkMoveTouch: checkMoveTouch,
  exitFractionForLeg: exitFractionForLeg,
  sellQtyForLeg: sellQtyForLeg,
  MOVE_HOT_ZONE_PCT: MOVE_HOT_ZONE_PCT,
  MONITOR_INTERVAL_MS: MONITOR_INTERVAL_MS,
  MARK_INTERVAL_MS: MARK_INTERVAL_MS,
  ONE_DTE_EXIT_FRAC: ONE_DTE_EXIT_FRAC
};
