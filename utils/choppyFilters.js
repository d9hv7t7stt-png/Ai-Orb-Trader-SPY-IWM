// Choppy-day entry filters.
//
// stop_after_first_loss — after a losing close, block new entries for the rest
//   of the ET trading day. A live loss arms only that live ticker. A paper loss
//   arms only the Discord channel that closed it.
// orb_recross_skip — count opposite breakout_long / breakout_short alerts per
//   ticker. The first breakout in [9:35, 10:15) ET sets the side. Each later
//   opposite-side breakout before 10:15 adds 1. The count freezes at 10:15.
//   Threshold is orb_recross_min (default 2). Alerts are counted even while a
//   position is open. Yahoo is not called.
// orb_width_skip — OR width % = (orbHigh - orbLow) / orbMid * 100 from the
//   TradingView orb_set range. Each ticker has its own max and/or min. A missing
//   range fails open.
//
// Modes: off (no effect), shadow (trade still sent, review row written),
// on (entry blocked, review row still written). Review file: filter-shadow.json
// on the data volume. New entries only; retest adds and exits are not filtered.

var fs = require("fs");

var OR_START_MIN = 9 * 60 + 30;
var WINDOW_START_MIN = 9 * 60 + 35;
var WINDOW_END_MIN = 10 * 60 + 15;
var BAR_MINUTES = 5;

var _loss = null;
var _shadow = null;

function shadowFile() {
  if (process.env.FILTER_SHADOW_FILE) return process.env.FILTER_SHADOW_FILE;
  return require("./persist").filePath("filter-shadow.json");
}

function lossFile() {
  if (process.env.FILTER_STATE_FILE) return process.env.FILTER_STATE_FILE;
  return require("./persist").filePath("choppy-filter-state.json");
}

function canon(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPXW") t = "SPX";
  if (t === "SPY" || t === "IWM" || t === "QQQ" || t === "SPX") return t;
  return null;
}

function todayISO(date) {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  var d = date instanceof Date ? date : new Date();
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function configFrom(opts) {
  var settings = require("./settings");
  if (opts && opts.settings) return settings.resolveFilterSettings(opts.settings);
  return settings.getFilterConfig();
}

function zone(close, orHigh, orLow) {
  if (close > orHigh) return 1;
  if (close < orLow) return -1;
  return 0;
}

// bars: [{ startMin, close }] in any order. asOfMin is the ET minute the
// decision is made; a bar is visible only after it closes (start + 5).
function countOrbRecrosses(bars, orHigh, orLow, asOfMin) {
  var high = parseFloat(orHigh);
  var low = parseFloat(orLow);
  if (!isFinite(high) || !isFinite(low) || high <= low) return 0;
  var asOf = typeof asOfMin === "number" ? asOfMin : WINDOW_END_MIN;
  var rows = [];
  (bars || []).forEach(function(b) {
    if (!b) return;
    var start = b.startMin;
    var close = parseFloat(b.close);
    if (typeof start !== "number" || !isFinite(close)) return;
    if (start < WINDOW_START_MIN || start >= WINDOW_END_MIN) return;
    if (start + BAR_MINUTES > asOf) return;
    rows.push({ startMin: start, close: close });
  });
  rows.sort(function(a, b) { return a.startMin - b.startMin; });
  var transitions = 0;
  var prev = null;
  for (var i = 0; i < rows.length; i++) {
    var z = zone(rows[i].close, high, low);
    if (prev != null && z !== prev) transitions++;
    prev = z;
  }
  return transitions;
}

function barsFromYahooChart(parsed) {
  var out = [];
  try {
    if (!parsed) return out;
    var result = parsed.chart && parsed.chart.result && parsed.chart.result[0];
    if (!result) return out;
    var ts = result.timestamp || [];
    var q = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!q) return out;
    var orb = require("./orb");
    var regStart = result.meta && result.meta.currentTradingPeriod &&
      result.meta.currentTradingPeriod.regular &&
      result.meta.currentTradingPeriod.regular.start;
    for (var i = 0; i < ts.length; i++) {
      if (regStart && ts[i] < regStart) continue;
      var close = parseFloat(q.close[i]);
      if (!isFinite(close)) continue;
      out.push({ startMin: orb.barStartMinutesET(ts[i]), close: close, ts: ts[i] });
    }
  } catch (e) {}
  return out;
}

function loadLossState() {
  if (_loss) return _loss;
  _loss = { date: null, losses: {}, recross: {} };
  try {
    if (fs.existsSync(lossFile())) {
      var parsed = JSON.parse(fs.readFileSync(lossFile(), "utf8"));
      if (parsed && typeof parsed === "object") {
        _loss.date = parsed.date || null;
        _loss.losses = parsed.losses && typeof parsed.losses === "object" ? parsed.losses : {};
        _loss.recross = parsed.recross && typeof parsed.recross === "object" ? parsed.recross : {};
      }
    }
  } catch (e) {}
  return _loss;
}

function saveLossState() {
  try { fs.writeFileSync(lossFile(), JSON.stringify(loadLossState())); }
  catch (e) { console.log("[FILTER] loss-state save failed: " + e.message); }
}

function ensureDay(date) {
  var d = todayISO(date);
  var st = loadLossState();
  if (st.date !== d) {
    st.date = d;
    st.losses = {};
    st.recross = {};
  }
  if (!st.losses || typeof st.losses !== "object") st.losses = {};
  if (!st.recross || typeof st.recross !== "object") st.recross = {};
  return st;
}

function liveLossKey(ticker) { return "live:" + ticker; }
function paperLossKey(channel) { return "paper:" + String(channel); }

function hasLossToday(ticker, date) {
  var t = canon(ticker);
  if (!t) return false;
  var st = loadLossState();
  if (st.date !== todayISO(date)) return false;
  return !!(st.losses[liveLossKey(t)] || st.losses[t]);
}

function hasPaperLoss(channel, date) {
  if (!channel) return false;
  var st = loadLossState();
  if (st.date !== todayISO(date)) return false;
  return !!st.losses[paperLossKey(channel)];
}

function markScoped(key, date) {
  if (!key) return false;
  var st = ensureDay(date);
  st.losses[key] = true;
  saveLossState();
  return true;
}

function markLoss(ticker, date) {
  var t = canon(ticker);
  if (!t) return false;
  return markScoped(liveLossKey(t), date);
}

function normalizeBreakSide(side) {
  var s = String(side || "").toLowerCase();
  if (s === "long" || s === "call" || s === "breakout_long") return "long";
  if (s === "short" || s === "put" || s === "breakout_short") return "short";
  return null;
}

// First in-window breakout sets the side (count stays 0). Each later opposite
// side before 10:15 adds 1. Same-side repeats do not. At/after 10:15 the stored
// count is left unchanged.
function noteBreakout(ticker, side, opts) {
  opts = opts || {};
  var t = canon(ticker);
  var norm = normalizeBreakSide(side);
  if (!t || !norm) return null;
  var asOf = typeof opts.asOfMin === "number" ? opts.asOfMin : asOfMinutes(opts);
  var st = ensureDay(opts.date);
  var rec = st.recross[t] || { count: 0, lastSide: null };
  var frozen = asOf >= WINDOW_END_MIN;
  var beforeWindow = asOf < WINDOW_START_MIN;
  if (!frozen && !beforeWindow) {
    if (!rec.lastSide) rec.lastSide = norm;
    else if (rec.lastSide !== norm) {
      rec.count += 1;
      rec.lastSide = norm;
    }
  }
  st.recross[t] = rec;
  saveLossState();
  return { count: rec.count, lastSide: rec.lastSide, frozen: frozen };
}

function recrossCount(ticker, date) {
  var t = canon(ticker);
  var st = loadLossState();
  if (!t || st.date !== todayISO(date) || !st.recross || !st.recross[t]) return 0;
  return st.recross[t].count || 0;
}

function roundPct(n) {
  return Math.round(n * 10000) / 10000;
}

function orbWidthPct(high, low) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  if (!isFinite(h) || !isFinite(l) || h <= l) return null;
  var mid = (h + l) / 2;
  if (!(mid > 0)) return null;
  return roundPct((h - l) / mid * 100);
}

function widthBreach(ticker, width, cfg) {
  if (width == null || !isFinite(width)) return null;
  var max = cfg.orb_width_max ? cfg.orb_width_max[ticker] : null;
  var min = cfg.orb_width_min ? cfg.orb_width_min[ticker] : null;
  if (max != null && width > max) return { bound: "max", limit: max, width: width };
  if (min != null && width < min) return { bound: "min", limit: min, width: width };
  return null;
}

function loadShadow() {
  if (_shadow) return _shadow;
  _shadow = { records: [] };
  try {
    if (fs.existsSync(shadowFile())) {
      var parsed = JSON.parse(fs.readFileSync(shadowFile(), "utf8"));
      if (parsed && Array.isArray(parsed.records)) _shadow = parsed;
      else if (Array.isArray(parsed)) _shadow = { records: parsed };
    }
  } catch (e) {}
  if (!_shadow.records) _shadow.records = [];
  return _shadow;
}

function saveShadow() {
  try { fs.writeFileSync(shadowFile(), JSON.stringify(loadShadow())); }
  catch (e) { console.log("[FILTER] shadow save failed: " + e.message); }
}

function pruneShadow(records) {
  var cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 400);
  var cut = cutoff.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  var kept = (records || []).filter(function(r) { return r && r.date && r.date >= cut; });
  if (kept.length > 5000) kept = kept.slice(kept.length - 5000);
  return kept;
}

var _seq = 0;
function makeId() {
  _seq++;
  return Date.now().toString(36) + "-" + _seq.toString(36);
}

function fmtMin(m) {
  var h = Math.floor(m / 60);
  var mm = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (mm < 10 ? "0" : "") + mm;
}

function logFilter(ticker, trigger, side, transitions, min, asOf, overallBlock) {
  var sideLabel = side || "new";
  var why;
  if (trigger.filter === "stop_after_first_loss") {
    why = "losing close already today";
  } else if (trigger.filter === "orb_width_skip") {
    why = trigger.detail || "OR width outside threshold";
  } else {
    var by = asOf >= WINDOW_END_MIN ? "10:15 ET" : (fmtMin(asOf) + " ET");
    why = transitions + " OR re-crosses >= " + min + " by " + by;
  }
  var action;
  if (trigger.mode === "on") action = "BLOCKED " + sideLabel + " entry";
  else if (overallBlock) action = "SHADOW would block " + sideLabel + " entry; entry blocked by another filter";
  else action = "SHADOW would block " + sideLabel + " entry; trade still sent";
  var msg = ticker + " " + trigger.filter + " " + trigger.mode + " — " + action + " (" + why + ")";
  try { require("./state").logEvent("FILTER", msg); }
  catch (e) { console.log("[FILTER] " + msg); }
}

function buildTrade(opts, or, trigger, transitions, min) {
  var trade = {
    side: opts.side || null,
    event: opts.event || "entry",
    entryTime: opts.entryTime || new Date().toISOString()
  };
  if (opts.contracts != null) trade.contracts = opts.contracts;
  if (opts.entryPrice != null && opts.entryPrice !== "") trade.entryPrice = opts.entryPrice;
  if (opts.strike != null) trade.strike = opts.strike;
  if (opts.expiry) trade.expiry = opts.expiry;
  var high = or ? or.high : opts.orbHigh;
  var low = or ? or.low : opts.orbLow;
  if (high != null && high !== "") trade.orbHigh = high;
  if (low != null && low !== "") trade.orbLow = low;
  if (opts.channel) trade.channel = opts.channel;
  if (opts.signalTicker) trade.signalTicker = opts.signalTicker;
  if (trigger.filter === "orb_recross_skip") {
    trade.transitions = transitions;
    trade.minTransitions = min;
  }
  if (trigger.filter === "orb_width_skip") {
    trade.widthPct = trigger.widthPct;
    trade.widthBound = trigger.bound;
    trade.widthLimit = trigger.limit;
  }
  return trade;
}

function appendShadow(row) {
  var data = loadShadow();
  row.id = row.id || makeId();
  data.records.push(row);
  data.records = pruneShadow(data.records);
  saveShadow();
  return row.id;
}

function resolveOr(ticker, opts) {
  var h = parseFloat(opts && opts.orbHigh);
  var l = parseFloat(opts && opts.orbLow);
  if (isFinite(h) && isFinite(l) && h > l) return { high: h, low: l };
  try {
    var orb = require("./state").getState().orb[ticker];
    if (orb && orb.high > orb.low) return { high: parseFloat(orb.high), low: parseFloat(orb.low) };
  } catch (e) {}
  return null;
}

function asOfMinutes(opts) {
  if (opts && typeof opts.asOfMin === "number") return opts.asOfMin;
  try { return require("./exitlogic").etMinutesOfDay(); }
  catch (e) { return 0; }
}

function triggersFor(lossMode, recrossMode, lossToday, transitions, min) {
  var triggers = [];
  if (lossMode !== "off" && lossToday) {
    triggers.push({ filter: "stop_after_first_loss", mode: lossMode });
  }
  if (recrossMode !== "off" && transitions != null && transitions >= min) {
    triggers.push({ filter: "orb_recross_skip", mode: recrossMode });
  }
  return triggers;
}

// Decide and, when a filter would block, write the review row.
// Returns { block, shadowIds, triggers, transitions }.
async function checkEntry(opts) {
  opts = opts || {};
  var ticker = canon(opts.ticker);
  if (!ticker) return { block: false, shadowIds: [], triggers: [], transitions: null };
  var cfg = configFrom(opts);
  var lossMode = cfg.stop_after_first_loss[ticker] || "off";
  var recrossMode = cfg.orb_recross_skip[ticker] || "off";
  var widthMode = (cfg.orb_width_skip && cfg.orb_width_skip[ticker]) || "off";
  if (lossMode === "off" && recrossMode === "off" && widthMode === "off") {
    return { block: false, shadowIds: [], triggers: [], transitions: null, widthPct: null };
  }

  var date = todayISO(opts.date);
  var lossToday = opts.lossToday != null
    ? !!opts.lossToday
    : (opts.channel ? hasPaperLoss(opts.channel, date) : hasLossToday(ticker, date));
  var transitions = null;
  var or = resolveOr(ticker, opts);
  var asOf = asOfMinutes(opts);
  var widthPct = null;
  if (recrossMode !== "off") transitions = recrossCount(ticker, date);
  if (widthMode !== "off") {
    if (or) widthPct = orbWidthPct(or.high, or.low);
    if (widthPct == null) {
      var miss = ticker + " orb_width_skip not evaluated — opening range unavailable";
      try { require("./state").logEvent("FILTER", miss); }
      catch (e) { console.log("[FILTER] " + miss); }
    }
  }

  var min = cfg.orb_recross_min;
  var triggers = triggersFor(lossMode, recrossMode, lossToday, transitions, min);
  var breach = widthMode !== "off" && widthPct != null ? widthBreach(ticker, widthPct, cfg) : null;
  if (breach) {
    var cmp = breach.bound === "max" ? ">" : "<";
    triggers.push({
      filter: "orb_width_skip",
      mode: widthMode,
      bound: breach.bound,
      limit: breach.limit,
      widthPct: breach.width,
      detail: "OR width " + breach.width + "% " + cmp + " " + breach.bound + " " + breach.limit + "%"
    });
  }
  var block = triggers.some(function(tr) { return tr.mode === "on"; });
  var shadowIds = [];
  triggers.forEach(function(tr) {
    var id = appendShadow({
      date: date,
      ticker: ticker,
      filter: tr.filter,
      mode: tr.mode,
      blocked: tr.mode === "on",
      wouldBlock: true,
      action: tr.mode === "on" ? "blocked" : "would_block",
      trade: buildTrade(opts, or, tr, transitions, min),
      pnl: null
    });
    shadowIds.push(id);
    logFilter(ticker, tr, opts.side, transitions, min, asOf, block);
  });
  return { block: block, shadowIds: shadowIds, triggers: triggers, transitions: transitions, widthPct: widthPct };
}

function annotateOpenTrade(ids, patch) {
  if (!ids || !ids.length || !patch) return;
  var data = loadShadow();
  var changed = false;
  data.records.forEach(function(r) {
    if (ids.indexOf(r.id) === -1) return;
    r.trade = r.trade || {};
    ["side", "strike", "expiry", "entryPrice", "contracts", "entryTime", "orbHigh", "orbLow", "channel"].forEach(function(k) {
      if (patch[k] != null && patch[k] !== "") {
        r.trade[k] = patch[k];
        changed = true;
      }
    });
  });
  if (changed) saveShadow();
}

function annotateFromPosition(ids, ticker) {
  if (!ids || !ids.length) return;
  try {
    var state = require("./state");
    var key = canon(ticker) || ticker;
    var pos = state.getPosition(key) || state.getPosition(ticker);
    if (!pos) return;
    var patch = {};
    if (pos.strike != null) patch.strike = pos.strike;
    if (pos.expiry) patch.expiry = pos.expiry;
    if (pos.entryPrice) patch.entryPrice = pos.entryPrice;
    if (pos.contracts != null) patch.contracts = pos.contracts;
    if (pos.side) patch.side = pos.side;
    if (pos.openedAtMs) patch.entryTime = new Date(pos.openedAtMs).toISOString();
    var orb = (state.getState().orb || {})[key];
    if (orb && orb.high != null) patch.orbHigh = orb.high;
    if (orb && orb.low != null) patch.orbLow = orb.low;
    annotateOpenTrade(ids, patch);
  } catch (e) {
    console.log("[FILTER] annotate failed: " + e.message);
  }
}

function noteClosedPnl(ticker, pnl, extra) {
  extra = extra || {};
  var t = canon(ticker);
  if (!t) return;
  var n = parseFloat(pnl);
  if (!isFinite(n)) return;
  var date = todayISO(extra.date);
  if (n < 0) {
    if (extra.paper || extra.channel) {
      if (extra.channel) markScoped(paperLossKey(extra.channel), date);
    } else {
      markLoss(t, date);
    }
  }
  var ids = extra.shadowIds;
  if (!ids || !ids.length) return;
  var data = loadShadow();
  var changed = false;
  data.records.forEach(function(r) {
    if (ids.indexOf(r.id) === -1) return;
    if (r.pnl == null || !isFinite(parseFloat(r.pnl))) r.pnl = 0;
    r.pnl = Math.round((parseFloat(r.pnl) + n) * 100) / 100;
    r.pnlAt = new Date().toISOString();
    r.trade = r.trade || {};
    if (r.trade.strike == null && extra.strike != null) r.trade.strike = extra.strike;
    if (!r.trade.expiry && extra.expiry) r.trade.expiry = extra.expiry;
    if (!r.trade.entryTime && extra.entryTime) r.trade.entryTime = extra.entryTime;
    if (r.trade.orbHigh == null && extra.orbHigh != null) r.trade.orbHigh = extra.orbHigh;
    if (r.trade.orbLow == null && extra.orbLow != null) r.trade.orbLow = extra.orbLow;
    changed = true;
  });
  if (changed) saveShadow();
}

function getRecords() {
  return loadShadow().records.slice();
}

function resetForTests() {
  _loss = null;
  _shadow = null;
  try { fs.unlinkSync(shadowFile()); } catch (e) {}
  try { fs.unlinkSync(lossFile()); } catch (e) {}
}

module.exports = {
  OR_START_MIN: OR_START_MIN,
  WINDOW_START_MIN: WINDOW_START_MIN,
  WINDOW_END_MIN: WINDOW_END_MIN,
  canon: canon,
  zone: zone,
  countOrbRecrosses: countOrbRecrosses,
  barsFromYahooChart: barsFromYahooChart,
  hasLossToday: hasLossToday,
  hasPaperLoss: hasPaperLoss,
  markLoss: markLoss,
  noteBreakout: noteBreakout,
  recrossCount: recrossCount,
  orbWidthPct: orbWidthPct,
  checkEntry: checkEntry,
  annotateOpenTrade: annotateOpenTrade,
  annotateFromPosition: annotateFromPosition,
  noteClosedPnl: noteClosedPnl,
  getRecords: getRecords,
  resetForTests: resetForTests,
  shadowFile: shadowFile,
  lossFile: lossFile
};
