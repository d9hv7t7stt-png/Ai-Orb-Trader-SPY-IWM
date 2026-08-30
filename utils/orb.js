// utils/orb.js
// Server-side Opening Range capture (15-min bar, 9:30–9:44 ET per strategy spec).
// Yahoo fallback when orb_set webhook omits orb_high/orb_low.

var yahoo = require("./yahoo");
var stateModule = require("./state");

var ORB_INTERVAL = process.env.ORB_INTERVAL || "15m";

function etDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function fetchOpeningRange(ticker) {
  return yahoo.getChart(ticker, ORB_INTERVAL, "1d").then(function(parsed) {
    try {
      if (!parsed) return null;
      var result = parsed.chart && parsed.chart.result && parsed.chart.result[0];
      if (!result) return null;
      var ts = result.timestamp || [];
      var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
      if (!q) return null;
      var regStart = result.meta && result.meta.currentTradingPeriod &&
                     result.meta.currentTradingPeriod.regular &&
                     result.meta.currentTradingPeriod.regular.start;
      for (var i = 0; i < ts.length; i++) {
        if (regStart && ts[i] < regStart) continue;
        if (q.high[i] != null && q.low[i] != null) {
          return { high: q.high[i], low: q.low[i] };
        }
      }
      return null;
    } catch (e) { return null; }
  });
}

async function populateTicker(ticker, force) {
  var s = stateModule.getState();
  var today = etDate();
  var orb = s.orb && s.orb[ticker];
  if (!force && orb && orb.set && orb.date === today) {
    return { ticker: ticker, set: true, skipped: true };
  }
  var range = await fetchOpeningRange(ticker);
  if (range && range.high && range.low) {
    stateModule.setORB(ticker, range.high, range.low, "yahoo");
    return { ticker: ticker, set: true, high: range.high, low: range.low, source: "yahoo" };
  }
  return { ticker: ticker, set: false, reason: "opening-range data not available yet" };
}

async function populateIfNeeded(force) {
  return [await populateTicker("SPY", force), await populateTicker("IWM", force)];
}

function scheduleORBCapture() {
  stateModule.logEvent("ORB", "Opening-range auto-capture started (" + ORB_INTERVAL + " Yahoo fallback)");
  function run() {
    populateIfNeeded(false).then(function(results) {
      results.forEach(function(r) {
        if (r.set && !r.skipped) {
          stateModule.logEvent("ORB", r.ticker + " ORB captured via Yahoo High=" + r.high + " Low=" + r.low);
        }
      });
    }).catch(function(e) {
      stateModule.logEvent("ORB_ERROR", "Capture poll failed: " + e.message);
    }).finally(function() {
      setTimeout(run, 120000);
    });
  }
  setTimeout(run, 10000);
}

async function ensureOrbForTicker(ticker) {
  var s = stateModule.getState();
  var today = etDate();
  var orb = s.orb && s.orb[ticker];
  if (orb && orb.set && orb.high && orb.low && orb.date === today) {
    return { high: orb.high, low: orb.low, source: orb.source || "cached" };
  }
  var result = await populateTicker(ticker, false);
  s = stateModule.getState();
  orb = s.orb && s.orb[ticker];
  if (result.set && orb && orb.high && orb.low) {
    return { high: orb.high, low: orb.low, source: result.source || orb.source || "yahoo" };
  }
  return null;
}

module.exports = {
  fetchOpeningRange: fetchOpeningRange,
  populateIfNeeded: populateIfNeeded,
  scheduleORBCapture: scheduleORBCapture,
  ensureOrbForTicker: ensureOrbForTicker
};
