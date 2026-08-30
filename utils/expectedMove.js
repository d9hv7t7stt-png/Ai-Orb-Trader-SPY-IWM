// utils/expectedMove.js
// Multi-timeframe expected moves from ATM straddles (call + put mid).
// Implied move = straddle price; range = current underlying ± straddle.

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

function shortLabel(ymd) {
  var d = new Date(ymd + "T12:00:00");
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  return weekday + " " + expiryUtil.formatExpiryLabel(ymd);
}

function daysBetweenYmd(fromYmd, toYmd) {
  return Math.round((new Date(toYmd + "T12:00:00").getTime() - new Date(fromYmd + "T12:00:00").getTime()) / 86400000);
}

function unique(list) {
  var out = [];
  list.forEach(function(v) { if (v && out.indexOf(v) === -1) out.push(v); });
  return out;
}

function pickNearestExpiry(expiries, afterYmd, targetDays, minDays, exclude) {
  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < expiries.length; i++) {
    var exp = expiries[i];
    if (exp <= afterYmd) continue;
    if (exclude && exclude.indexOf(exp) !== -1) continue;
    var days = daysBetweenYmd(afterYmd, exp);
    if (days < minDays) continue;
    var diff = Math.abs(days - targetDays);
    if (diff < bestDiff) { bestDiff = diff; best = exp; }
  }
  return best;
}

function pickWeeklyExpiry(expiries, afterYmd, exclude) {
  return pickNearestExpiry(expiries, afterYmd, 7, 3, exclude);
}

function pickMonthlyExpiry(expiries, afterYmd, exclude) {
  return pickNearestExpiry(expiries, afterYmd, 30, 14, exclude);
}

function packHorizon(data, horizon, expiryYmd) {
  if (!data) return null;
  return {
    horizon: horizon,
    expiry: expiryYmd,
    label: sessionLabel(expiryYmd),
    shortLabel: shortLabel(expiryYmd),
    moveDollars: data.moveDollars,
    movePct: data.movePct,
    upper: data.upper,
    lower: data.lower,
    strike: data.strike,
    callPrice: data.callPrice,
    putPrice: data.putPrice,
    price: data.price
  };
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

function computeTickerMoves(ticker) {
  return yahoo.getExpirationDates(ticker).then(function(expiries) {
    var todayYmd = marketCal.ymdInET(new Date());
    var session1Date = marketCal.nextTradingDayAfter(new Date());
    var session1Ymd = marketCal.ymdInET(session1Date);
    var session2Date = marketCal.nextTradingDayAfter(session1Date);
    var session2Ymd = marketCal.ymdInET(session2Date);
    var weeklyYmd = pickWeeklyExpiry(expiries, todayYmd, [session1Ymd, session2Ymd]);
    var monthlyYmd = pickMonthlyExpiry(expiries, todayYmd, [session1Ymd, session2Ymd, weeklyYmd]);

    var targets = unique([session1Ymd, session2Ymd, weeklyYmd, monthlyYmd]);
    return Promise.all(targets.map(function(exp) {
      return computeExpectedMove(ticker, exp).then(function(m) { return [exp, m]; });
    })).then(function(pairs) {
      var byExp = {};
      pairs.forEach(function(p) { if (p[1]) byExp[p[0]] = p[1]; });

      var price = (byExp[session1Ymd] && byExp[session1Ymd].price)
        || (pairs[0] && pairs[0][1] && pairs[0][1].price) || null;

      return {
        ticker: ticker,
        price: price,
        sessions: [
          packHorizon(byExp[session1Ymd], "Next session", session1Ymd),
          packHorizon(byExp[session2Ymd], "Session +2", session2Ymd)
        ].filter(Boolean),
        weekly: packHorizon(byExp[weeklyYmd], "Weekly", weeklyYmd),
        monthly: packHorizon(byExp[monthlyYmd], "Monthly", monthlyYmd)
      };
    });
  });
}

function formatHorizonLine(h) {
  if (!h) return "";
  var pct = (h.movePct >= 0 ? "+" : "") + h.movePct.toFixed(2) + "%";
  return "**" + h.horizon + "** · " + h.shortLabel + "\n"
    + "±$" + h.moveDollars.toFixed(2) + " (" + pct + ") · "
    + "$" + h.lower.toFixed(2) + " — $" + h.upper.toFixed(2);
}

function computeFullMoves(tickers) {
  var list = tickers || ["SPY", "IWM"];
  var uniqueTickers = [];
  list.forEach(function(t) { if (uniqueTickers.indexOf(t) === -1) uniqueTickers.push(t); });

  return Promise.all(uniqueTickers.map(computeTickerMoves)).then(function(results) {
    var tickersOut = results.filter(function(r) {
      return r && (r.sessions.length || r.weekly || r.monthly);
    });
    return {
      sessionLabel: sessionLabel(marketCal.nextTradingDayAfter(new Date())),
      tickers: tickersOut,
      computedAt: new Date().toISOString()
    };
  });
}

function computePlannedMoves(tickers, plan) {
  return computeFullMoves(tickers).then(function(data) {
    data.tickers = data.tickers.map(function(t) { return filterMoves(t, plan); }).filter(function(t) {
      return t && (t.sessions.length || t.weekly || t.monthly);
    });
    return data;
  });
}

function filterMoves(tickerMoves, plan) {
  if (!tickerMoves || !plan) return tickerMoves;
  var sessions = tickerMoves.sessions || [];
  return {
    ticker: tickerMoves.ticker,
    price: tickerMoves.price,
    sessions: [].concat(
      plan.nextSession !== false && sessions[0] ? [sessions[0]] : [],
      plan.session2 && sessions[1] ? [sessions[1]] : []
    ),
    weekly: plan.weekly ? tickerMoves.weekly : null,
    monthly: plan.monthly ? tickerMoves.monthly : null
  };
}

// Backward-compatible single-session helper
function computeNextSessionMoves(tickers) {
  return computeFullMoves(tickers);
}

module.exports = {
  computeExpectedMove: computeExpectedMove,
  computeTickerMoves: computeTickerMoves,
  computeFullMoves: computeFullMoves,
  computePlannedMoves: computePlannedMoves,
  filterMoves: filterMoves,
  computeNextSessionMoves: computeNextSessionMoves,
  sessionLabel: sessionLabel,
  formatHorizonLine: formatHorizonLine
};
