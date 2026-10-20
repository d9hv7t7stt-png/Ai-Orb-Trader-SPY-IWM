// Held legs never roll to another expiry; expired legs settle quietly;
// 0DTE legs fully close at 3:45 PM ET; one-time 2026-10-20 P&L fix.
var assert = require("assert");
var fs = require("fs");
var os = require("os");
var path = require("path");

var dir = fs.mkdtempSync(path.join(os.tmpdir(), "expired-legs-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
process.env.FILTER_SHADOW_FILE = path.join(dir, "filter-shadow.json");
process.env.FILTER_STATE_FILE = path.join(dir, "choppy-filter-state.json");
process.env.DISCORD_WEBHOOK_URL = "https://example.invalid/webhook";
delete process.env.DISCORD_WEBHOOK_FREE; delete process.env.DISCORD_WEBHOOK_SPY0DTE; delete process.env.DISCORD_WEBHOOK_QQQ;

var https = require("https");
var posts = 0;
https.request = function() { posts++; throw new Error("network disabled in test"); };

var paperLegs = require("../utils/paperLegs");
var rh = require("../utils/robinhood");
var yahoo = require("../utils/yahoo");
var exitlogic = require("../utils/exitlogic");

function etYmd(d) { return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }
var today = etYmd(new Date());
var yesterday = etYmd(new Date(Date.now() - 86400000));

var quoteCalls = [];
rh.getOptionMark = async function(t, side, strike, expiry, opts) { quoteCalls.push({ src: "rh", expiry: expiry, opts: opts }); return null; };
rh.getOptionMarkByUrl = async function() { quoteCalls.push({ src: "rhUrl" }); return 99; };
rh.getToken = function() { return "x"; };
yahoo.getOptionMark = async function(t, side, strike, expiry, opts) { quoteCalls.push({ src: "yahoo", expiry: expiry, opts: opts }); return null; };
yahoo.getCloseOnDate = async function(t, ymd) { return ymd === yesterday ? 7650 : null; };

var tests = [];
function test(name, fn) { tests.push({ name: name, fn: fn }); }

test("isExpiredLeg / settlementPrice / eodSellQty helpers", function() {
  assert.strictEqual(paperLegs.isExpiredLeg({ expiry: "2026-10-19" }, "2026-10-20", false), true);
  assert.strictEqual(paperLegs.isExpiredLeg({ expiry: "2026-10-20" }, "2026-10-20", false), false);
  assert.strictEqual(paperLegs.isExpiredLeg({ expiry: "2026-10-20" }, "2026-10-20", true), true);
  assert.strictEqual(paperLegs.isExpiredLeg({ expiry: "2026-10-21" }, "2026-10-20", true), false);
  assert.strictEqual(paperLegs.settlementPrice("put", 7660, 7650), 10);
  assert.strictEqual(paperLegs.settlementPrice("call", 7660, 7650), 0);
  assert.strictEqual(paperLegs.settlementPrice("put", 7660, null), 0);
});

test("3:45 PM ET sell: 0DTE leg closes 100%, 1DTE leg keeps 50%", function() {
  assert.strictEqual(exitlogic.EOD_SELL_FRAC, 0.5);
  assert.strictEqual(paperLegs.eodSellQty({ contracts: 7, expiry: "2026-10-20" }, "2026-10-20", 0.5), 7);
  assert.strictEqual(paperLegs.eodSellQty({ contracts: 7, expiry: "2026-10-21" }, "2026-10-20", 0.5), 3);
  assert.strictEqual(paperLegs.eodSellQty({ contracts: 1, expiry: "2026-10-21" }, "2026-10-20", 0.5), 1);
});

test("robinhood getOptionInstrument skips the roll when noRoll is set", function() {
  var src = fs.readFileSync(path.join(__dirname, "../utils/robinhood.js"), "utf8");
  var fn = src.slice(src.indexOf("async function getOptionInstrument"), src.indexOf("async function placeOptionOrder"));
  assert.ok(fn.indexOf("opts.noRoll) return null") !== -1 && fn.indexOf("opts.noRoll") < fn.indexOf("findNearestExpiry"));
});

var discord;
test("restored expired leg settles quietly and is never re-priced to the next expiry", async function() {
  fs.writeFileSync(path.join(dir, "pnl-main.json"), JSON.stringify({ allTime: 0, byDate: {} }));
  fs.writeFileSync(path.join(dir, "paper-main.json"), JSON.stringify({
    date: today, closedToday: [], wins: 0, losses: 0, totalTrades: 0,
    positions: {
      "SPXW:0": { tradeTicker: "SPXW", side: "put", dteTag: 0, contracts: 4, totalContracts: 4,
        entryPrice: 0.05, strike: 7660, expiry: yesterday, realizedPnl: 0, entryTime: new Date(Date.now() - 86400000).toISOString() }
    }
  }));
  discord = require("../utils/discord");
  discord.initChannels(function() { return "x"; });
  var ch = discord.getChannels()[0];
  await ch.settleExpiredLegs();
  await ch.pollOptionMarks(true);
  var acct = ch.getAccount();
  assert.strictEqual(acct.positions["SPXW:0"], null);
  assert.strictEqual(quoteCalls.length, 0, "expired leg must not be quoted");
  assert.strictEqual(posts, 0, "settlement must not post to Discord");
  // (10 - 0.05) * 4 * 100 = 3980 booked to the expiry date
  var pnl = JSON.parse(fs.readFileSync(path.join(dir, "pnl-main.json"), "utf8"));
  assert.strictEqual(Math.round(pnl.byDate[yesterday] * 100) / 100, 3980);
  assert.ok(!pnl.byDate[today]);
  assert.strictEqual(require("../utils/choppyFilters").hasPaperLoss("main", today), false);
});

test("held live leg quotes only its own expiry (noRoll)", async function() {
  var ch = discord.getChannels()[0];
  var acct = ch.getAccount();
  acct.positions["SPXW:1"] = { tradeTicker: "SPXW", side: "call", dteTag: 1, contracts: 2, totalContracts: 2,
    entryPrice: 1, strike: 7700, expiry: "2099-01-02", realizedPnl: 0 };
  quoteCalls.length = 0;
  await ch.pollOptionMarks(true);
  assert.ok(quoteCalls.length > 0);
  quoteCalls.filter(function(c) { return c.src !== "rhUrl"; }).forEach(function(c) {
    assert.strictEqual(c.expiry, "2099-01-02");
    assert.ok(c.opts && c.opts.noRoll, "held-leg quote must pass noRoll");
  });
  acct.positions["SPXW:1"] = null;
});

test("one-time 2026-10-20 P&L fix backs up, removes the day, clears the loss mark, runs once", function() {
  var fix = require("../utils/pnlFix20261020");
  var d = fs.mkdtempSync(path.join(os.tmpdir(), "pnlfix-"));
  fs.writeFileSync(path.join(d, "pnl-spy0dte.json"), JSON.stringify({ allTime: 5000, byDate: { "2026-10-19": 100, "2026-10-20": 4200 } }));
  fs.writeFileSync(path.join(d, "paper-spy0dte.json"), JSON.stringify({ date: "2026-10-20", positions: {}, wins: 5, losses: 3, totalTrades: 8,
    closedToday: [{ totalProfit: 4500 }, { totalProfit: -300 }] }));
  var r = fix.run(d, "spy0dte");
  assert.strictEqual(r.dayBefore, 4200);
  var pnl = JSON.parse(fs.readFileSync(path.join(d, "pnl-spy0dte.json"), "utf8"));
  assert.strictEqual(pnl.allTime, 800);
  assert.strictEqual(pnl.byDate["2026-10-20"], undefined);
  assert.strictEqual(pnl.byDate["2026-10-19"], 100);
  var paper = JSON.parse(fs.readFileSync(path.join(d, "paper-spy0dte.json"), "utf8"));
  assert.deepStrictEqual([paper.wins, paper.losses, paper.totalTrades, paper.closedToday.length], [4, 2, 6, 0]);
  assert.ok(fs.existsSync(path.join(d, "pnl-spy0dte.json.bak-2026-10-20")));
  assert.ok(fs.existsSync(path.join(d, "paper-spy0dte.json.bak-2026-10-20")));
  assert.strictEqual(fix.run(d, "spy0dte").skipped, "already_applied");
  assert.strictEqual(fix.run(d, "qqq"), null);
});

(async function() {
  var passed = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); passed++; console.log("  ok  " + tests[i].name); }
    catch (e) { console.error("  FAIL  " + tests[i].name + " — " + e.message); process.exitCode = 1; }
  }
  console.log(passed + "/" + tests.length + " passed");
  process.exit(process.exitCode || 0);
})();
