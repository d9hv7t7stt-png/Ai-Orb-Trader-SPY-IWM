// QQQ paper Discord channel — Hermes Best Win Rate breakouts via Yahoo 1-minute bars.
// SPY / IWM / SPX are not touched. Disable with QQQ_YAHOO_SIGNALS=0.
//
// Does not emit ORB-mid stops. The QQQ paper option stop stays in exitlogic (−15%).
// Entries go straight to the qqq paper channel (not the shared webhook, which would
// also flip, retest, and midpoint-stop).

var fs = require("fs");
var yahoo = require("./yahoo");
var exitlogic = require("./exitlogic");
var stateModule = require("./state");
var persist = require("./persist");
var paperLegs = require("./paperLegs");
var bwr = require("./qqqBestWinRate");

var TICKER = "QQQ";
var POLL_MS = 10000;
var STATE_FILE = persist.filePath("qqq-yahoo-signals.json");

var busy = false;
var _state = { date: null, consumedEndMins: [], orbKey: null, widthLogged: false };

function enabled() {
  return process.env.QQQ_YAHOO_SIGNALS !== "0";
}

function etDate() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      var d = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      if (d && typeof d === "object") _state = d;
    }
  } catch (e) {}
  if (!_state.consumedEndMins) _state.consumedEndMins = [];
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state));
  } catch (e) {
    console.log("[QQQ_BWR] state save failed: " + e.message);
  }
}

function resetStateIfNewDay() {
  var today = etDate();
  if (_state.date !== today) {
    _state = { date: today, consumedEndMins: [], orbKey: null, widthLogged: false };
    saveState();
  }
}

function getQqqPaperSide() {
  try {
    var discord = require("./discord");
    if (typeof discord.getChannels !== "function") return null;
    var chans = discord.getChannels();
    for (var i = 0; i < chans.length; i++) {
      if (chans[i].cfg.id !== "qqq") continue;
      var keys = paperLegs.listLegsForTrade(chans[i].account.positions, TICKER);
      if (!keys.length) return null;
      var pos = chans[i].account.positions[keys[0]];
      return pos && pos.contracts > 0 ? pos.side : null;
    }
  } catch (e) {}
  return null;
}

function remember(endMin) {
  if (_state.consumedEndMins.indexOf(endMin) === -1) _state.consumedEndMins.push(endMin);
}

async function publishOrb(range) {
  var key = range.high.toFixed(4) + "|" + range.low.toFixed(4);
  if (_state.orbKey === key) return;
  stateModule.setORB(TICKER, range.high, range.low, "yahoo-1m");
  _state.orbKey = key;
  saveState();
  try {
    var discord = require("./discord");
    if (typeof discord.onOrbSet === "function") {
      await discord.onOrbSet(TICKER, range.high, range.low, range.mid, "yahoo-1m");
    }
  } catch (e) {
    console.log("[QQQ_BWR] ORB announce failed: " + e.message);
  }
}

async function enterPaper(decision) {
  var discord = require("./discord");
  var ev = decision.event;
  stateModule.logEvent("QQQ_BWR", ev.event + " @ $" + Number(ev.close).toFixed(2) +
    " (15m close x2, bar end " + ev.endMin + " ET min) OR $" +
    decision.orb.low.toFixed(2) + "-$" + decision.orb.high.toFixed(2));
  var opened = false;
  if (typeof discord.onEntry === "function") {
    opened = await discord.onEntry(TICKER, ev.side, 0, decision.orb.high, decision.orb.low, ev.close, {
      channelIds: ["qqq"]
    });
  }
  console.log("[QQQ_BWR]", ev.event, opened ? "paper entry sent" : "paper entry skipped");
  return !!opened;
}

// nowSec is injectable for tests. Returns the session decision (and enters when asked).
async function evaluateChart(chart, nowSec, opts) {
  opts = opts || {};
  resetStateIfNewDay();
  var now = nowSec != null ? nowSec : Date.now() / 1000;
  var bars = bwr.parseChartBars(chart);
  var range = bwr.openingRange(bars);
  if (!range) return null;
  var blocks = bwr.aggregateBlocks(bars, now);
  var inPosition = opts.inPosition != null ? !!opts.inPosition : !!getQqqPaperSide();
  var session = bwr.evaluateSession(range, blocks, {
    nowSec: now,
    inPosition: inPosition,
    consumedEndMins: _state.consumedEndMins
  });
  session.orb = range;

  if (!opts.dryRun) await publishOrb(range);

  if (session.skipDay && !_state.widthLogged) {
    _state.widthLogged = true;
    stateModule.logEvent("QQQ_BWR", "OR width " + session.widthPct +
      "% > " + bwr.WIDTH_CAP_PCT + "% — no QQQ paper trade today");
    console.log("[QQQ_BWR] width skip " + session.widthPct + "%");
  }

  var entered = false;
  for (var i = 0; i < session.actions.length; i++) {
    var action = session.actions[i];
    if (action.take) {
      if (opts.dryRun) {
        session.wouldEnter = action;
        continue;
      }
      entered = await enterPaper(session);
      if (entered) remember(action.endMin);
      else if (isFinite(now) && isFinite(action.endTs) && (now - action.endTs) > bwr.ENTRY_GRACE_MINUTES * 60) {
        remember(action.endMin);
      }
      continue;
    }
    if (action.consume && !opts.dryRun) remember(action.endMin);
  }
  if (!opts.dryRun) saveState();
  session.entered = entered;
  return session;
}

async function poll() {
  if (!enabled()) return null;
  if (!exitlogic.isTradingDayET()) return null;
  if (!exitlogic.isRegularMarketHours()) return null;
  if (exitlogic.etMinutesOfDay() < bwr.OR_END_MIN) return null;
  if (busy) return null;
  busy = true;
  try {
    var chart = await yahoo.getChart(TICKER, "1m", "1d");
    return await evaluateChart(chart, Date.now() / 1000);
  } catch (e) {
    console.log("[QQQ_BWR_ERROR]", e.message);
    return null;
  } finally {
    busy = false;
  }
}

function startQqqYahooSignals() {
  loadState();
  resetStateIfNewDay();
  if (!enabled()) {
    console.log("[QQQ_BWR] disabled (QQQ_YAHOO_SIGNALS=0)");
    return;
  }
  console.log("[QQQ_BWR] QQQ paper Best Win Rate via Yahoo 1m (poll " + (POLL_MS / 1000) +
    "s) — 15m x2, 0.05% buffer, width cap " + bwr.WIDTH_CAP_PCT +
    "%, entry bar-end before 10:30 ET, grace " + bwr.ENTRY_GRACE_MINUTES + "m");
  setInterval(poll, POLL_MS);
  setTimeout(poll, 20000);
}

module.exports = {
  enabled: enabled,
  startQqqYahooSignals: startQqqYahooSignals,
  poll: poll,
  evaluateChart: evaluateChart,
  getQqqPaperSide: getQqqPaperSide,
  resetStateIfNewDay: resetStateIfNewDay
};
