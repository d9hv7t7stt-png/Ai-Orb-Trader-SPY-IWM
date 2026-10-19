// utils/settings.js
// App settings persisted to durable storage (survives redeploys when a Railway
// volume is attached). Holds per-ticker DTE plus the choppy-day entry filters.

var fs = require("fs");
var persist = require("./persist");
var FILE = persist.filePath("orb-settings.json");

var FILTER_TICKERS = ["SPY", "IWM", "QQQ", "SPX"];
var FILTER_MODES = { off: true, shadow: true, on: true };
// Missing keys fall back to these. Live by default; QQQ and SPX stay out of
// the re-cross filter until turned on.
var DEFAULT_STOP_AFTER_FIRST_LOSS = { SPY: "on", IWM: "on", QQQ: "on", SPX: "on" };
var DEFAULT_ORB_RECROSS_SKIP = { SPY: "on", IWM: "on", QQQ: "off", SPX: "off" };
var DEFAULT_ORB_RECROSS_MIN = 2;
var DEFAULT_ORB_WIDTH_SKIP = { SPY: "on", IWM: "on", QQQ: "on", SPX: "off" };
// null means that bound is not applied. SPY/QQQ skip a wide open; IWM skips a narrow one.
var DEFAULT_ORB_WIDTH_MAX = { SPY: 0.15, IWM: null, QQQ: 0.35, SPX: null };
var DEFAULT_ORB_WIDTH_MIN = { SPY: null, IWM: 0.30, QQQ: null, SPX: null };

var DEFAULTS = {
  dte: { SPY: 1, IWM: 0 },
  trading_enabled: true,
  dual_leg_live: false,
  cross_entry_enabled: true,
  // Per-ticker live buys (entries/adds). Stops/exits still run when off.
  buy_enabled: { SPY: true, IWM: true, SPX: true },
  stop_after_first_loss: { SPY: "on", IWM: "on", QQQ: "on", SPX: "on" },
  orb_recross_skip: { SPY: "on", IWM: "on", QQQ: "off", SPX: "off" },
  orb_recross_min: DEFAULT_ORB_RECROSS_MIN,
  orb_width_skip: { SPY: "on", IWM: "on", QQQ: "on", SPX: "off" },
  orb_width_max: { SPY: 0.15, IWM: null, QQQ: 0.35, SPX: null },
  orb_width_min: { SPY: null, IWM: 0.30, QQQ: null, SPX: null }
};

function normalizeModeMap(map, defaults) {
  var src = map && typeof map === "object" ? map : {};
  var out = {};
  FILTER_TICKERS.forEach(function(t) {
    var v = src[t];
    if (typeof v === "string" && FILTER_MODES[String(v).toLowerCase()]) out[t] = String(v).toLowerCase();
    else out[t] = defaults[t];
  });
  return out;
}

function normalizeRecrossMin(v) {
  var n = parseInt(v, 10);
  if (!isFinite(n) || n < 1 || n > 20) return DEFAULT_ORB_RECROSS_MIN;
  return n;
}

function normalizeBoundMap(map, defaults) {
  var src = map && typeof map === "object" ? map : null;
  var out = {};
  FILTER_TICKERS.forEach(function(t) {
    if (src && Object.prototype.hasOwnProperty.call(src, t)) {
      if (src[t] == null || src[t] === "") out[t] = null;
      else {
        var n = parseFloat(src[t]);
        out[t] = isFinite(n) && n >= 0 ? n : (defaults[t] != null ? defaults[t] : null);
      }
    } else {
      out[t] = defaults[t] != null ? defaults[t] : null;
    }
  });
  return out;
}

function mergeBoundMap(cur, partial) {
  if (!partial || typeof partial !== "object") return cur;
  FILTER_TICKERS.forEach(function(t) {
    if (!Object.prototype.hasOwnProperty.call(partial, t)) return;
    if (partial[t] == null || partial[t] === "") cur[t] = null;
    else {
      var n = parseFloat(partial[t]);
      if (isFinite(n) && n >= 0) cur[t] = n;
    }
  });
  return cur;
}

// Pure. Does not write orb-settings.json and does not mutate raw.
function resolveFilterSettings(raw) {
  raw = raw || {};
  return {
    stop_after_first_loss: normalizeModeMap(raw.stop_after_first_loss, DEFAULT_STOP_AFTER_FIRST_LOSS),
    orb_recross_skip: normalizeModeMap(raw.orb_recross_skip, DEFAULT_ORB_RECROSS_SKIP),
    orb_recross_min: normalizeRecrossMin(raw.orb_recross_min),
    orb_width_skip: normalizeModeMap(raw.orb_width_skip, DEFAULT_ORB_WIDTH_SKIP),
    orb_width_max: normalizeBoundMap(raw.orb_width_max, DEFAULT_ORB_WIDTH_MAX),
    orb_width_min: normalizeBoundMap(raw.orb_width_min, DEFAULT_ORB_WIDTH_MIN)
  };
}

function deepDefault() { return JSON.parse(JSON.stringify(DEFAULTS)); }

function normalizeBuyEnabled(map) {
  map = map || {};
  return {
    SPY: map.SPY !== false,
    IWM: map.IWM !== false,
    SPX: map.SPX !== false
  };
}

function normalize(s) {
  s = s || {};
  s.dte = s.dte || {};
  if (typeof s.dte.SPY !== "number") s.dte.SPY = DEFAULTS.dte.SPY;
  if (typeof s.dte.IWM !== "number") s.dte.IWM = DEFAULTS.dte.IWM;
  if (typeof s.trading_enabled !== "boolean") s.trading_enabled = DEFAULTS.trading_enabled;
  if (typeof s.dual_leg_live !== "boolean") s.dual_leg_live = DEFAULTS.dual_leg_live;
  if (typeof s.cross_entry_enabled !== "boolean") s.cross_entry_enabled = DEFAULTS.cross_entry_enabled;
  s.buy_enabled = normalizeBuyEnabled(s.buy_enabled);
  var filters = resolveFilterSettings(s);
  s.stop_after_first_loss = filters.stop_after_first_loss;
  s.orb_recross_skip = filters.orb_recross_skip;
  s.orb_recross_min = filters.orb_recross_min;
  s.orb_width_skip = filters.orb_width_skip;
  s.orb_width_max = filters.orb_width_max;
  s.orb_width_min = filters.orb_width_min;
  return s;
}

function load() {
  try {
    if (fs.existsSync(FILE)) return normalize(JSON.parse(fs.readFileSync(FILE, "utf8")));
  } catch (e) { console.log("[SETTINGS] load failed: " + e.message); }
  return deepDefault();
}

var settings = load();

function save() {
  try { fs.writeFileSync(FILE, JSON.stringify(settings)); }
  catch (e) { console.log("[SETTINGS] save failed: " + e.message); }
}

function getDTE(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPX" || t === "SPXW") t = "SPY";
  var v = settings.dte[t];
  return typeof v === "number" ? v : (t === "SPY" ? 1 : 0);
}

function setDTE(ticker, val) {
  var n = parseInt(val, 10);
  if (isNaN(n) || n < 0 || n > 5) return getDTE(ticker);
  settings.dte[ticker] = n;
  save();
  return n;
}

function getFilterConfig() {
  return resolveFilterSettings(settings);
}

function setFilterConfig(partial) {
  partial = partial || {};
  var cur = getFilterConfig();
  if (partial.stop_after_first_loss && typeof partial.stop_after_first_loss === "object") {
    FILTER_TICKERS.forEach(function(t) {
      if (partial.stop_after_first_loss[t] === undefined) return;
      var m = String(partial.stop_after_first_loss[t]).toLowerCase();
      if (FILTER_MODES[m]) cur.stop_after_first_loss[t] = m;
    });
  }
  if (partial.orb_recross_skip && typeof partial.orb_recross_skip === "object") {
    FILTER_TICKERS.forEach(function(t) {
      if (partial.orb_recross_skip[t] === undefined) return;
      var m = String(partial.orb_recross_skip[t]).toLowerCase();
      if (FILTER_MODES[m]) cur.orb_recross_skip[t] = m;
    });
  }
  if (partial.orb_recross_min !== undefined) cur.orb_recross_min = normalizeRecrossMin(partial.orb_recross_min);
  if (partial.orb_width_skip && typeof partial.orb_width_skip === "object") {
    FILTER_TICKERS.forEach(function(t) {
      if (partial.orb_width_skip[t] === undefined) return;
      var m = String(partial.orb_width_skip[t]).toLowerCase();
      if (FILTER_MODES[m]) cur.orb_width_skip[t] = m;
    });
  }
  cur.orb_width_max = mergeBoundMap(cur.orb_width_max, partial.orb_width_max);
  cur.orb_width_min = mergeBoundMap(cur.orb_width_min, partial.orb_width_min);
  settings.stop_after_first_loss = cur.stop_after_first_loss;
  settings.orb_recross_skip = cur.orb_recross_skip;
  settings.orb_recross_min = cur.orb_recross_min;
  settings.orb_width_skip = cur.orb_width_skip;
  settings.orb_width_max = cur.orb_width_max;
  settings.orb_width_min = cur.orb_width_min;
  save();
  return getFilterConfig();
}

function getAll() {
  var filters = getFilterConfig();
  return {
    dte: { SPY: getDTE("SPY"), IWM: getDTE("IWM") },
    trading_enabled: isTradingEnabled(),
    dual_leg_live: isDualLegLive(),
    cross_entry_enabled: isCrossEntryEnabled(),
    buy_enabled: getBuyEnabled(),
    stop_after_first_loss: filters.stop_after_first_loss,
    orb_recross_skip: filters.orb_recross_skip,
    orb_recross_min: filters.orb_recross_min,
    orb_width_skip: filters.orb_width_skip,
    orb_width_max: filters.orb_width_max,
    orb_width_min: filters.orb_width_min,
    durable: persist.isDurable()
  };
}

function isTradingEnabled() {
  return settings.trading_enabled !== false;
}

function setTradingEnabled(on) {
  settings.trading_enabled = !!on;
  save();
  return settings.trading_enabled;
}

function isDualLegLive() {
  return settings.dual_leg_live === true;
}

function setDualLegLive(on) {
  settings.dual_leg_live = !!on;
  save();
  return settings.dual_leg_live;
}

function isCrossEntryEnabled() {
  return settings.cross_entry_enabled !== false;
}

function setCrossEntryEnabled(on) {
  settings.cross_entry_enabled = !!on;
  save();
  return settings.cross_entry_enabled;
}

function buyTickerKey(ticker) {
  var t = String(ticker || "").toUpperCase();
  if (t === "SPXW") t = "SPX";
  if (t === "SPY" || t === "IWM" || t === "SPX") return t;
  return null;
}

function getBuyEnabled() {
  return normalizeBuyEnabled(settings.buy_enabled);
}

function isBuyEnabled(ticker) {
  var key = buyTickerKey(ticker);
  if (!key) return true;
  var map = getBuyEnabled();
  return map[key] !== false;
}

function setBuyEnabled(ticker, on) {
  var key = buyTickerKey(ticker);
  if (!key) return getBuyEnabled();
  settings.buy_enabled = normalizeBuyEnabled(settings.buy_enabled);
  settings.buy_enabled[key] = !!on;
  save();
  return getBuyEnabled();
}

function setBuyEnabledMap(map) {
  var cur = getBuyEnabled();
  if (!map || typeof map !== "object") return cur;
  ["SPY", "IWM", "SPX"].forEach(function(t) {
    if (map[t] !== undefined) cur[t] = !!map[t];
  });
  settings.buy_enabled = normalizeBuyEnabled(cur);
  save();
  return getBuyEnabled();
}

module.exports = {
  getDTE: getDTE,
  setDTE: setDTE,
  getAll: getAll,
  isTradingEnabled: isTradingEnabled,
  setTradingEnabled: setTradingEnabled,
  isDualLegLive: isDualLegLive,
  setDualLegLive: setDualLegLive,
  isCrossEntryEnabled: isCrossEntryEnabled,
  setCrossEntryEnabled: setCrossEntryEnabled,
  getBuyEnabled: getBuyEnabled,
  isBuyEnabled: isBuyEnabled,
  setBuyEnabled: setBuyEnabled,
  setBuyEnabledMap: setBuyEnabledMap,
  resolveFilterSettings: resolveFilterSettings,
  getFilterConfig: getFilterConfig,
  setFilterConfig: setFilterConfig,
  FILE: FILE
};
