// One-time P&L correction for 2026-10-20 (main = SPX, spy0dte = SPY).
//
// A 4:00 PM ET 2026-10-19 paper entry was carried overnight. Its expired 10-19
// legs were priced off 10-20 contracts, posting fake gains. Every 2026-10-20
// realized close in these two channels came from that carried trade (no new
// entries opened that day), so the day's realized P&L is removed, the matching
// win/loss counts are backed out, and the stop_after_first_loss mark the
// carried legs set is cleared. Files are backed up first. Runs once (marker).

var fs = require("fs");
var path = require("path");

var FIX_DATE = "2026-10-20";
var CHANNELS = ["main", "spy0dte"];

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; } }
function etDate(iso) {
  var d = new Date(iso);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// dir: data dir. Returns a report object; never throws.
function run(dir, channelId, opts) {
  opts = opts || {};
  if (CHANNELS.indexOf(channelId) === -1) return null;
  var marker = path.join(dir, "pnl-fix-" + FIX_DATE + "-" + channelId + ".json");
  if (fs.existsSync(marker)) return { skipped: "already_applied" };
  var pnlFile = path.join(dir, "pnl-" + channelId + ".json");
  var paperFile = path.join(dir, "paper-" + channelId + ".json");
  var pnl = readJson(pnlFile);
  var paper = readJson(paperFile);
  var report = { channel: channelId, date: FIX_DATE };
  try {
    // Guard: if any leg was opened on FIX_DATE, P&L may be real — leave it alone.
    var positions = (paper && paper.positions) || {};
    var openedToday = Object.keys(positions).some(function(k) {
      var p = positions[k];
      return p && p.entryTime && etDate(p.entryTime) === FIX_DATE;
    });
    if (openedToday) {
      report.skipped = "leg_opened_on_fix_date";
      console.log("[PNL_FIX][" + channelId + "] skipped — a leg was opened on " + FIX_DATE);
      return report;
    }
    var stamp = ".bak-" + FIX_DATE;
    [pnlFile, paperFile].forEach(function(f) {
      if (fs.existsSync(f) && !fs.existsSync(f + stamp)) fs.copyFileSync(f, f + stamp);
    });

    var before = pnl && pnl.byDate ? (pnl.byDate[FIX_DATE] || 0) : 0;
    report.dayBefore = before;
    report.allTimeBefore = pnl ? (pnl.allTime || 0) : 0;
    if (pnl && pnl.byDate && pnl.byDate[FIX_DATE] != null) {
      pnl.allTime = (pnl.allTime || 0) - before;
      delete pnl.byDate[FIX_DATE];
      fs.writeFileSync(pnlFile, JSON.stringify(pnl));
    }
    report.dayAfter = 0;
    report.allTimeAfter = pnl ? (pnl.allTime || 0) : 0;

    // Trades to back out: closedToday if still for FIX_DATE, else the saved daily package.
    var trades = [];
    if (paper && paper.date === FIX_DATE && Array.isArray(paper.closedToday) && paper.closedToday.length) trades = paper.closedToday;
    else {
      var pkg = readJson(path.join(dir, opts.contentSubdir || "grok-content", FIX_DATE, channelId + ".json"));
      if (pkg && Array.isArray(pkg.trades)) trades = pkg.trades;
    }
    var w = 0, l = 0;
    trades.forEach(function(t) { if ((t.totalProfit || 0) >= 0) w++; else l++; });
    report.removedTrades = trades.length;
    report.removedWins = w; report.removedLosses = l;
    if (paper) {
      paper.wins = Math.max(0, (paper.wins || 0) - w);
      paper.losses = Math.max(0, (paper.losses || 0) - l);
      paper.totalTrades = Math.max(0, (paper.totalTrades || 0) - trades.length);
      if (paper.date === FIX_DATE) paper.closedToday = [];
      fs.writeFileSync(paperFile, JSON.stringify(paper));
    }
    try { report.lossMarkCleared = require("./choppyFilters").clearPaperLoss(channelId, FIX_DATE); }
    catch (e) { report.lossMarkCleared = false; }
    fs.writeFileSync(marker, JSON.stringify(Object.assign({ appliedAt: new Date().toISOString() }, report)));
    console.log("[PNL_FIX][" + channelId + "] " + FIX_DATE + " realized $" + before.toFixed(2) + " → $0.00; all-time $"
      + report.allTimeBefore.toFixed(2) + " → $" + report.allTimeAfter.toFixed(2) + "; removed " + trades.length
      + " trade(s) (" + w + "W/" + l + "L); loss mark cleared=" + report.lossMarkCleared);
  } catch (e) {
    report.error = e.message;
    console.log("[PNL_FIX][" + channelId + "] failed: " + e.message);
  }
  return report;
}

module.exports = { run: run, FIX_DATE: FIX_DATE, CHANNELS: CHANNELS };
