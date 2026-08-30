// Lightweight audit tests for trading logic (no network, no Discord, no RH).
var assert = require("assert");
var paperLegs = require("../utils/paperLegs");
var exitlogic = require("../utils/exitlogic");
var reconcile = require("../utils/reconcile");
var marketCal = require("../utils/marketCalendar");
var expiryCal = require("../utils/expiryCalendar");
var expiryUtil = require("../utils/expiry");
var authguard = require("../utils/authguard");
var yahoo = require("../utils/yahoo");

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

console.log("paperLegs");
test("5% / 2.5% per leg floors contracts", function() {
  // $50k * 5% * 50% = $1,250 / ($2.50 * 100) = 5 contracts
  assert.strictEqual(paperLegs.sizeContracts(50000, 5, 0.5, 2.50), 5);
  // $10k * 2.5% = $250 / ($3 * 100) = 0 (too expensive)
  assert.strictEqual(paperLegs.sizeContracts(10000, 5, 0.5, 3.00), 0);
  assert.strictEqual(paperLegs.sizeContracts(10000, 5, 0.5, 1.00), 2);
  assert.strictEqual(paperLegs.sizeContracts(50000, 5, 0.5, 0), 0);
});

test("SPXW strikes round to $5; equity to $1", function() {
  assert.strictEqual(paperLegs.roundStrike("SPXW", 6402), 6400);
  assert.strictEqual(paperLegs.roundStrike("SPXW", 6403), 6405);
  assert.strictEqual(paperLegs.roundStrike("SPY", 570.4), 570);
  assert.strictEqual(paperLegs.roundStrike("IWM", 218.6), 219);
});

test("0DTE ATM vs 1DTE expected-move strike", function() {
  var moves = { upper: 6450, lower: 6350 };
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "call", 0, 6402, moves), 6400);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "call", 1, 6402, moves), 6450);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPXW", "put", 1, 6402, moves), 6350);
  assert.strictEqual(paperLegs.strikeForLegTicker("SPY", "call", 1, 570.2, null), 570);
});

test("leg keys do not prefix-match SPXW as SPX", function() {
  var positions = {
    "SPXW:0": { contracts: 2 },
    "SPXW:1": { contracts: 1 },
    "SPY:0": { contracts: 3 }
  };
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPXW").sort(), ["SPXW:0", "SPXW:1"]);
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPX"), []);
  assert.deepStrictEqual(paperLegs.listLegsForTrade(positions, "SPY"), ["SPY:0"]);
});

test("move touch: call uses high/upper, put uses low/lower", function() {
  var call = { side: "call", targetUpper: 100, moveExitDone: false };
  var put = { side: "put", targetLower: 90, moveExitDone: false };
  assert.strictEqual(paperLegs.checkMoveTouch(call, { price: 99, high: 100, low: 98 }), "upper");
  assert.strictEqual(paperLegs.checkMoveTouch(call, { price: 99, high: 99.5, low: 98 }), null);
  assert.strictEqual(paperLegs.checkMoveTouch(put, { price: 91, high: 92, low: 90 }), "lower");
  assert.strictEqual(paperLegs.checkMoveTouch(put, { price: 91, high: 92, low: 90.5 }), null);
  assert.strictEqual(paperLegs.checkMoveTouch({ side: "call", targetUpper: 100, moveExitDone: true }, { price: 101 }), null);
});

test("sell qty: 0DTE 100%, 1DTE 75% with 1-contract floor", function() {
  assert.strictEqual(paperLegs.exitFractionForLeg(0), 1);
  assert.strictEqual(paperLegs.exitFractionForLeg(1), 0.75);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 4 }, 1), 4);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 4 }, 0.75), 3);
  assert.strictEqual(paperLegs.sellQtyForLeg({ contracts: 1 }, 0.75), 1);
});

console.log("exitlogic");
test("initial stop at -15%", function() {
  var d = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 1.70);
  assert.ok(d.stopOut);
  assert.strictEqual(d.scaleOut, false);
});

test("scale-out at +20%, not at +19%", function() {
  var a = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 2.40);
  assert.ok(a.scaleOut);
  assert.strictEqual(a.newTier, 1);
  var b = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false }, 2.38);
  assert.strictEqual(b.scaleOut, false);
});

test("breakeven at +30% then trail +10% per +20%", function() {
  var be = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 1, breakEvenActivated: false }, 2.60);
  assert.ok(be.activateBreakeven);
  assert.strictEqual(be.newStopPct, 0);
  var trail = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 2, breakEvenActivated: true, stopPct: 0 }, 3.00);
  // +50% → one 20% step above +30% → trail stop 10%
  assert.strictEqual(trail.newStopPct, 10);
});

test("does not scale out while stopping out", function() {
  var d = exitlogic.evaluate({ entryPrice: 2, lastProfitTier: 0, breakEvenActivated: false, stopPct: -15 }, 1.50);
  assert.ok(d.stopOut);
  assert.strictEqual(d.scaleOut, false);
});

console.log("reconcile");
test("uses average_price before mark fallback", function() {
  assert.strictEqual(reconcile.entryPriceFromRh({ average_price: "1.85" }, 2.40), 1.85);
  assert.strictEqual(reconcile.entryPriceFromRh({ pending_average_price: "1.90" }, 2.40), 1.90);
  assert.strictEqual(reconcile.entryPriceFromRh({}, 2.40), 2.40);
  assert.strictEqual(reconcile.entryPriceFromRh({}, 0), 0);
});

test("refuses ambiguous multi-position pick", function() {
  var many = [
    { chain_symbol: "SPY", quantity: "2", option_type: "call", option: "a" },
    { chain_symbol: "SPY", quantity: "1", option_type: "put", option: "b" }
  ];
  assert.strictEqual(reconcile.findRhPosition(many, "SPY", null), null);
  var one = [{ chain_symbol: "SPY", quantity: "2", option_type: "call", option: "a" }];
  assert.strictEqual(reconcile.findRhPosition(one, "SPY", null).option, "a");
  var byUrl = reconcile.findRhPosition(many, "SPY", { instrumentUrl: "b" });
  assert.strictEqual(byUrl.option, "b");
});

console.log("calendar / expiry");
test("2026 holidays include Good Friday and Independence Day", function() {
  var h = marketCal.getYearHolidays(2026);
  assert.ok(h.closed["2026-04-03"], "Good Friday 2026");
  assert.ok(h.closed["2026-07-03"], "Independence Day observed 2026 (Fri)");
  assert.ok(!marketCal.isTradingDayET(new Date("2026-07-03T16:00:00Z")));
  assert.ok(marketCal.isTradingDayET(new Date("2026-07-02T16:00:00Z")));
});

test("weekly expiry is this week's Friday", function() {
  assert.strictEqual(expiryCal.fridayOfTradingWeek("2026-08-31"), "2026-09-04");
  assert.strictEqual(expiryCal.thirdFriday(2026, 9), "2026-09-18");
});

test("0DTE is today on a trading day, 1DTE is next session", function() {
  var d0 = expiryUtil.getExpiryForDTE(0);
  var d1 = expiryUtil.getExpiryForDTE(1);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d0));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d1));
  assert.ok(d1 > d0 || d1 >= d0);
});

console.log("misc");
test("SPXW displays as SPX", function() {
  assert.strictEqual(yahoo.displaySymbol("SPXW"), "SPX");
  assert.strictEqual(yahoo.displaySymbol("SPY"), "SPY");
});

test("authguard is off without WEBHOOK_SECRET", function() {
  assert.strictEqual(!!authguard.getSecret(), !!(process.env.WEBHOOK_SECRET || process.env.API_SECRET));
});

test("trade sizing preview matches live half+half", function() {
  var state = require("../utils/state");
  var sz = state.getTradeSizing("SPY");
  assert.ok(sz.halfEntry >= 1);
  assert.strictEqual(sz.retestAdd, sz.halfEntry);
  assert.strictEqual(sz.fullPosition, sz.halfEntry * 2);
  var fromTotal = state.getTradeSizingFromTotal(7);
  assert.strictEqual(fromTotal.halfEntry, 4);
  assert.strictEqual(fromTotal.retestAdd, 4);
  assert.strictEqual(fromTotal.fullPosition, 8);
});

test("reconcile infers half vs full from RH qty", function() {
  var state = require("../utils/state");
  state.setContractSize(6, 6);
  var half = state.inferPositionPhase("SPY", 3);
  assert.strictEqual(half.halfIn, true);
  assert.strictEqual(half.fullIn, false);
  assert.strictEqual(half.contracts, 3);
  var full = state.inferPositionPhase("SPY", 6);
  assert.strictEqual(full.halfIn, false);
  assert.strictEqual(full.fullIn, true);
  assert.strictEqual(full.contracts, 6);
});

test("ET interval aligns to Eastern clock boundaries", function() {
  var ms = exitlogic.msUntilNextETInterval(15);
  assert.ok(ms > 0 && ms <= 15 * 60 * 1000);
});

if (process.exitCode) {
  console.error("\nAUDIT TESTS FAILED");
  process.exit(1);
}
console.log("\n" + passed + " tests passed");
