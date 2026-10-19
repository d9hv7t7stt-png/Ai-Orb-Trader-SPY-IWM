// Choppy-day filters: OR re-cross counting, 10:15 cutoff, loss-day reset, modes.
var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var dir = fs.mkdtempSync(path.join(os.tmpdir(), "choppy-filters-"));
process.env.FILTER_SHADOW_FILE = path.join(dir, "filter-shadow.json");
process.env.FILTER_STATE_FILE = path.join(dir, "choppy-filter-state.json");
process.env.ORB_PNL_FILE = path.join(dir, "orb-pnl.json");

var filters = require("../utils/choppyFilters");
var settings = require("../utils/settings");
var pnl = require("../utils/pnl");
var orb = require("../utils/orb");

var passed = 0;
var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

function recrossBars() {
  return [
    { startMin: 9 * 60 + 30, close: 99.4 },
    { startMin: 9 * 60 + 35, close: 101 },
    { startMin: 9 * 60 + 40, close: 99.5 },
    { startMin: 9 * 60 + 45, close: 98 },
    { startMin: 9 * 60 + 50, close: 101 },
    { startMin: 10 * 60 + 10, close: 99.2 },
    { startMin: 10 * 60 + 15, close: 98 },
    { startMin: 11 * 60, close: 102 }
  ];
}

function flatBars() {
  return [
    { startMin: 9 * 60 + 35, close: 101 },
    { startMin: 9 * 60 + 40, close: 102 },
    { startMin: 10 * 60 + 10, close: 103 }
  ];
}

function allOff() {
  var off = { SPY: "off", IWM: "off", QQQ: "off", SPX: "off" };
  return settings.resolveFilterSettings({
    stop_after_first_loss: off,
    orb_recross_skip: off
  });
}

function spyModes(lossMode, recrossMode, min) {
  var cfg = settings.resolveFilterSettings({ orb_recross_min: min == null ? 2 : min });
  cfg.stop_after_first_loss.SPY = lossMode;
  cfg.orb_recross_skip.SPY = recrossMode;
  return cfg;
}

test("re-cross count ignores the 9:30 OR bar and equals-boundary closes", function() {
  var orHigh = 100;
  var orLow = 99;
  assert.strictEqual(filters.zone(100, orHigh, orLow), 0);
  assert.strictEqual(filters.zone(99, orHigh, orLow), 0);
  assert.strictEqual(filters.zone(100.01, orHigh, orLow), 1);
  assert.strictEqual(filters.zone(98.99, orHigh, orLow), -1);
  assert.strictEqual(filters.countOrbRecrosses([
    { startMin: 9 * 60 + 30, close: 101 },
    { startMin: 9 * 60 + 35, close: 99.5 },
    { startMin: 9 * 60 + 40, close: 99.4 }
  ], orHigh, orLow, 10 * 60), 0);
  assert.strictEqual(filters.countOrbRecrosses([
    { startMin: 9 * 60 + 40, close: 98 },
    { startMin: 9 * 60 + 35, close: 101 }
  ], orHigh, orLow, 10 * 60), 1);
  assert.strictEqual(filters.countOrbRecrosses([], orHigh, orLow, 11 * 60), 0);
  assert.strictEqual(filters.countOrbRecrosses([
    { startMin: 9 * 60 + 35, close: 101 }
  ], orHigh, orLow, 16 * 60), 0);
});

test("re-crosses reach 2 at 9:50 and freeze at 10:15", function() {
  var bars = recrossBars();
  var orHigh = 100;
  var orLow = 99;
  assert.strictEqual(filters.countOrbRecrosses(bars, orHigh, orLow, 9 * 60 + 40), 0);
  assert.strictEqual(filters.countOrbRecrosses(bars, orHigh, orLow, 9 * 60 + 45), 1);
  assert.strictEqual(filters.countOrbRecrosses(bars, orHigh, orLow, 9 * 60 + 50), 2);
  assert.strictEqual(filters.countOrbRecrosses(bars, orHigh, orLow, 10 * 60 + 15), 4);
  assert.strictEqual(filters.countOrbRecrosses(bars, orHigh, orLow, 15 * 60), 4);
  var under = [
    { startMin: 9 * 60 + 35, close: 101 },
    { startMin: 9 * 60 + 40, close: 99.5 },
    { startMin: 10 * 60 + 15, close: 98 },
    { startMin: 10 * 60 + 20, close: 101 },
    { startMin: 10 * 60 + 25, close: 98 }
  ];
  assert.strictEqual(filters.countOrbRecrosses(under, orHigh, orLow, 12 * 60), 1);
});

test("yahoo bars use ET bar starts and the 10:15 bar stays out of the count", function() {
  function etUnix(hour, minute) {
    return Date.UTC(2026, 9, 19, hour + 4, minute, 0) / 1000;
  }
  assert.strictEqual(orb.barStartMinutesET(etUnix(9, 30)), 9 * 60 + 30);
  assert.strictEqual(orb.barStartMinutesET(etUnix(10, 15)), 10 * 60 + 15);
  var chart = {
    chart: {
      result: [{
        timestamp: [etUnix(9, 30), etUnix(9, 35), etUnix(9, 40), etUnix(10, 15)],
        indicators: { quote: [{ close: [99.5, 101, 98, 99.2] }] }
      }]
    }
  };
  var bars = filters.barsFromYahooChart(chart);
  assert.strictEqual(bars.length, 4);
  assert.strictEqual(filters.countOrbRecrosses(bars, 100, 99, 16 * 60), 1);
});

test("before 10:15 a live filter blocks only once the threshold is hit", async function() {
  filters.resetForTests();
  var early = await filters.checkEntry({
    ticker: "SPY",
    side: "put",
    event: "breakout_short",
    date: "2026-10-19",
    asOfMin: 9 * 60 + 45,
    orbHigh: 100,
    orbLow: 99,
    bars: recrossBars(),
    settings: spyModes("off", "on")
  });
  assert.strictEqual(early.transitions, 1);
  assert.strictEqual(early.block, false);
  assert.strictEqual(filters.getRecords().length, 0);

  var hit = await filters.checkEntry({
    ticker: "SPY",
    side: "put",
    event: "breakout_short",
    date: "2026-10-19",
    asOfMin: 9 * 60 + 50,
    orbHigh: 100,
    orbLow: 99,
    bars: recrossBars(),
    settings: spyModes("off", "on")
  });
  assert.strictEqual(hit.transitions, 2);
  assert.strictEqual(hit.block, true);
  assert.strictEqual(filters.getRecords().length, 1);
  assert.strictEqual(filters.getRecords()[0].filter, "orb_recross_skip");
  assert.strictEqual(filters.getRecords()[0].blocked, true);
  assert.strictEqual(filters.getRecords()[0].action, "blocked");
  assert.strictEqual(filters.getRecords()[0].pnl, null);
  assert.strictEqual(filters.getRecords()[0].trade.transitions, 2);
  assert.strictEqual(filters.getRecords()[0].trade.minTransitions, 2);

  filters.resetForTests();
  var afterCutoff = await filters.checkEntry({
    ticker: "IWM",
    side: "call",
    event: "breakout_long",
    date: "2026-10-19",
    asOfMin: 12 * 60,
    orbHigh: 100,
    orbLow: 99,
    bars: [
      { startMin: 9 * 60 + 35, close: 101 },
      { startMin: 9 * 60 + 40, close: 99.5 },
      { startMin: 10 * 60 + 20, close: 98 },
      { startMin: 10 * 60 + 25, close: 101 }
    ],
    settings: settings.resolveFilterSettings({
      stop_after_first_loss: { SPY: "off", IWM: "off", QQQ: "off", SPX: "off" },
      orb_recross_skip: { SPY: "off", IWM: "on", QQQ: "off", SPX: "off" }
    })
  });
  assert.strictEqual(afterCutoff.transitions, 1);
  assert.strictEqual(afterCutoff.block, false);
  assert.strictEqual(filters.getRecords().length, 0);
});

test("stop after first loss resets on the next ET day and stays per ticker", async function() {
  filters.resetForTests();
  filters.noteClosedPnl("SPY", -25.5, { date: "2026-10-16" });
  assert.strictEqual(filters.hasLossToday("SPY", "2026-10-16"), true);
  assert.strictEqual(filters.hasLossToday("IWM", "2026-10-16"), false);
  assert.strictEqual(filters.hasLossToday("SPY", "2026-10-19"), false);

  var nextDay = await filters.checkEntry({
    ticker: "SPY",
    side: "call",
    event: "breakout_long",
    date: "2026-10-19",
    asOfMin: 11 * 60,
    orbHigh: 100,
    orbLow: 99,
    bars: flatBars(),
    settings: settings.resolveFilterSettings({})
  });
  assert.strictEqual(nextDay.block, false);
  assert.strictEqual(filters.getRecords().length, 0);

  filters.noteClosedPnl("IWM", -10, { date: "2026-10-19" });
  var iwm = await filters.checkEntry({
    ticker: "IWM",
    side: "put",
    event: "breakout_short",
    date: "2026-10-19",
    asOfMin: 11 * 60,
    orbHigh: 200,
    orbLow: 199,
    bars: flatBars(),
    settings: settings.resolveFilterSettings({})
  });
  assert.strictEqual(iwm.block, true);
  assert.strictEqual(iwm.triggers.length, 1);
  assert.strictEqual(iwm.triggers[0].filter, "stop_after_first_loss");

  var spy = await filters.checkEntry({
    ticker: "SPY",
    side: "call",
    event: "breakout_long",
    date: "2026-10-19",
    asOfMin: 11 * 60,
    orbHigh: 100,
    orbLow: 99,
    bars: flatBars(),
    settings: settings.resolveFilterSettings({})
  });
  assert.strictEqual(spy.block, false);
});

test("off does nothing, shadow allows and records, on blocks and still records", async function() {
  filters.resetForTests();
  var shared = {
    ticker: "SPY",
    side: "call",
    event: "breakout_long",
    date: "2026-10-19",
    asOfMin: 10 * 60 + 15,
    orbHigh: 100,
    orbLow: 99,
    bars: recrossBars(),
    contracts: 2,
    entryPrice: 1.5,
    lossToday: true
  };

  var off = await filters.checkEntry(Object.assign({}, shared, { settings: allOff() }));
  assert.strictEqual(off.block, false);
  assert.strictEqual(off.triggers.length, 0);
  assert.strictEqual(filters.getRecords().length, 0);

  var shadow = await filters.checkEntry(Object.assign({}, shared, {
    settings: spyModes("shadow", "shadow"),
    lossToday: false
  }));
  assert.strictEqual(shadow.block, false);
  assert.strictEqual(shadow.shadowIds.length, 1);
  assert.strictEqual(shadow.triggers[0].filter, "orb_recross_skip");
  var shadowRow = filters.getRecords()[0];
  assert.strictEqual(shadowRow.mode, "shadow");
  assert.strictEqual(shadowRow.blocked, false);
  assert.strictEqual(shadowRow.wouldBlock, true);
  assert.strictEqual(shadowRow.action, "would_block");
  assert.strictEqual(shadowRow.date, "2026-10-19");
  assert.strictEqual(shadowRow.ticker, "SPY");
  assert.strictEqual(shadowRow.trade.side, "call");
  assert.strictEqual(shadowRow.trade.orbHigh, 100);
  assert.strictEqual(shadowRow.trade.orbLow, 99);
  assert.strictEqual(shadowRow.pnl, null);

  filters.noteClosedPnl("SPY", 42.5, { date: "2026-10-19", shadowIds: shadow.shadowIds, strike: 571 });
  shadowRow = filters.getRecords()[0];
  assert.strictEqual(shadowRow.pnl, 42.5);
  assert.strictEqual(shadowRow.trade.strike, 571);
  assert.strictEqual(filters.hasLossToday("SPY", "2026-10-19"), false);

  filters.noteClosedPnl("SPY", -12.25, { date: "2026-10-19", shadowIds: shadow.shadowIds });
  shadowRow = filters.getRecords()[0];
  assert.strictEqual(shadowRow.pnl, 30.25);
  assert.strictEqual(filters.hasLossToday("SPY", "2026-10-19"), true);

  filters.resetForTests();
  var on = await filters.checkEntry(Object.assign({}, shared, {
    settings: spyModes("on", "off"),
    lossToday: true
  }));
  assert.strictEqual(on.block, true);
  assert.strictEqual(on.triggers[0].filter, "stop_after_first_loss");
  var onRow = filters.getRecords()[0];
  assert.strictEqual(onRow.mode, "on");
  assert.strictEqual(onRow.blocked, true);
  assert.strictEqual(onRow.action, "blocked");
  assert.strictEqual(onRow.pnl, null);
  assert.strictEqual(onRow.trade.event, "breakout_long");
});

test("SPX and QQQ re-cross stay off by default; a SPX loss still blocks SPX", async function() {
  filters.resetForTests();
  var defaults = settings.resolveFilterSettings({});
  assert.strictEqual(defaults.orb_recross_skip.SPY, "on");
  assert.strictEqual(defaults.orb_recross_skip.IWM, "on");
  assert.strictEqual(defaults.orb_recross_skip.QQQ, "off");
  assert.strictEqual(defaults.orb_recross_skip.SPX, "off");
  assert.strictEqual(defaults.stop_after_first_loss.QQQ, "on");
  assert.strictEqual(defaults.stop_after_first_loss.SPX, "on");

  var spx = await filters.checkEntry({
    ticker: "SPXW",
    side: "call",
    event: "entry",
    date: "2026-10-19",
    asOfMin: 15 * 60,
    orbHigh: 5000,
    orbLow: 4990,
    bars: recrossBars(),
    settings: defaults
  });
  assert.strictEqual(filters.canon("SPXW"), "SPX");
  assert.strictEqual(spx.block, false);
  assert.strictEqual(spx.transitions, null);

  filters.noteClosedPnl("SPXW", -1, { date: "2026-10-19" });
  var blocked = await filters.checkEntry({
    ticker: "SPX",
    side: "call",
    event: "entry",
    date: "2026-10-19",
    asOfMin: 15 * 60,
    orbHigh: 5000,
    orbLow: 4990,
    bars: recrossBars(),
    settings: defaults
  });
  assert.strictEqual(blocked.block, true);
  assert.strictEqual(blocked.triggers.length, 1);
  assert.strictEqual(blocked.triggers[0].filter, "stop_after_first_loss");
});

test("missing settings keys fall back to live defaults and do not rewrite an old file", function() {
  var old = {
    dte: { SPY: 1, IWM: 0 },
    trading_enabled: true,
    dual_leg_live: false,
    cross_entry_enabled: true,
    buy_enabled: { SPY: true, IWM: true, SPX: false }
  };
  var snapshot = JSON.parse(JSON.stringify(old));
  var resolved = settings.resolveFilterSettings(old);
  assert.deepStrictEqual(old, snapshot);
  assert.strictEqual(resolved.stop_after_first_loss.SPY, "on");
  assert.strictEqual(resolved.stop_after_first_loss.IWM, "on");
  assert.strictEqual(resolved.stop_after_first_loss.QQQ, "on");
  assert.strictEqual(resolved.stop_after_first_loss.SPX, "on");
  assert.strictEqual(resolved.orb_recross_skip.SPY, "on");
  assert.strictEqual(resolved.orb_recross_skip.IWM, "on");
  assert.strictEqual(resolved.orb_recross_skip.QQQ, "off");
  assert.strictEqual(resolved.orb_recross_skip.SPX, "off");
  assert.strictEqual(resolved.orb_recross_min, 2);

  var partial = settings.resolveFilterSettings({
    stop_after_first_loss: { SPY: "shadow", IWM: "nope" },
    orb_recross_skip: { QQQ: "ON" },
    orb_recross_min: 4
  });
  assert.strictEqual(partial.stop_after_first_loss.SPY, "shadow");
  assert.strictEqual(partial.stop_after_first_loss.IWM, "on");
  assert.strictEqual(partial.orb_recross_skip.QQQ, "on");
  assert.strictEqual(partial.orb_recross_skip.SPY, "on");
  assert.strictEqual(partial.orb_recross_min, 4);
  assert.strictEqual(settings.resolveFilterSettings({ orb_recross_min: 0 }).orb_recross_min, 2);

  var file = settings.FILE;
  var backup = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  try {
    fs.writeFileSync(file, JSON.stringify(old));
    delete require.cache[require.resolve("../utils/settings")];
    var fresh = require("../utils/settings");
    assert.strictEqual(fresh.getFilterConfig().stop_after_first_loss.SPY, "on");
    assert.strictEqual(fresh.getFilterConfig().orb_recross_skip.SPX, "off");
    assert.strictEqual(fresh.getFilterConfig().orb_recross_min, 2);
    assert.strictEqual(fresh.getAll().dte.SPY, 1);
    assert.strictEqual(fresh.getAll().buy_enabled.SPX, false);
    var disk = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(disk.stop_after_first_loss, undefined);
    assert.strictEqual(disk.orb_recross_skip, undefined);
    assert.strictEqual(disk.orb_recross_min, undefined);
    assert.strictEqual(disk.dte.SPY, 1);
    assert.strictEqual(disk.buy_enabled.SPX, false);
  } finally {
    if (backup == null) {
      try { fs.unlinkSync(file); } catch (e) {}
    } else {
      fs.writeFileSync(file, backup);
    }
    delete require.cache[require.resolve("../utils/settings")];
    require("../utils/settings");
  }
});

test("setFilterConfig writes only the new keys and round-trips", function() {
  var before = settings.getFilterConfig();
  var dteBefore = settings.getAll().dte.SPY;
  try {
    var updated = settings.setFilterConfig({
      stop_after_first_loss: { QQQ: "shadow" },
      orb_recross_min: 3
    });
    assert.strictEqual(updated.stop_after_first_loss.QQQ, "shadow");
    assert.strictEqual(updated.stop_after_first_loss.SPY, before.stop_after_first_loss.SPY);
    assert.strictEqual(updated.orb_recross_skip.IWM, before.orb_recross_skip.IWM);
    assert.strictEqual(updated.orb_recross_min, 3);
    assert.strictEqual(settings.getAll().dte.SPY, dteBefore);
    var disk = JSON.parse(fs.readFileSync(settings.FILE, "utf8"));
    assert.strictEqual(disk.stop_after_first_loss.QQQ, "shadow");
    assert.strictEqual(disk.orb_recross_min, 3);
    assert.strictEqual(typeof disk.dte.SPY, "number");
  } finally {
    settings.setFilterConfig(before);
  }
});

test("orb-pnl records gain entry time, strike, expiry, and OR without dropping old fields", function() {
  filters.resetForTests();
  pnl.logTradePnL("SPY", "call", 2, 1.2, 1, {
    entryTime: "2026-10-19T14:05:00.000Z",
    strike: 570,
    expiry: "2026-10-20",
    orbHigh: 571.2,
    orbLow: 569.1,
    date: "2026-10-19"
  });
  pnl.logTradePnL("IWM", "put", 1, 2, 1);
  var data = JSON.parse(fs.readFileSync(process.env.ORB_PNL_FILE, "utf8"));
  assert.strictEqual(data.trades.length, 2);
  var first = data.trades[0];
  assert.strictEqual(first.ticker, "SPY");
  assert.strictEqual(first.side, "call");
  assert.strictEqual(first.entryPrice, 2);
  assert.strictEqual(first.exitPrice, 1.2);
  assert.strictEqual(first.contracts, 1);
  assert.strictEqual(first.pnl, -80);
  assert.strictEqual(first.entryTime, "2026-10-19T14:05:00.000Z");
  assert.strictEqual(first.strike, 570);
  assert.strictEqual(first.expiry, "2026-10-20");
  assert.strictEqual(first.orbHigh, 571.2);
  assert.strictEqual(first.orbLow, 569.1);
  assert.ok(first.time);
  var second = data.trades[1];
  assert.strictEqual(second.ticker, "IWM");
  assert.strictEqual(second.pnl, 100);
  assert.strictEqual(second.entryTime, undefined);
  assert.strictEqual(second.strike, undefined);
  assert.strictEqual(second.expiry, undefined);
  assert.strictEqual(second.orbHigh, undefined);
  assert.strictEqual(second.orbLow, undefined);
  assert.strictEqual(filters.hasLossToday("SPY", "2026-10-19"), true);
  assert.strictEqual(filters.hasLossToday("IWM", "2026-10-19"), false);
});

(async function() {
  console.log("choppyFilters");
  for (var i = 0; i < tests.length; i++) {
    try {
      await tests[i].fn();
      passed++;
      console.log("  ok  " + tests[i].name);
    } catch (e) {
      console.error("  FAIL  " + tests[i].name);
      console.error(e && e.stack ? e.stack : e);
      process.exitCode = 1;
    }
  }
  console.log(passed + "/" + tests.length + " passed");
  if (process.exitCode) process.exit(process.exitCode);
})();
