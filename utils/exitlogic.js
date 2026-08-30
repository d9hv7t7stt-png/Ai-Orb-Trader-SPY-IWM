// utils/exitlogic.js
// Pure profit-taking / stop decisions (no side effects). Shared by the real
// profit manager and the Discord paper engine so both behave identically.
//
// Rules:
//   • Scale out: sell 10% of the position for every +20% of gain.
//   • Initial stop: -15% (active before breakeven).
//   • Breakeven stop activates at +30% (stop floor -> 0% = entry).
//   • Trailing stop: after breakeven, the stop ratchets UP +10% for every +20%
//     of gain above the +30% breakeven point. It never moves down.
//   • Stop-out: exit the full remaining position if gain falls to/through the
//     current stop level.

var INITIAL_STOP_PCT = -15;
var BREAKEVEN_AT_PCT = 30;
var SCALE_STEP_PCT   = 20;    // every +20% gain → sell 10% (strategy spec)
var SCALE_SELL_FRAC  = 0.10;
var TRAIL_EVERY_PCT  = 20;    // for every +20% above breakeven ...
var TRAIL_MOVE_PCT   = 10;    // ... move the stop up +10%

function gainPct(entry, price) {
  if (!entry || entry <= 0) return 0;
  var g = ((price - entry) / entry) * 100;
  return Math.round(g * 1e6) / 1e6;   // kill float dust at exact thresholds
}

// pos must carry: entryPrice, lastProfitTier, breakEvenActivated, stopPct.
// Returns a decision; does NOT mutate pos. Caller applies + persists the result.
function evaluate(pos, price) {
  var gain = gainPct(pos.entryPrice, price);
  var stopPct = (typeof pos.stopPct === "number") ? pos.stopPct : INITIAL_STOP_PCT;

  var activateBreakeven = !pos.breakEvenActivated && gain >= BREAKEVEN_AT_PCT;
  var breakevenActive = pos.breakEvenActivated || activateBreakeven;

  if (breakevenActive) {
    if (stopPct < 0) stopPct = 0;                                  // breakeven floor
    var steps = Math.floor((gain - BREAKEVEN_AT_PCT) / TRAIL_EVERY_PCT);
    if (steps > 0) {
      var trail = steps * TRAIL_MOVE_PCT;
      if (trail > stopPct) stopPct = trail;                        // ratchet up only
    }
  }

  var stopOut = gain <= stopPct;

  var step = Math.floor(gain / SCALE_STEP_PCT);
  var lastTier = pos.lastProfitTier || 0;
  var scaleOut = !stopOut && gain >= SCALE_STEP_PCT && step > lastTier;

  return {
    gain: gain,
    newStopPct: stopPct,
    activateBreakeven: activateBreakeven,
    breakevenActive: breakevenActive,
    stopOut: stopOut,
    scaleOut: scaleOut,
    newTier: scaleOut ? step : lastTier,
    sellFraction: SCALE_SELL_FRAC
  };
}

// 15 minutes before the 4:00 PM ET close. DST-safe (computes actual ET time).
function etMinutesOfDay() {
  var s = new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit"
  });
  var parts = s.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
function isEndOfDayWindow() {
  var m = etMinutesOfDay();
  return m >= (15 * 60 + 45) && m < (16 * 60);   // 3:45–4:00 PM ET
}

function isWeekdayET(date) {
  var d = date || new Date();
  var wd = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(d);
  return wd !== "Sat" && wd !== "Sun";
}

function isRegularMarketHours() {
  if (!isWeekdayET()) return false;
  var m = etMinutesOfDay();
  return m >= (9 * 60 + 30) && m < (16 * 60);   // 9:30 AM–4:00 PM ET, DST-safe
}

function msUntilNextTimeET(hour, minute) {
  var now = new Date();
  var formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  });
  for (var addMin = 1; addMin <= 24 * 60; addMin++) {
    var candidate = new Date(now.getTime() + addMin * 60000);
    var parts = formatter.formatToParts(candidate);
    function part(type) {
      var p = parts.find(function(x) { return x.type === type; });
      return p ? parseInt(p.value, 10) : 0;
    }
    if (part("hour") === hour && part("minute") === minute) {
      return addMin * 60000 - part("second") * 1000 - candidate.getMilliseconds();
    }
  }
  return 86400000;
}

// Next Mon–Fri occurrence of hour:minute ET (skips Sat/Sun).
function msUntilNextTradingTimeET(hour, minute) {
  var now = new Date();
  var formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    weekday: "short"
  });
  for (var addMin = 1; addMin <= 7 * 24 * 60; addMin++) {
    var candidate = new Date(now.getTime() + addMin * 60000);
    var parts = formatter.formatToParts(candidate);
    function part(type) {
      var p = parts.find(function(x) { return x.type === type; });
      if (!p) return type === "weekday" ? "" : 0;
      return type === "weekday" ? p.value : parseInt(p.value, 10);
    }
    var wd = part("weekday");
    if (wd === "Sat" || wd === "Sun") continue;
    if (part("hour") === hour && part("minute") === minute) {
      return addMin * 60000 - part("second") * 1000 - candidate.getMilliseconds();
    }
  }
  return 7 * 86400000;
}

function etDateKey() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

module.exports = {
  evaluate: evaluate,
  gainPct: gainPct,
  isEndOfDayWindow: isEndOfDayWindow,
  isRegularMarketHours: isRegularMarketHours,
  isWeekdayET: isWeekdayET,
  msUntilNextTimeET: msUntilNextTimeET,
  msUntilNextTradingTimeET: msUntilNextTradingTimeET,
  etDateKey: etDateKey,
  etMinutesOfDay: etMinutesOfDay,
  INITIAL_STOP_PCT: INITIAL_STOP_PCT,
  BREAKEVEN_AT_PCT: BREAKEVEN_AT_PCT,
  SCALE_STEP_PCT: SCALE_STEP_PCT,
  SCALE_SELL_FRAC: SCALE_SELL_FRAC,
  TRAIL_EVERY_PCT: TRAIL_EVERY_PCT,
  TRAIL_MOVE_PCT: TRAIL_MOVE_PCT,
  EOD_SELL_FRAC: 0.50
};
