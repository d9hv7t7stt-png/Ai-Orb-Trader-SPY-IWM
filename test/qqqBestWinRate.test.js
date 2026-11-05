// QQQ Best Win Rate rules. No network.
var assert = require("assert");
var fs = require("fs");
var path = require("path");
var bwr = require("../utils/qqqBestWinRate");

var passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    console.error("  FAIL  " + name + " — " + e.message);
    process.exitCode = 1;
  }
}

function bar(minute, close, ts) {
  return { minute: minute, close: close, high: close + 0.01, low: close - 0.01, ts: ts };
}

// Tight open: width 0.1% so the 0.3% cap does not skip.
var ORB = { high: 100.10, low: 100.00 };

function upBlock(startMin, endTs) {
  var bars = [];
  for (var m = 0; m < 15; m++) {
    var minute = startMin + m;
    bars.push(bar(minute, 100.20, endTs - (15 - m) * 60));
  }
  return bars;
}

function flatBlock(startMin, endTs) {
  var bars = [];
  for (var m = 0; m < 15; m++) {
    var minute = startMin + m;
    bars.push(bar(minute, 100.05, endTs - (15 - m) * 60));
  }
  return bars;
}

test("opening range is the 9:30–9:35 1-minute highs and lows", function() {
  var bars = [
    bar(9 * 60 + 29, 90, 0),
    bar(9 * 60 + 30, 101, 0),
    bar(9 * 60 + 31, 99, 0),
    bar(9 * 60 + 34, 100.5, 0),
    bar(9 * 60 + 35, 110, 0)
  ];
  bars[1].high = 102; bars[1].low = 100.4;
  bars[2].high = 100.2; bars[2].low = 98;
  bars[3].high = 101; bars[3].low = 100;
  var or = bwr.openingRange(bars);
  assert.strictEqual(or.high, 102);
  assert.strictEqual(or.low, 98);
});

test("15-minute blocks start at 9:35 and ignore the opening range", function() {
  var endTs = 2000;
  var bars = [bar(9 * 60 + 30, 50, 0)].concat(upBlock(9 * 60 + 35, endTs));
  var blocks = bwr.aggregateBlocks(bars, endTs);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].startMin, 9 * 60 + 35);
  assert.strictEqual(blocks[0].endMin, 9 * 60 + 50);
  assert.strictEqual(blocks[0].close, 100.20);
  var early = bwr.aggregateBlocks(bars, endTs - 1);
  assert.strictEqual(early.length, 0);
});

test("two consecutive buffered closes confirm, the third does not re-fire", function() {
  var t1 = 5000;
  var t2 = t1 + 15 * 60;
  var t3 = t2 + 15 * 60;
  var bars = upBlock(9 * 60 + 35, t1).concat(upBlock(9 * 60 + 50, t2)).concat(upBlock(10 * 60 + 5, t3));
  var blocks = bwr.aggregateBlocks(bars, t3);
  var breaks = bwr.scanBreaks(blocks, ORB);
  assert.strictEqual(breaks.length, 1);
  assert.strictEqual(breaks[0].direction, "up");
  assert.strictEqual(breaks[0].endMin, 10 * 60 + 5);
});

test("a fresh 2-close after the streak resets is another break", function() {
  var blocks = [
    { close: 100.20, endMin: 600, endTs: 6000 },
    { close: 100.20, endMin: 610, endTs: 7000 },
    { close: 100.05, endMin: 615, endTs: 8000 },
    { close: 100.20, endMin: 620, endTs: 9000 },
    { close: 100.20, endMin: 625, endTs: 10000 }
  ];
  var breaks = bwr.scanBreaks(blocks, ORB);
  assert.strictEqual(breaks.length, 2);
  assert.strictEqual(breaks[0].endMin, 610);
  assert.strictEqual(breaks[1].endMin, 625);
});

test("flat book takes a confirmation inside the grace window and before 10:30", function() {
  var blocks = [
    { close: 100.20, endMin: 9 * 60 + 50, endTs: 1000 },
    { close: 100.20, endMin: 10 * 60 + 5, endTs: 1900 }
  ];
  var session = bwr.evaluateSession(ORB, blocks, {
    nowSec: 1900 + 119,
    inPosition: false,
    consumedEndMins: []
  });
  assert.strictEqual(session.skipDay, false);
  assert.ok(session.event);
  assert.strictEqual(session.event.event, "breakout_long");
  assert.strictEqual(session.event.side, "call");
  assert.strictEqual(session.event.endMin, 10 * 60 + 5);
});

test("a confirmation seen more than 2 minutes after the bar end is not chased", function() {
  var blocks = [
    { close: 100.20, endMin: 9 * 60 + 50, endTs: 1000 },
    { close: 100.20, endMin: 10 * 60 + 5, endTs: 1900 }
  ];
  var session = bwr.evaluateSession(ORB, blocks, {
    nowSec: 1900 + 121,
    inPosition: false,
    consumedEndMins: []
  });
  assert.strictEqual(session.event, null);
  assert.ok(session.actions.some(function(a) { return a.reason === "grace" && a.consume && a.endMin === 10 * 60 + 5; }));
});

test("bar end at or after 10:30 is not taken", function() {
  var blocks = [
    { close: 100.05, endMin: 10 * 60 + 5, endTs: 1000 },
    { close: 100.20, endMin: 10 * 60 + 20, endTs: 1900 },
    { close: 100.20, endMin: 10 * 60 + 35, endTs: 2800 }
  ];
  var session = bwr.evaluateSession(ORB, blocks, {
    nowSec: 2800 + 10,
    inPosition: false,
    consumedEndMins: []
  });
  assert.strictEqual(session.event, null);
  assert.ok(session.actions.some(function(a) { return a.endMin === 10 * 60 + 35 && a.reason === "cutoff"; }));
});

test("10:20 bar end is still allowed", function() {
  var blocks = [
    { close: 100.05, endMin: 10 * 60 + 5, endTs: 1000 },
    { close: 99.90, endMin: 10 * 60 + 20, endTs: 1900 },
    { close: 99.90, endMin: 10 * 60 + 35, endTs: 2800 }
  ];
  // First block is inside the range, so confirmation is the 10:20 close paired with... 
  // 10:05 is flat (streak reset), 10:20 is the first down close (streak 1). Need two downs.
  blocks[0].close = 99.90;
  var session = bwr.evaluateSession(ORB, blocks, {
    nowSec: 1900 + 30,
    inPosition: false,
    consumedEndMins: []
  });
  assert.ok(session.event);
  assert.strictEqual(session.event.event, "breakout_short");
  assert.strictEqual(session.event.endMin, 10 * 60 + 20);
});

test("in a position the confirmation is consumed and not taken", function() {
  var blocks = [
    { close: 100.20, endMin: 9 * 60 + 50, endTs: 1000 },
    { close: 100.20, endMin: 10 * 60 + 5, endTs: 1900 }
  ];
  var held = bwr.evaluateSession(ORB, blocks, {
    nowSec: 1900 + 10,
    inPosition: true,
    consumedEndMins: []
  });
  assert.strictEqual(held.event, null);
  assert.strictEqual(held.actions[0].reason, "in-position");
  var again = bwr.evaluateSession(ORB, blocks, {
    nowSec: 1900 + 10,
    inPosition: false,
    consumedEndMins: [held.actions[0].endMin]
  });
  assert.strictEqual(again.event, null);
});

test("after flat, a later confirmation is a new entry", function() {
  var blocks = [
    { close: 100.20, endMin: 600, endTs: 6000 },
    { close: 100.20, endMin: 610, endTs: 7000 },
    { close: 100.05, endMin: 615, endTs: 8000 },
    { close: 100.20, endMin: 620, endTs: 9000 },
    { close: 100.20, endMin: 625, endTs: 10000 }
  ];
  var second = bwr.evaluateSession(ORB, blocks, {
    nowSec: 10000 + 30,
    inPosition: false,
    consumedEndMins: [610]
  });
  assert.ok(second.event);
  assert.strictEqual(second.event.endMin, 625);
  assert.strictEqual(second.event.event, "breakout_long");
});

test("OR width above 0.3% skips the day and 0.3% does not", function() {
  var wide = { high: 100.16, low: 99.84 };
  var exact = { high: 100.15, low: 99.85 };
  assert.ok(bwr.orbWidthPct(wide.high, wide.low) > 0.3);
  assert.strictEqual(bwr.orbWidthPct(exact.high, exact.low), 0.3);
  var blocks = [
    { close: 100.30, endMin: 9 * 60 + 50, endTs: 1000 },
    { close: 100.30, endMin: 10 * 60 + 5, endTs: 1900 }
  ];
  var skipped = bwr.evaluateSession(wide, blocks, { nowSec: 1910, inPosition: false, consumedEndMins: [] });
  assert.strictEqual(skipped.skipDay, true);
  assert.strictEqual(skipped.event, null);
  assert.strictEqual(skipped.actions[0].reason, "width");
  var ok = bwr.evaluateSession(exact, blocks, { nowSec: 1910, inPosition: false, consumedEndMins: [] });
  assert.strictEqual(ok.skipDay, false);
  assert.ok(ok.event);
});

test("expected-move target behind entry is ignored; favorable extreme can hit", function() {
  var behind = bwr.freezeEmAtEntry("call", 105, 104, 96);
  assert.strictEqual(behind.armed, false);
  assert.strictEqual(bwr.emTakeProfitHit("call", behind.armed, behind.target, 110), false);
  var putBehind = bwr.freezeEmAtEntry("put", 95, 104, 96);
  assert.strictEqual(putBehind.armed, false);

  var armed = bwr.freezeEmAtEntry("call", 100, 104, 96);
  assert.strictEqual(armed.armed, true);
  assert.strictEqual(armed.target, 104);
  assert.strictEqual(armed.extreme, 100);
  var ext = bwr.updateExtreme("call", armed.extreme, 103);
  assert.strictEqual(bwr.emTakeProfitHit("call", true, 104, ext), false);
  ext = bwr.updateExtreme("call", ext, 104);
  assert.strictEqual(bwr.emTakeProfitHit("call", true, 104, ext), true);

  var put = bwr.freezeEmAtEntry("put", 100, 104, 96);
  var pext = bwr.updateExtreme("put", put.extreme, 97);
  assert.strictEqual(bwr.emTakeProfitHit("put", true, 96, pext), false);
  pext = bwr.updateExtreme("put", pext, 96);
  assert.strictEqual(bwr.emTakeProfitHit("put", true, 96, pext), true);
});

test("max hold exits only after more than 120 minutes", function() {
  var entry = "2026-11-05T14:35:00.000Z";
  var start = Date.parse(entry);
  assert.strictEqual(bwr.holdExceeded(entry, start + 120 * 60 * 1000), false);
  assert.strictEqual(bwr.holdExceeded(entry, start + 120 * 60 * 1000 + 1), true);
  assert.strictEqual(bwr.holdExceeded(null, start), false);
});

test("1-minute chart stamps map to ET minutes", function() {
  // 2026-11-05 14:30:00 UTC is 9:30 ET (EST).
  var ts = Date.UTC(2026, 10, 5, 14, 30, 0) / 1000;
  var chart = {
    chart: {
      result: [{
        timestamp: [ts, ts + 300],
        indicators: { quote: [{ close: [100, 101], high: [100.2, 101.2], low: [99.8, 100.8] }] },
        meta: { currentTradingPeriod: { regular: { start: ts } } }
      }]
    }
  };
  var bars = bwr.parseChartBars(chart);
  assert.strictEqual(bars[0].minute, 9 * 60 + 30);
  assert.strictEqual(bars[1].minute, 9 * 60 + 35);
  assert.strictEqual(bwr.openingRange(bars).high, 100.2);
});

test("QQQ paper wiring keeps the -15% option stop and does not use a premium step-up", function() {
  var discord = fs.readFileSync(path.join(__dirname, "../utils/discord.js"), "utf8");
  var alert = fs.readFileSync(path.join(__dirname, "../routes/alert.js"), "utf8");
  var exitlogic = fs.readFileSync(path.join(__dirname, "../utils/exitlogic.js"), "utf8");
  var signals = fs.readFileSync(path.join(__dirname, "../utils/qqqYahooSignals.js"), "utf8");
  assert.ok(discord.indexOf("qqqBwr.holdExceeded") > 0);
  assert.ok(discord.indexOf("qqqBwr.emTakeProfitHit") > 0);
  assert.ok(discord.indexOf('cfg.id === "qqq"') > 0);
  assert.ok(exitlogic.indexOf("INITIAL_STOP_PCT = -15") > 0);
  assert.strictEqual(discord.indexOf("premium-stop"), -1);
  assert.ok(signals.indexOf("channelIds: [\"qqq\"]") > 0);
  assert.strictEqual(signals.indexOf("stop_long"), -1);
  assert.ok(alert.indexOf("skipPaper: true") > 0);
  assert.ok(alert.indexOf('ticker !== "QQQ"') > 0);
});

console.log("qqqBestWinRate");
console.log(passed + " passed");
if (process.exitCode) process.exit(process.exitCode);
