// Full-port sizing: spend available buying power on ATM option contracts.

var yahoo = require("./yahoo");
var expiryUtil = require("./expiry");
var settings = require("./settings");

var MAX_CONTRACTS = 100;

function contractsFromBuyingPower(buyingPower, premium, opts) {
  opts = opts || {};
  var bp = parseFloat(buyingPower);
  var prem = parseFloat(premium);
  if (!(bp > 0) || !(prem > 0)) return 0;
  // One contract costs premium * 100. Dual-leg full size holds ~2 expiries.
  var costPerUnit = prem * 100;
  if (opts.dualLeg) costPerUnit *= 2;
  var n = Math.floor(bp / costPerUnit);
  if (n < 1) return 0;
  return Math.min(MAX_CONTRACTS, n);
}

async function estimateAtmPremium(ticker) {
  var t = String(ticker || "").toUpperCase();
  var quoteTicker = t === "SPX" || t === "SPXW" ? "SPX" : t;
  var dte = expiryUtil.getDTE(t === "SPX" ? "SPY" : t);
  var expiry = expiryUtil.getExpiryForDTE(dte);
  var straddle = await yahoo.getATMStraddle(quoteTicker, expiry);
  if (straddle && straddle.callPrice > 0) {
    return {
      premium: straddle.callPrice,
      putPremium: straddle.putPrice || null,
      strike: straddle.strike,
      expiry: straddle.expiry || expiry,
      underlying: straddle.price || null
    };
  }
  // Fallback: try 0DTE chain if configured expiry has no quotes yet.
  if (dte !== 0) {
    var exp0 = expiryUtil.getExpiryForDTE(0);
    var s0 = await yahoo.getATMStraddle(quoteTicker, exp0);
    if (s0 && s0.callPrice > 0) {
      return {
        premium: s0.callPrice,
        putPremium: s0.putPrice || null,
        strike: s0.strike,
        expiry: s0.expiry || exp0,
        underlying: s0.price || null
      };
    }
  }
  return null;
}

async function computeFullPort(ticker, buyingPower, opts) {
  opts = opts || {};
  var t = String(ticker || "").toUpperCase();
  if (t !== "SPY" && t !== "IWM" && t !== "SPX") {
    return { ok: false, error: "full-port supports SPY, IWM, or SPX" };
  }
  var bp = parseFloat(buyingPower);
  if (!(bp > 0)) return { ok: false, error: "buying power unavailable" };

  var dualLeg = opts.dualLeg != null ? !!opts.dualLeg : settings.isDualLegLive();
  var est = await estimateAtmPremium(t === "SPX" ? "SPY" : t);
  // SPX premium ≈ SPY * ~10 for index vs ETF; if sizing SPX directly, fetch SPX.
  if (t === "SPX") {
    var spxEst = await estimateAtmPremium("SPX");
    if (spxEst && spxEst.premium > 0) est = spxEst;
  }
  if (!est || !(est.premium > 0)) {
    return { ok: false, error: "could not estimate ATM option premium for " + t };
  }

  var contracts = contractsFromBuyingPower(bp, est.premium, { dualLeg: dualLeg });
  if (contracts < 1) {
    return {
      ok: false,
      error: "buying power too low for 1 contract @ ~$" + est.premium.toFixed(2),
      premium: est.premium,
      buyingPower: bp
    };
  }

  var costPer = est.premium * 100 * (dualLeg ? 2 : 1);
  return {
    ok: true,
    ticker: t,
    contracts: contracts,
    premium: est.premium,
    strike: est.strike,
    expiry: est.expiry,
    underlying: est.underlying,
    buyingPower: bp,
    dualLeg: dualLeg,
    estimatedCost: parseFloat((contracts * costPer).toFixed(2)),
    note: dualLeg
      ? "Sized for dual-leg (0DTE+1DTE) full position"
      : "Sized for single-leg full position"
  };
}

module.exports = {
  MAX_CONTRACTS: MAX_CONTRACTS,
  contractsFromBuyingPower: contractsFromBuyingPower,
  estimateAtmPremium: estimateAtmPremium,
  computeFullPort: computeFullPort
};
