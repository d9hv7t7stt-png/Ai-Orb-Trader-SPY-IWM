// utils/expectedMove.js
// Expected move from ATM straddle (call + put) for the next trading session.
// Standard options-market implied move: ±straddle from current price.

var yahoo = require("./yahoo");
var marketCal = require("./marketCalendar");
var expiryUtil = require("./expiry");

function sessionLabel(date) {
  var d = date;
  if (typeof date === "string") d = new Date(date + "T12:00:00");
  if (!d) d = marketCal.nextTradingDayAfter(new Date());
  var ymd = marketCal.ymdInET(d);
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(d);
  return weekday + ", " + expiryUtil.formatExpiryLabel(ymd);
}

function computeExpectedMove(ticker, expiryYmd) {
  return yahoo.getATMStraddle(ticker, expiryYmd).then(function(data) {
    if (!data) return null;
    return {
      ticker: ticker,
      sessionDate: data.expiry,
      sessionLabel: sessionLabel(data.expiry),
      price: data.price,
      strike: data.strike,
      expiry: data.expiry,
      callPrice: data.callPrice,
      putPrice: data.putPrice,
      moveDollars: data.moveDollars,
      movePct: data.movePct,
      upper: data.upper,
      lower: data.lower
    };
  });
}

function computeNextSessionMoves(tickers) {
  var sessionDate = marketCal.nextTradingDayAfter(new Date());
  var expiryYmd = marketCal.ymdInET(sessionDate);
  var label = sessionLabel(sessionDate);
  var list = tickers || ["SPY", "IWM"];
  var unique = [];
  list.forEach(function(t) {
    if (unique.indexOf(t) === -1) unique.push(t);
  });

  return Promise.all(unique.map(function(ticker) {
    return computeExpectedMove(ticker, expiryYmd);
  })).then(function(results) {
    return {
      sessionDate: expiryYmd,
      sessionLabel: label,
      tickers: results.filter(function(r) { return !!r; }),
      computedAt: new Date().toISOString()
    };
  });
}

module.exports = {
  computeExpectedMove: computeExpectedMove,
  computeNextSessionMoves: computeNextSessionMoves,
  sessionLabel: sessionLabel
};
