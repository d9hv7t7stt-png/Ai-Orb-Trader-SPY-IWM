// utils/yahoo.js
// Unauthenticated underlying quotes for SPY, IWM, etc.

var https = require("https");

var SYMBOLS = { SPY: "SPY", IWM: "IWM", QQQ: "QQQ", SPX: "^GSPC" };
var _session = null; // { cookie, crumb, ts }

function httpGet(hostname, path, headers) {
  return new Promise(function(resolve) {
    var req = https.request({ hostname: hostname, path: path, headers: headers }, function(r) {
      var raw = "";
      r.on("data", function(c) { raw += c; });
      r.on("end", function() { resolve({ status: r.statusCode, headers: r.headers, body: raw }); });
    });
    req.on("error", function() { resolve({ status: 0, body: "" }); });
    req.setTimeout(8000, function() { req.destroy(); resolve({ status: 0, body: "" }); });
    req.end();
  });
}

function getYahooSession(force) {
  if (!force && _session && (Date.now() - _session.ts) < 30 * 60 * 1000) {
    return Promise.resolve(_session);
  }
  return httpGet("fc.yahoo.com", "/", { "User-Agent": "Mozilla/5.0", Accept: "text/html" }).then(function(fc) {
    var setCookie = fc.headers["set-cookie"] || [];
    var cookie = setCookie.map(function(c) { return c.split(";")[0]; }).join("; ");
    return httpGet("query1.finance.yahoo.com", "/v1/test/getcrumb", {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/plain",
      Cookie: cookie
    }).then(function(cr) {
      var crumb = (cr.body || "").trim();
      if (!crumb) return null;
      _session = { cookie: cookie, crumb: crumb, ts: Date.now() };
      return _session;
    });
  });
}

function fetchOptionsChain(ticker, dateUnix, retry) {
  var symbol = SYMBOLS[ticker] || ticker;
  return getYahooSession(false).then(function(session) {
    if (!session) return null;
    var path = "/v7/finance/options/" + encodeURIComponent(symbol) + "?crumb=" + encodeURIComponent(session.crumb);
    if (dateUnix) path += "&date=" + dateUnix;
    return httpGet("query1.finance.yahoo.com", path, {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0",
      Cookie: session.cookie
    }).then(function(res) {
      if (res.status === 401 && !retry) {
        _session = null;
        return fetchOptionsChain(ticker, dateUnix, true);
      }
      try { return JSON.parse(res.body); } catch (e) { return null; }
    });
  });
}

function getUnderlyingPrice(ticker) {
  return getQuoteSnapshot(ticker).then(function(s) { return s ? s.price : null; });
}

function getQuoteSnapshot(ticker) {
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
          if (!meta) return resolve(null);
          var price = parseFloat(meta.regularMarketPrice || meta.previousClose || 0) || null;
          var prev = parseFloat(meta.chartPreviousClose || meta.previousClose || price) || price;
          if (!price) return resolve(null);
          resolve({ price: price, prev_close: prev });
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

function unixToYmd(unix) {
  return new Date(unix * 1000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function pickOptionPrice(opt) {
  if (!opt) return null;
  if (opt.lastPrice && opt.lastPrice > 0) return parseFloat(opt.lastPrice);
  var bid = parseFloat(opt.bid);
  var ask = parseFloat(opt.ask);
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return null;
}

// ATM/near-strike option mark when Robinhood is unavailable (Discord paper feed).
function getOptionMark(ticker, side, strike, expiryYmd) {
  var wantStrike = Math.round(parseFloat(strike));
  if (!wantStrike || wantStrike <= 0) return Promise.resolve(null);
  var optionType = side === "call" ? "calls" : "puts";

  return fetchOptionsChain(ticker, null).then(function(data) {
    try {
      var result = data && data.optionChain && data.optionChain.result && data.optionChain.result[0];
      if (!result || !result.options || !result.options.length) return null;

      var expDates = result.expirationDates || [];
      var targetUnix = null;
      if (expiryYmd) {
        for (var i = 0; i < expDates.length; i++) {
          if (unixToYmd(expDates[i]) === expiryYmd) { targetUnix = expDates[i]; break; }
        }
      }
      if (!targetUnix) targetUnix = expDates[0];

      var chain = result.options[0];
      if (targetUnix && chain.expirationDate !== targetUnix && expDates.length > 1) {
        return fetchOptionsChain(ticker, targetUnix).then(function(data2) {
          var r2 = data2 && data2.optionChain && data2.optionChain.result && data2.optionChain.result[0];
          return parseOptionMark(r2, optionType, wantStrike, expiryYmd);
        });
      }
      return parseOptionMark(result, optionType, wantStrike, expiryYmd);
    } catch (e) { return null; }
  });
}

function parseOptionMark(result, optionType, wantStrike, expiryYmd) {
  if (!result || !result.options || !result.options.length) return null;
  var bucket = result.options[0];
  var list = bucket[optionType] || [];
  if (!list.length) return null;

  var best = null;
  var bestDiff = Infinity;
  for (var j = 0; j < list.length; j++) {
    var diff = Math.abs(list[j].strike - wantStrike);
    if (diff < bestDiff) { bestDiff = diff; best = list[j]; }
  }
  if (!best) return null;
  var price = pickOptionPrice(best);
  if (!price || price <= 0) return null;
  var expiry = expiryYmd || unixToYmd(bucket.expirationDate);
  return { price: price, strike: best.strike, expiry: expiry, instrument: null, source: "yahoo" };
}

module.exports = {
  getUnderlyingPrice: getUnderlyingPrice,
  getQuoteSnapshot: getQuoteSnapshot,
  getChart: getChart,
  getOptionMark: getOptionMark,
  SYMBOLS: SYMBOLS
};
