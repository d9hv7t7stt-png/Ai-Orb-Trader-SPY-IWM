// utils/yahoo.js
// Unauthenticated underlying quotes for SPY, IWM, etc.

var https = require("https");

var SYMBOLS = { SPY: "SPY", IWM: "IWM", QQQ: "QQQ", SPX: "^GSPC" };

function getUnderlyingPrice(ticker) {
  var symbol = SYMBOLS[ticker] || ticker;
  return new Promise(function(resolve) {
    var options = {
      hostname: "query1.finance.yahoo.com",
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=1d&range=1d",
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    };
    var req = https.request(options, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() {
        try {
          var parsed = JSON.parse(raw);
          var meta = parsed.chart && parsed.chart.result && parsed.chart.result[0] && parsed.chart.result[0].meta;
          var price = meta ? (meta.regularMarketPrice || meta.previousClose || null) : null;
          resolve(price ? parseFloat(price) : null);
        } catch (e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.setTimeout(8000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

function getChart(ticker, interval, range) {
  var symbol = SYMBOLS[ticker] || ticker;
  return new Promise(function(resolve) {
    var options = {
      hostname: "query1.finance.yahoo.com",
      path: "/v8/finance/chart/" + encodeURIComponent(symbol) + "?interval=" + interval + "&range=" + range,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" }
    };
    var req = https.request(options, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() {
        try { resolve(JSON.parse(raw)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", function() { resolve(null); });
    req.setTimeout(8000, function() { req.destroy(); resolve(null); });
    req.end();
  });
}

module.exports = { getUnderlyingPrice: getUnderlyingPrice, getChart: getChart, SYMBOLS: SYMBOLS };
