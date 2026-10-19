var fs = require("fs");
var persist = require("./persist");

var PNL_FILE = persist.filePath("orb-pnl.json");
var OPTIONAL_FIELDS = ["entryTime", "strike", "expiry", "orbHigh", "orbLow"];

function pnlFile() {
  return process.env.ORB_PNL_FILE || PNL_FILE;
}

function autoTradeFields(ticker) {
  var fields = {};
  try {
    var stateModule = require("./state");
    var key = String(ticker || "").toUpperCase();
    if (key === "SPXW") key = "SPX";
    var pos = stateModule.getPosition(key) || stateModule.getPosition(ticker);
    var orbMap = (stateModule.getState().orb || {});
    var orb = orbMap[key] || orbMap[ticker] || {};
    if (pos) {
      if (pos.openedAtMs) fields.entryTime = new Date(pos.openedAtMs).toISOString();
      if (pos.strike != null) fields.strike = pos.strike;
      if (pos.expiry) fields.expiry = pos.expiry;
      if (pos.filterShadowIds && pos.filterShadowIds.length) fields.shadowIds = pos.filterShadowIds.slice();
    }
    if (orb.high != null) fields.orbHigh = orb.high;
    if (orb.low != null) fields.orbLow = orb.low;
  } catch (e) {}
  return fields;
}

function etYmd(date) {
  return (date || new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function logTradePnL(ticker, side, entryPrice, exitPrice, contracts, extra) {
  try {
    var file = pnlFile();
    var data = { trades: [] };
    if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data.trades) data.trades = [];
    var pnl = (parseFloat(exitPrice) - parseFloat(entryPrice)) * contracts * 100;
    var rec = {
      time: new Date().toISOString(),
      ticker: ticker,
      side: side,
      entryPrice: entryPrice,
      exitPrice: exitPrice,
      contracts: contracts,
      pnl: pnl
    };
    var fields = Object.assign({}, autoTradeFields(ticker));
    if (extra && typeof extra === "object") {
      OPTIONAL_FIELDS.forEach(function(k) {
        if (extra[k] != null && extra[k] !== "") fields[k] = extra[k];
      });
      if (extra.shadowIds && extra.shadowIds.length) fields.shadowIds = extra.shadowIds;
      if (extra.date) fields.date = extra.date;
    }
    OPTIONAL_FIELDS.forEach(function(k) {
      if (fields[k] != null && fields[k] !== "") rec[k] = fields[k];
    });
    data.trades.push(rec);
    var yearAgo = new Date();
    yearAgo.setFullYear(yearAgo.getFullYear() - 1);
    data.trades = data.trades.filter(function(t) { return new Date(t.time) >= yearAgo; });
    fs.writeFileSync(file, JSON.stringify(data));
    try {
      require("./choppyFilters").noteClosedPnl(ticker, pnl, {
        date: fields.date,
        shadowIds: fields.shadowIds,
        strike: rec.strike,
        expiry: rec.expiry,
        entryTime: rec.entryTime,
        orbHigh: rec.orbHigh,
        orbLow: rec.orbLow
      });
    } catch (filterErr) {
      console.log("[PNL_ERROR] filter note failed: " + filterErr.message);
    }
  } catch (e) {
    console.log("[PNL_ERROR]", e.message);
  }
}

function aggregatePnL() {
  try {
    var file = pnlFile();
    if (!fs.existsSync(file)) return { daily: null, weekly: null, monthly: null, yearly: null };
    var data = JSON.parse(fs.readFileSync(file, "utf8"));
    var now = new Date();
    var todayEt = etYmd(now);
    var daily = 0, weekly = 0, monthly = 0, yearly = 0;
    var hasData = false;
    (data.trades || []).forEach(function(t) {
      var d = new Date(t.time);
      var pnl = parseFloat(t.pnl) || 0;
      if (etYmd(d) === todayEt) { daily += pnl; hasData = true; }
      var weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 7);
      if (d >= weekAgo) { weekly += pnl; hasData = true; }
      var monthAgo = new Date(now); monthAgo.setMonth(monthAgo.getMonth() - 1);
      if (d >= monthAgo) { monthly += pnl; hasData = true; }
      var yearAgo = new Date(now); yearAgo.setFullYear(yearAgo.getFullYear() - 1);
      if (d >= yearAgo) { yearly += pnl; hasData = true; }
    });
    return hasData ? { daily: daily, weekly: weekly, monthly: monthly, yearly: yearly }
                    : { daily: null, weekly: null, monthly: null, yearly: null };
  } catch (e) {
    console.log("[PNL_ERROR]", e.message);
    return { daily: null, weekly: null, monthly: null, yearly: null };
  }
}

module.exports = { logTradePnL: logTradePnL, aggregatePnL: aggregatePnL, PNL_FILE: PNL_FILE };
