// QQQ-only Hermes "Best Win Rate" breakout rules (OrbPresetSession / BEST_WIN_RATE).
//
// Copied from Joey's preset, with these Argus overrides:
//   • Do NOT use the Hermes premium step-up stop. Argus exitlogic (−15% option) stays.
//   • Do NOT latch the first break of the day. After the QQQ paper book is flat, every
//     new 2-close confirmation can enter again, all session.
//   • No morning bar-end cutoff and no 2-minute entry grace. The paper entry path
//     stops opening once Argus's existing 3:45 PM ET flatten (and the 3:55 no-new-entries
//     rule) is already in effect. This module does not add its own late-day cutoff.
//
// Opening range: high/low of 1-minute bars with start in [9:30, 9:35) ET.
// Breakout bars: 1-minute bars aggregated into fixed 15-minute blocks starting 9:35 ET
// (9:35–9:50, 9:50–10:05, …) through the session. Zone uses the block close, not the wick.
//   up:   close > OR high * (1 + 0.05/100)
//   down: close < OR low  * (1 - 0.05/100)
// Confirmation: 2 consecutive block closes in the same zone (streak hits 2 once).
// A wide open skips the day: ((high - low) / mid) * 100 > 0.3.

var OR_START_MIN = 9 * 60 + 30;
var OR_END_MIN = 9 * 60 + 35;
var BLOCK_MINUTES = 15;
var BUFFER_PCT = 0.05;
var CONFIRM_CLOSES = 2;
var WIDTH_CAP_PCT = 0.3;
var MAX_HOLD_MINUTES = 120;

function roundPct(n) {
  return Math.round(n * 10000) / 10000;
}

function orbWidthPct(high, low) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  if (!isFinite(h) || !isFinite(l) || h <= l) return null;
  var mid = (h + l) / 2;
  if (!(mid > 0)) return null;
  return roundPct(((h - l) / mid) * 100);
}

function barStartMinutesET(unixSec) {
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit"
  }).formatToParts(new Date(unixSec * 1000));
  var hour = 0;
  var minute = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === "hour") hour = parseInt(parts[i].value, 10);
    if (parts[i].type === "minute") minute = parseInt(parts[i].value, 10);
  }
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

function parseChartBars(chartData) {
  if (!chartData || !chartData.chart || !chartData.chart.result || !chartData.chart.result[0]) return [];
  var result = chartData.chart.result[0];
  var ts = result.timestamp || [];
  var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!q || !ts.length) return [];
  var regStart = result.meta && result.meta.currentTradingPeriod &&
    result.meta.currentTradingPeriod.regular &&
    result.meta.currentTradingPeriod.regular.start;
  var bars = [];
  for (var i = 0; i < ts.length; i++) {
    if (regStart && ts[i] < regStart) continue;
    if (q.close[i] == null || !isFinite(parseFloat(q.close[i]))) continue;
    var high = q.high && q.high[i] != null ? parseFloat(q.high[i]) : parseFloat(q.close[i]);
    var low = q.low && q.low[i] != null ? parseFloat(q.low[i]) : parseFloat(q.close[i]);
    bars.push({
      ts: ts[i],
      minute: barStartMinutesET(ts[i]),
      open: q.open && q.open[i] != null ? parseFloat(q.open[i]) : null,
      high: high,
      low: low,
      close: parseFloat(q.close[i])
    });
  }
  return bars;
}

function openingRange(bars) {
  var high = null;
  var low = null;
  (bars || []).forEach(function(b) {
    if (!b || !isFinite(b.minute) || b.minute < OR_START_MIN || b.minute >= OR_END_MIN) return;
    if (!isFinite(b.high) || !isFinite(b.low) || b.high <= 0 || b.low <= 0) return;
    if (high == null || b.high > high) high = b.high;
    if (low == null || b.low < low) low = b.low;
  });
  if (!(high > low)) return null;
  return { high: high, low: low, mid: (high + low) / 2 };
}

function blockStartMin(minute) {
  if (!isFinite(minute) || minute < OR_END_MIN) return null;
  var offset = minute - OR_END_MIN;
  return OR_END_MIN + Math.floor(offset / BLOCK_MINUTES) * BLOCK_MINUTES;
}

function aggregateBlocks(bars, nowSec) {
  var byStart = {};
  (bars || []).forEach(function(b) {
    if (!b || !isFinite(b.minute) || !isFinite(b.close)) return;
    var start = blockStartMin(b.minute);
    if (start == null) return;
    var end = start + BLOCK_MINUTES;
    if (!byStart[start]) {
      byStart[start] = {
        startMin: start, endMin: end, high: -Infinity, low: Infinity,
        close: null, closeMin: -1, endTs: null
      };
    }
    var g = byStart[start];
    if (isFinite(b.high)) g.high = Math.max(g.high, b.high);
    if (isFinite(b.low)) g.low = Math.min(g.low, b.low);
    if (b.minute >= g.closeMin) {
      g.closeMin = b.minute;
      g.close = b.close;
    }
    if (isFinite(b.ts)) {
      var barEnd = b.ts + (end - b.minute) * 60;
      if (g.endTs == null || barEnd > g.endTs) g.endTs = barEnd;
    }
  });
  return Object.keys(byStart).map(function(k) { return byStart[k]; }).filter(function(g) {
    if (!isFinite(g.close)) return false;
    if (g.endTs == null) return false;
    if (isFinite(nowSec) && nowSec < g.endTs) return false;
    return true;
  }).sort(function(a, b) { return a.startMin - b.startMin; });
}

function zoneOf(close, orbHigh, orbLow, bufferPct) {
  var c = parseFloat(close);
  var h = parseFloat(orbHigh);
  var l = parseFloat(orbLow);
  var buf = isFinite(bufferPct) ? bufferPct : BUFFER_PCT;
  if (!isFinite(c) || !isFinite(h) || !isFinite(l) || !(h > l)) return null;
  if (c > h * (1 + buf / 100)) return "up";
  if (c < l * (1 - buf / 100)) return "down";
  return null;
}

function scanBreaks(blocks, orb) {
  var zone = null;
  var streak = 0;
  var breaks = [];
  (blocks || []).forEach(function(block) {
    var z = zoneOf(block.close, orb.high, orb.low);
    if (z && z === zone) streak += 1;
    else if (z) { zone = z; streak = 1; }
    else { zone = null; streak = 0; }
    if (streak === CONFIRM_CLOSES && z) {
      breaks.push({
        direction: z,
        endMin: block.endMin,
        endTs: block.endTs,
        close: block.close
      });
    }
  });
  return breaks;
}

function consumedHas(consumedEndMins, endMin) {
  return (consumedEndMins || []).some(function(m) { return m === endMin; });
}

// Decide which closed confirmations to consume, and at most one to take.
// No morning cutoff and no grace window: a closed 2-close is eligible whenever it
// completed. `inPosition` consumes it without entering (no flip). If several
// unconsumed confirmations are pending while flat, take the latest and consume
// the earlier ones so a catch-up poll does not replay the morning.
function evaluateSession(orb, blocks, opts) {
  opts = opts || {};
  var widthPct = orb ? orbWidthPct(orb.high, orb.low) : null;
  var skipDay = widthPct != null && widthPct > WIDTH_CAP_PCT;
  var actions = [];
  if (!orb) return { widthPct: widthPct, skipDay: false, actions: actions, event: null };
  var breaks = scanBreaks(blocks, orb);
  var nowSec = opts.nowSec;
  var pendingTake = null;
  for (var i = 0; i < breaks.length; i++) {
    var br = breaks[i];
    if (consumedHas(opts.consumedEndMins, br.endMin)) continue;
    var action = {
      endMin: br.endMin,
      endTs: br.endTs,
      direction: br.direction,
      close: br.close,
      consume: true,
      take: false,
      reason: "skip"
    };
    if (skipDay) {
      action.reason = "width";
      actions.push(action);
      continue;
    }
    var age = isFinite(nowSec) && isFinite(br.endTs) ? nowSec - br.endTs : null;
    if (age == null || age < 0) {
      action.consume = false;
      action.reason = "not-closed";
      actions.push(action);
      continue;
    }
    if (opts.inPosition) {
      action.reason = "in-position";
      actions.push(action);
      continue;
    }
    if (pendingTake) {
      pendingTake.take = false;
      pendingTake.reason = "superseded";
      pendingTake.event = null;
      pendingTake.side = null;
    }
    action.take = true;
    action.reason = "break";
    action.event = br.direction === "down" ? "breakout_short" : "breakout_long";
    action.side = br.direction === "down" ? "put" : "call";
    actions.push(action);
    pendingTake = action;
  }
  var taken = null;
  for (var j = 0; j < actions.length; j++) if (actions[j].take) taken = actions[j];
  return { widthPct: widthPct, skipDay: skipDay, actions: actions, event: taken };
}

function holdExceeded(entryTime, nowMs) {
  var t = Date.parse(entryTime);
  if (!isFinite(t) || !isFinite(nowMs)) return false;
  return (nowMs - t) > MAX_HOLD_MINUTES * 60 * 1000;
}

// Daily EM band frozen at entry. Ignore when the directional level is already
// behind the entry underlying (call target <= entry, put target >= entry).
function freezeEmAtEntry(side, entryUnderlying, emUpper, emLower) {
  var entry = parseFloat(entryUnderlying);
  var upper = parseFloat(emUpper);
  var lower = parseFloat(emLower);
  var target = side === "put" ? lower : upper;
  var armed = false;
  if (isFinite(entry) && isFinite(target)) {
    armed = side === "put" ? target < entry : target > entry;
  }
  return {
    armed: armed,
    target: isFinite(target) ? target : null,
    upper: isFinite(upper) ? upper : null,
    lower: isFinite(lower) ? lower : null,
    extreme: isFinite(entry) ? entry : null,
    entryUnderlying: isFinite(entry) ? entry : null
  };
}

function updateExtreme(side, extreme, price) {
  var px = parseFloat(price);
  if (!isFinite(px)) return isFinite(extreme) ? extreme : null;
  if (!isFinite(extreme)) return px;
  if (side === "put") return Math.min(extreme, px);
  return Math.max(extreme, px);
}

function emTakeProfitHit(side, armed, target, extreme) {
  if (!armed || !isFinite(target) || !isFinite(extreme)) return false;
  if (side === "put") return extreme <= target;
  return extreme >= target;
}

module.exports = {
  OR_START_MIN: OR_START_MIN,
  OR_END_MIN: OR_END_MIN,
  BLOCK_MINUTES: BLOCK_MINUTES,
  BUFFER_PCT: BUFFER_PCT,
  CONFIRM_CLOSES: CONFIRM_CLOSES,
  WIDTH_CAP_PCT: WIDTH_CAP_PCT,
  MAX_HOLD_MINUTES: MAX_HOLD_MINUTES,
  orbWidthPct: orbWidthPct,
  barStartMinutesET: barStartMinutesET,
  parseChartBars: parseChartBars,
  openingRange: openingRange,
  blockStartMin: blockStartMin,
  aggregateBlocks: aggregateBlocks,
  zoneOf: zoneOf,
  scanBreaks: scanBreaks,
  evaluateSession: evaluateSession,
  holdExceeded: holdExceeded,
  freezeEmAtEntry: freezeEmAtEntry,
  updateExtreme: updateExtreme,
  emTakeProfitHit: emTakeProfitHit
};
