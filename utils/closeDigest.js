// utils/closeDigest.js — smart after-close digest: technicals + expected moves.

var yahoo = require("./yahoo");
var marketCal = require("./marketCalendar");
var technicals = require("./technicals");
var expectedMove = require("./expectedMove");

var MAIN_WATCHLIST = [
  "SPY", "SPXW", "QQQ", "IWM", "AAPL", "AMZN", "META", "NVDA", "MSFT", "TSLA",
  "SPCX", "XLE", "GOOG", "SMH", "GLD", "SLV"
];

function weekdayET(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
    .format(date || new Date());
}

function isLastTradingDayOfMonth(date) {
  var next = marketCal.nextTradingDayAfter(date || new Date());
  return marketCal.ymdInET(date).slice(0, 7) !== marketCal.ymdInET(next).slice(0, 7);
}

var INDEX_MOVE_TICKERS = ["SPY", "IWM", "QQQ", "SPXW"];

function isQuarterEnd(date) {
  if (!isLastTradingDayOfMonth(date)) return false;
  var m = parseInt(marketCal.ymdInET(date).slice(5, 7), 10);
  return m === 3 || m === 6 || m === 9 || m === 12;
}

function buildPlan(channelCfg) {
  var now = new Date();
  var wd = weekdayET(now);
  var monthEnd = isLastTradingDayOfMonth(now);
  var quarterEnd = isQuarterEnd(now);
  var isMain = channelCfg.id === "main";
  var isMon = wd === "Mon";
  var isFri = wd === "Fri";

  return {
    label: quarterEnd ? "Quarter-end close" : monthEnd ? "Month-end close" : isMon ? "Monday close" : isFri ? "Friday close" : wd + " close",
    fullWatchlist: isMain && (isMon || isFri || monthEnd),
    notableWatchlistOnly: isMain && !isMon && !isFri && !monthEnd,
    moves: {
      nextSession: true,
      session2: isMon || isFri || monthEnd,
      weekly: isMon || isFri || monthEnd,
      monthly: isMon || monthEnd,
      quarterly: isMon || quarterEnd || monthEnd
    },
    watchlistMovesFull: isMain && (isFri || monthEnd || quarterEnd),
    note: isMain && !isMon && !isFri && !monthEnd
      ? "Mid-week: ORB + index 1σ · watchlist notable only"
      : isMon ? "Monday: full watchlist · this week / month / quarter moves"
      : isFri ? "Friday: full watchlist · calendar week moves"
      : quarterEnd ? "Quarter-end: quarterly implied ranges included"
      : monthEnd ? "Month-end: monthly implied ranges included"
      : "Daily ORB focus"
  };
}

function formatMovesBlock(moves, compact) {
  if (!moves) return "";
  var lines = [];
  if (moves.hitsToday && moves.hitsToday.length) {
    lines.push(expectedMove.formatHits(moves.hitsToday));
  }
  (moves.sessions || []).forEach(function(s) {
    if (compact && !s.oneSdDollars) {
      lines.push("Next: ±$" + s.moveDollars.toFixed(2) + " (" + s.movePct.toFixed(2) + "%)");
    } else {
      lines.push(expectedMove.formatHorizonLine(s));
    }
  });
  if (!compact) {
    if (moves.weekly) lines.push(expectedMove.formatHorizonLine(moves.weekly));
    if (moves.monthly) lines.push(expectedMove.formatHorizonLine(moves.monthly));
    if (moves.quarterly) lines.push(expectedMove.formatHorizonLine(moves.quarterly));
  } else {
    if (moves.weekly) lines.push("This week: ±" + moves.weekly.movePct.toFixed(2) + "%");
    if (moves.monthly) lines.push("This month: ±" + moves.monthly.movePct.toFixed(2) + "%");
    if (moves.quarterly) lines.push("This quarter: ±" + moves.quarterly.movePct.toFixed(2) + "%");
  }
  return lines.join("\n\n");
}

function buildDigest(channelCfg) {
  var plan = buildPlan(channelCfg);
  var primary = channelCfg.tickers || [];
  var watchlist = channelCfg.watchlist || [];

  var techTickers = primary.slice();
  if (plan.fullWatchlist || plan.notableWatchlistOnly) {
    watchlist.forEach(function(t) {
      if (techTickers.indexOf(t) === -1) techTickers.push(t);
    });
  }

  var moveTickers = channelCfg.id === "main" ? INDEX_MOVE_TICKERS.slice() : primary.slice();
  if (plan.watchlistMovesFull) {
    MAIN_WATCHLIST.forEach(function(t) {
      if (moveTickers.indexOf(t) === -1) moveTickers.push(t);
    });
  }

  return technicals.getSnapshots(techTickers).then(function(snaps) {
    var snapMap = {};
    snaps.forEach(function(s) { snapMap[s.ticker] = s; snapMap[s.display] = s; });

    var primaryBlocks = primary.map(function(t) {
      return { ticker: t, snap: snapMap[t] || snapMap[yahoo.displaySymbol(t)] || null };
    });

    var watchSnaps = [];
    watchlist.forEach(function(t) {
      if (primary.indexOf(t) !== -1) return;
      var s = snapMap[t] || snapMap[yahoo.displaySymbol(t)];
      if (!s) return;
      if (plan.fullWatchlist) watchSnaps.push(s);
      else if (plan.notableWatchlistOnly && s.notable) watchSnaps.push(s);
    });

    return expectedMove.computePlannedMoves(moveTickers, plan.moves).then(function(moveData) {
      var movesMap = {};
      (moveData.tickers || []).forEach(function(m) { movesMap[m.ticker] = m; });

      primaryBlocks.forEach(function(b) {
        b.moves = movesMap[b.ticker] || null;
      });

      var watchlistMoves = [];
      if (plan.watchlistMovesFull) {
        MAIN_WATCHLIST.forEach(function(t) {
          if (primary.indexOf(t) !== -1) return;
          if (movesMap[t]) watchlistMoves.push({ ticker: t, moves: movesMap[t] });
        });
      }

      return {
        plan: plan,
        primary: primaryBlocks,
        watchlist: watchSnaps,
        watchlistMoves: watchlistMoves,
        computedAt: new Date().toISOString()
      };
    });
  });
}

function formatSundayMoves(moves) {
  if (!moves) return "";
  var lines = [];
  var monday = moves.sessions && moves.sessions[0];
  if (monday) {
    lines.push("**Monday** ±$" + monday.moveDollars.toFixed(2) + " (" + monday.movePct.toFixed(2) + "%)");
    if (monday.oneSdDollars) {
      lines.push("1σ Mon ±$" + monday.oneSdDollars.toFixed(2) + " (" + monday.oneSdPct.toFixed(2) + "%)");
    }
  }
  if (moves.weekly) {
    lines.push("**This week** ±$" + moves.weekly.moveDollars.toFixed(2) + " (" + moves.weekly.movePct.toFixed(2) + "%)");
  }
  return lines.join("\n");
}

function formatSundayBlock(block) {
  var lines = [];
  if (block.snap) lines.push(technicals.formatCompact(block.snap));
  var mv = formatSundayMoves(block.moves);
  if (mv) lines.push(mv);
  return lines.join("\n\n") || "—";
}

function buildSundayPremarket() {
  var tickers = MAIN_WATCHLIST.slice();
  var movePlan = { nextSession: true, session2: false, weekly: true, monthly: false, quarterly: false };

  return technicals.getSnapshots(tickers).then(function(snaps) {
    var snapMap = {};
    snaps.forEach(function(s) { snapMap[s.ticker] = s; snapMap[s.display] = s; });

    return expectedMove.computePlannedMoves(tickers, movePlan).then(function(moveData) {
      var movesMap = {};
      (moveData.tickers || []).forEach(function(m) { movesMap[m.ticker] = m; });

      var blocks = tickers.map(function(t) {
        return {
          ticker: t,
          snap: snapMap[t] || snapMap[yahoo.displaySymbol(t)] || null,
          moves: movesMap[t] || null
        };
      });

      return {
        sessionLabel: moveData.sessionLabel,
        blocks: blocks,
        computedAt: new Date().toISOString()
      };
    });
  });
}

module.exports = {
  MAIN_WATCHLIST: MAIN_WATCHLIST,
  buildPlan: buildPlan,
  buildDigest: buildDigest,
  buildSundayPremarket: buildSundayPremarket,
  formatMovesBlock: formatMovesBlock,
  formatSundayBlock: formatSundayBlock,
  formatSundayMoves: formatSundayMoves
};
