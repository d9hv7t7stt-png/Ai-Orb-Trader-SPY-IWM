// Discord Paper Trading — MULTI-CHANNEL
// Each channel is an independent paper account posting to its own webhook, with
// its own balance, contract size, ticker filter, DTE, update cadence and morning
// theme. A signal fans out to every channel that trades that ticker.
//
// Channels activate only if their webhook env var is set (backward compatible):
//   A "main"     DISCORD_WEBHOOK_URL      SPY+IWM  $50k  50c  global DTE  15-min  default theme
//   B "free"     DISCORD_WEBHOOK_FREE     IWM      $10k  10c  0DTE        30-min  vibey theme
//   C "spy0dte"  DISCORD_WEBHOOK_SPY0DTE  SPY      $10k   5c  0DTE        30-min  vibey theme

const https = require("https");
const rh = require("./robinhood");
const yahoo = require("./yahoo");
const expiryUtil = require("./expiry");
const exitlogic = require("./exitlogic");
const persist = require("./persist");

function etTimeLabel() {
  return new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }) + " ET";
}

function paperMarketHours() {
  return exitlogic.isRegularMarketHours();
}

// Resolve underlying price for ATM strike: webhook close → Robinhood → Yahoo.
async function resolveUnderlying(ticker, underlying) {
  var v = underlying ? parseFloat(underlying) : NaN;
  if (!isNaN(v) && v > 0) return v;
  try {
    var u = await rh.getQuote(ticker);
    if (u && u > 0) return u;
  } catch (e) {}
  try {
    var y = await yahoo.getUnderlyingPrice(ticker);
    if (y && y > 0) return y;
  } catch (e) {}
  return null;
}

async function fetchOptionMark(ticker, side, strike, expiry) {
  try {
    var m = await rh.getOptionMark(ticker, side, strike, expiry);
    if (m && m.price > 0) return m;
  } catch (e) {
    console.log("[PAPER] RH option mark failed " + ticker + " " + strike + ": " + e.message);
  }
  try {
    var y = await yahoo.getOptionMark(ticker, side, strike, expiry);
    if (y && y.price > 0) {
      console.log("[PAPER] Yahoo option mark " + ticker + " " + y.strike + " $" + y.price.toFixed(2));
      return y;
    }
  } catch (e) {
    console.log("[PAPER] Yahoo option mark failed " + ticker + ": " + e.message);
  }
  return null;
}

// ── low-level + format helpers ──────────────────────────────────────────────
async function httpPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => { let raw=""; res.on("data",c=>raw+=c); res.on("end",()=>resolve(raw)); });
    req.on("error", reject);
    req.write(body); req.end();
  });
}
function formatMoney(n) {
  var abs = Math.abs(n);
  var str = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return n < 0 ? "-" + str : str;
}
function formatPct(n) { return (n >= 0 ? "+" : "") + n.toFixed(1) + "%"; }
function etISODate() { return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); }

// ── morning themes ──────────────────────────────────────────────────────────
function morningMessages(theme, name) {
  if (theme === "free") {
    return {
      60: { color: 0x00e5a0, content: "@everyone", title: "☀️ Good Morning, Free Squad!",
        description: "A brand new day, a brand new shot. 🌅\n\n**" + name + "** is awake and hunting IWM 0DTE setups for you — completely free. No noise, just clean alerts.\n\nProtect your capital, trust the process, and let's go get it together. 💚",
        footer: "Free alerts • Not financial advice. Options trading involves significant risk of loss." },
      45: { color: 0x4da6ff, title: "🌤️ 45 Minutes — Getting Ready",
        description: "Coffee up. ☕ Reviewing the board and any open IWM plays before the bell. Discipline beats hype every single time.",
        footer: "Free alerts • Not financial advice." },
      30: { color: 0xf5c518, content: "@everyone", title: "🌅 30 Minutes Out — Stay Patient",
        description: "Half an hour to go. The best traders wait for *their* setup — they don't chase.\n\nIWM 0DTE moves fast. We stay calm and let the plan come to us. 🧘",
        footer: "Free alerts • Trade at your own risk." },
      5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Lock In",
        description: "Almost showtime. Alerts fire on **5m bar close** — not wicks. Deep breath. 🔥",
        footer: "Free alerts • Trade at your own risk." },
      1:  { color: 0x00e5a0, content: "@everyone", title: "🚀 60 SECONDS — Let's Work",
        description: "Here we go. Stay focused, stay disciplined, and let the setups come. Good luck today, everyone. 💚",
        footer: "Free alerts • Options trading carries substantial risk of loss." }
    };
  }
  if (theme === "spy") {
    return {
      60: { color: 0x00e5a0, content: "@everyone", title: "☀️ Rise & Grind — SPY 0DTE",
        description: "New day, clean slate. 🌅\n\n**" + name + "** is dialed in on SPY 0DTE. Big speed, big respect for risk.\n\nWe trade the plan, not the emotion. Let's make today count. 💪",
        footer: "SPY 0DTE • Not financial advice. 0DTE options are extremely high risk." },
      45: { color: 0x4da6ff, title: "🌤️ 45 Minutes — Pre-Flight Check",
        description: "Reviewing SPY levels and any open plays. Sharp focus now pays off when the bell rings. 📋",
        footer: "SPY 0DTE • Not financial advice." },
      30: { color: 0xf5c518, content: "@everyone", title: "🌅 30 Minutes — Eyes on SPY",
        description: "Thirty out. 0DTE rewards patience and punishes chasing. We wait for the break, then we execute.\n\nCalm hands win. 🧘",
        footer: "SPY 0DTE • Trade at your own risk." },
      5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Locked In on SPY",
        description: "Almost go time. Every tick matters on 0DTE. Stay present, stay disciplined. 🔥",
        footer: "SPY 0DTE • Trade at your own risk." },
      1:  { color: 0x00e5a0, content: "@everyone", title: "🚀 60 SECONDS — SPY Is Live",
        description: "This is it. Plan locked, risk defined. Let's go earn it today. 💚",
        footer: "SPY 0DTE • Options trading carries substantial risk of loss." }
    };
  }
  // default theme (Channel A)
  return {
    45: { color: 0x4da6ff, title: "👁️ 45 Minutes to Open — Argus Pre-Market Check",
      description: "Morning rundown incoming. Reviewing all open ORB positions before the bell. Stay sharp — the edge goes to those who prepare. 📋",
      footer: "Not financial advice. Options trading involves significant risk of loss." },
    60: { color: 0xf5c518, content: "@everyone", title: "☀️ Good Morning, Traders!",
      description: "Rise and shine — market opens in one hour. Grab your coffee, check your charts, and get settled in. Today is a new opportunity.\n\nArgus is awake, warmed up, and ready to work for you. 👁️",
      footer: "Not financial advice. Options trading involves significant risk of loss." },
    30: { color: 0xf5a623, content: "@everyone", title: "🌅 30 Minutes Out",
      description: "Half hour to go. Argus is authenticated, connected, and on standby. All systems green.\n\nTake a breath. Trust the process. Let Argus do its thing. 💚",
      footer: "Not financial advice. Trade at your own risk." },
    5:  { color: 0xff8c00, content: "@everyone", title: "⚡ 5 Minutes — Argus Is Locked In",
      description: "We're almost there. Argus is watching every tick.\nWhen the bell rings, it's go time. 👀",
      footer: "Not financial advice. Trade at your own risk." },
    1:  { color: 0xff4d6a, content: "@everyone", title: "🚨 60 SECONDS. ARGUS IS LIVE.",
      description: "This is it. Everything is armed and ready.\nStay focused. Stay disciplined. Let Argus work. 🔥",
      footer: "Not financial advice. Options trading carries substantial risk of loss." }
  };
}

// ── per-channel P&L store (durable) ─────────────────────────────────────────
function loadPnl(file) {
  try { var fs = require("fs"); if (fs.existsSync(file)) { var s = JSON.parse(fs.readFileSync(file, "utf8")); s.byDate = s.byDate || {}; if (typeof s.allTime !== "number") s.allTime = 0; return s; } } catch (e) {}
  return { allTime: 0, byDate: {} };
}

// ── channel factory ─────────────────────────────────────────────────────────
function createChannel(cfg) {
  var pnlFile = persist.filePath("pnl-" + cfg.id + ".json");
  var pnlStore = loadPnl(pnlFile);

  var account = {
    balance: cfg.startBalance + (pnlStore.allTime || 0),
    startingBalance: cfg.startBalance,
    positions: {},
    closedToday: [],     // per-play summaries for the daily report
    wins: 0, losses: 0, totalTrades: 0
  };
  cfg.tickers.forEach(function(t){ account.positions[t] = null; });

  function savePnl() { try { require("fs").writeFileSync(pnlFile, JSON.stringify(pnlStore)); } catch (e) { console.log("[DISCORD] pnl save failed: " + e.message); } }
  function realize(amount) {
    var d = etISODate();
    pnlStore.byDate[d] = (pnlStore.byDate[d] || 0) + amount;
    pnlStore.allTime = (pnlStore.allTime || 0) + amount;
    account.balance += amount;
    savePnl();
  }

  function footer() { return cfg.name + ": " + formatMoney(account.balance); }
  function posLabel(ticker, pos) { return expiryUtil.contractLabel(ticker, pos.side, pos.strike, pos.expiry); }
  function chanExpiry(ticker) { return (cfg.dte === null || cfg.dte === undefined) ? expiryUtil.getExpiry(ticker) : expiryUtil.getExpiryForDTE(cfg.dte); }
  function chanDTELabel(ticker) { return (cfg.dte === null || cfg.dte === undefined) ? expiryUtil.getDTELabel(ticker) : (cfg.dte + "DTE"); }

  async function send(embed, pingEveryone) {
    if (!cfg.webhook) return;
    var content = pingEveryone ? "@everyone" : null;
    var mentions = pingEveryone ? { parse: ["everyone"] } : { parse: [] };
    try {
      await httpPost(cfg.webhook, { content: content, allowed_mentions: mentions, embeds: [embed] });
    } catch (err) { console.log("[DISCORD_ERROR][" + cfg.id + "] " + err.message); }
  }
  async function sendRaw(content, embed, pingEveryone) {
    if (!cfg.webhook) return;
    var mentions = pingEveryone ? { parse: ["everyone"] } : { parse: [] };
    try {
      await httpPost(cfg.webhook, { content: content, allowed_mentions: mentions, embeds: [embed] });
    } catch (err) { console.log("[DISCORD_ERROR][" + cfg.id + "] " + err.message); }
  }

  function recordClose(ticker, pos, finalSalePnl) {
    var totalProfit = (pos.realizedPnl || 0) + finalSalePnl;
    var maxPrice = pos.maxPrice || pos.entryPrice || 0;
    var maxGainPct = pos.entryPrice > 0 ? ((maxPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    account.closedToday.push({ ticker: ticker, side: pos.side, entry: pos.entryPrice, maxPrice: maxPrice, maxGainPct: maxGainPct, totalProfit: totalProfit });
    if (totalProfit >= 0) account.wins++; else account.losses++;
    account.totalTrades++;
  }

  async function entry(ticker, side, optionPrice, orbHigh, orbLow, underlying) {
    var contracts = cfg.contracts;
    var expiry = chanExpiry(ticker);
    var und = await resolveUnderlying(ticker, underlying);
    var strike = und ? Math.round(und) : null;
    var instrumentUrl = null;
    var price = optionPrice && optionPrice > 0 ? parseFloat(optionPrice) : null;
    if (strike) {
      var m = await fetchOptionMark(ticker, side, strike, expiry);
      if (m) {
        instrumentUrl = m.instrument;
        if (!price && m.price) price = m.price;
        if (m.strike) strike = m.strike;
        if (m.expiry) expiry = m.expiry;
      } else {
        console.log("[PAPER][" + cfg.id + "] entry: strike=" + strike + " but no option mark — will retry on poll");
      }
    } else {
      console.log("[PAPER][" + cfg.id + "] entry: could not resolve underlying for " + ticker);
    }
    if (!price) price = 0;

    var posValue = price * contracts * 100;
    var stop = (((parseFloat(orbHigh) || 0) + (parseFloat(orbLow) || 0)) / 2).toFixed(2);
    var label = expiryUtil.contractLabel(ticker, side, strike, expiry);
    var dirLabel = side === "call" ? "LONG" : "SHORT";
    var color = side === "call" ? 0x00e5a0 : 0xff4d6a;

    account.positions[ticker] = {
      side: side, contracts: contracts, totalContracts: contracts,
      entryPrice: price, posValue: posValue, orbHigh: orbHigh, orbLow: orbLow,
      halfIn: true, fullIn: false, realizedPnl: 0, lastProfitTier: 0,
      breakEvenActivated: false, stopPct: null, strike: strike, expiry: expiry,
      instrumentUrl: instrumentUrl, lastKnownPrice: price, maxPrice: price
    };

    await send({
      color: color, title: (side === "call" ? "🟢" : "🔴") + " " + dirLabel + " ENTRY — " + label,
      description: "Signal at " + etTimeLabel() + " · 5m bar close confirmed",
      fields: [
        { name: "Contract", value: label + " (" + chanDTELabel(ticker) + ")", inline: false },
        { name: "Contracts", value: String(contracts), inline: true },
        { name: "Entry Price", value: price > 0 ? "$" + price.toFixed(2) : "Resolving…", inline: true },
        { name: "Position Value", value: price > 0 ? formatMoney(posValue) : "—", inline: true },
        { name: "ORB High", value: "$" + (parseFloat(orbHigh) || 0).toFixed(2), inline: true },
        { name: "ORB Low",  value: "$" + (parseFloat(orbLow) || 0).toFixed(2),  inline: true },
        { name: "Stop (Mid)", value: "$" + stop, inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function add(ticker, optionPrice) {
    var pos = account.positions[ticker];
    if (!pos) return;
    if (!optionPrice || optionPrice <= 0) optionPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    pos.contracts += cfg.contracts; pos.totalContracts = pos.contracts; pos.fullIn = true; pos.halfIn = false;
    var avgEntry = ((pos.entryPrice + optionPrice) / 2).toFixed(2);
    await send({
      color: 0x4da6ff, title: "➕ ADD — " + posLabel(ticker, pos) + " (Retest Confirmed)",
      fields: [
        { name: "Added", value: "+" + cfg.contracts + " contracts @ $" + optionPrice.toFixed(2), inline: true },
        { name: "Total", value: String(pos.contracts) + " contracts", inline: true },
        { name: "Avg Entry", value: "$" + avgEntry, inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, false);
  }

  async function breakeven(ticker) {
    var pos = account.positions[ticker]; if (!pos) return;
    await send({
      color: 0xf5a623, title: "🟡 BREAKEVEN STOP ACTIVATED — " + posLabel(ticker, pos),
      fields: [
        { name: "Stop Level", value: "$" + pos.entryPrice.toFixed(2) + " (entry price)", inline: true },
        { name: "Contracts", value: String(pos.contracts), inline: true },
        { name: "Status", value: "Gains protected ✅", inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function eodSell(ticker, sellContracts, currentPrice, gainPct) {
    var pos = account.positions[ticker]; if (!pos) return;
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    var tierPnl = sellContracts * (currentPrice - pos.entryPrice) * 100;
    pos.realizedPnl += tierPnl; pos.contracts -= sellContracts; realize(tierPnl);
    await send({
      color: 0x4da6ff, title: "🕒 END OF DAY — Selling 50% — " + posLabel(ticker, pos),
      fields: [
        { name: "Sold", value: sellContracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "Gain", value: formatPct(gainPct), inline: true },
        { name: "P&L This Sale", value: formatMoney(tierPnl), inline: true },
        { name: "Remaining", value: String(pos.contracts) + " contracts", inline: true },
        { name: "Reason", value: "15 min before close", inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
    if (pos.contracts <= 0) { recordClose(ticker, pos, 0); account.positions[ticker] = null; }
  }

  async function profitTier(ticker, tierNum, sellContracts, currentPrice, gainPct) {
    var pos = account.positions[ticker]; if (!pos) return;
    var tierPnl = sellContracts * (currentPrice - pos.entryPrice) * 100;
    pos.realizedPnl += tierPnl; pos.contracts -= sellContracts; realize(tierPnl);
    var title = tierNum === 3 ? "🎯 EXPECTED MOVE — " + posLabel(ticker, pos)
      : tierNum === 2 ? "💰💰 +100% RUNNER TRIM — " + posLabel(ticker, pos)
      : "💰 +" + Math.floor(gainPct) + "% TIER — Sold 10% — " + posLabel(ticker, pos);
    await send({
      color: 0xf5a623, title: title,
      fields: [
        { name: "Sold", value: sellContracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "Gain", value: formatPct(gainPct), inline: true },
        { name: "P&L This Sale", value: formatMoney(tierPnl), inline: true },
        { name: "Remaining", value: String(pos.contracts) + " contracts", inline: true },
        { name: "Realized P&L", value: formatMoney(pos.realizedPnl), inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function stop(ticker, currentPrice, reason) {
    var pos = account.positions[ticker]; if (!pos) return;
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    var salelPnl = pos.contracts * (currentPrice - pos.entryPrice) * 100;
    var pct = pos.entryPrice > 0 ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    realize(salelPnl);
    recordClose(ticker, pos, salelPnl);
    var totalPnl = salelPnl + (pos.realizedPnl || 0);
    account.positions[ticker] = null;
    var stopTitle = reason.indexOf("Trailing") !== -1 ? "📉 TRAILING STOP"
      : reason.indexOf("Mid") !== -1 || reason.indexOf("mid") !== -1 ? "🛑 ORB STOP"
      : "🔴 STOP OUT";
    await send({
      color: 0xff4d6a, title: stopTitle + " — " + posLabel(ticker, pos),
      fields: [
        { name: "Closed", value: pos.contracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "Total P&L", value: formatMoney(totalPnl) + " (" + formatPct(pct) + ")", inline: true },
        { name: "Reason", value: reason, inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  async function fullClose(ticker, currentPrice) {
    var pos = account.positions[ticker]; if (!pos || pos.contracts <= 0) return;
    if (!currentPrice || currentPrice <= 0) currentPrice = pos.lastKnownPrice || pos.entryPrice || 0;
    var salePnl = pos.contracts * (currentPrice - pos.entryPrice) * 100;
    var finalPnl = salePnl + (pos.realizedPnl || 0);
    var totalPct = pos.totalContracts > 0 && pos.entryPrice > 0 ? (finalPnl / (pos.totalContracts * pos.entryPrice * 100)) * 100 : 0;
    realize(salePnl);
    recordClose(ticker, pos, salePnl);
    account.positions[ticker] = null;
    await send({
      color: 0x00e5a0, title: "✅ POSITION FULLY CLOSED — " + posLabel(ticker, pos),
      fields: [
        { name: "Final Sale", value: pos.contracts + "c @ $" + currentPrice.toFixed(2), inline: true },
        { name: "Total P&L", value: formatMoney(finalPnl) + " (" + formatPct(totalPct) + ")", inline: true },
        { name: "Account", value: formatMoney(account.balance), inline: true }
      ],
      footer: { text: footer() }, timestamp: new Date().toISOString()
    }, true);
  }

  function unrealized() {
    var sum = 0;
    Object.keys(account.positions).forEach(function(t) {
      var p = account.positions[t];
      if (p && p.contracts > 0) { var cur = p.lastKnownPrice || p.entryPrice; sum += (cur - p.entryPrice) * p.contracts * 100; }
    });
    return sum;
  }

  function pnlWindow() {
    var today = etISODate();
    var month = today.slice(0, 7);
    var weekAgo = new Date(); weekAgo.setDate(weekAgo.getDate() - 6);
    var weekAgoISO = weekAgo.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    var daily = pnlStore.byDate[today] || 0, weekly = 0, monthly = 0;
    Object.keys(pnlStore.byDate).forEach(function(d) {
      var v = pnlStore.byDate[d];
      if (d >= weekAgoISO) weekly += v;
      if (d.slice(0, 7) === month) monthly += v;
    });
    return { daily: daily, weekly: weekly, monthly: monthly, allTime: pnlStore.allTime || 0 };
  }

  async function dailySummary() {
    var w = pnlWindow();
    var unreal = unrealized();
    var color = w.daily >= 0 ? 0x00e5a0 : 0xff4d6a;
    var emoji = w.daily >= 0 ? "📈" : "📉";
    var dailyPct = account.startingBalance > 0 ? (w.daily / account.startingBalance) * 100 : 0;

    var tradeLines = "";
    account.closedToday.forEach(function(t) {
      var e = t.totalProfit >= 0 ? "✅" : "🔴";
      tradeLines += e + " **" + t.ticker + " " + t.side.toUpperCase() + ":**\n";
      tradeLines += "   • Total Profit: " + formatMoney(t.totalProfit) + "\n";
      tradeLines += "   • Entry: $" + (t.entry || 0).toFixed(2) + "\n";
      tradeLines += "   • Max Price: $" + (t.maxPrice || 0).toFixed(2) + "\n";
      tradeLines += "   • Max Gain: " + formatPct(t.maxGainPct || 0) + " (if sold at max)\n\n";
    });
    if (!tradeLines) tradeLines = "No closed trades today";

    var dayLabel = w.daily >= 0 ? "GREEN DAY" : "RED DAY";
    await send({
      color: color,
      title: emoji + " " + dayLabel + " " + formatMoney(w.daily) + " — Daily Summary",
      fields: [
        { name: "Trades", value: tradeLines, inline: false },
        { name: "Net Profit (Today)", value: formatMoney(w.daily) + " (" + formatPct(dailyPct) + ")", inline: false },
        { name: "Unrealized (Open Positions)", value: formatMoney(unreal), inline: false },
        { name: "Weekly", value: formatMoney(w.weekly), inline: true },
        { name: "Monthly", value: formatMoney(w.monthly), inline: true },
        { name: "All-Time", value: formatMoney(w.allTime), inline: true },
        { name: "Wins / Losses", value: account.wins + " / " + account.losses, inline: true },
        { name: "Account Balance", value: formatMoney(account.balance), inline: true }
      ],
      footer: { text: cfg.name + " | Starting Balance: " + formatMoney(account.startingBalance) },
      timestamp: new Date().toISOString()
    }, true);

    account.closedToday = [];
  }

  async function openPositions(label) {
    var entries = Object.keys(account.positions).map(function(t){ return [t, account.positions[t]]; }).filter(function(e){ return e[1] && !e[1].stopped; });
    if (entries.length === 0) return;
    var fields = entries.map(function(e) {
      var ticker = e[0], pos = e[1];
      var cur = pos.lastKnownPrice || pos.entryPrice;
      var pending = cur <= 0;
      if (pending) cur = 0;
      var pnl = (cur - pos.entryPrice) * pos.contracts * 100;
      var pct = pos.entryPrice > 0 ? ((cur - pos.entryPrice) / pos.entryPrice * 100).toFixed(1) : "0.0";
      var pnlStr = pending ? "⚠️ Price feed delayed" : (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return { name: posLabel(ticker, pos),
        value: "Entry: $" + pos.entryPrice.toFixed(2) + "\nCurrent: $" + (pending ? "—" : cur.toFixed(2)) + "\nMax: $" + (pos.maxPrice || pos.entryPrice).toFixed(2) + "\nP&L: " + pnlStr + (pending ? "" : " (" + (pnl >= 0 ? "+" : "") + pct + "%)") + "\nContracts: " + pos.contracts, inline: true };
    });
    await send({
      color: 0x4da6ff,
      title: "📊 " + cfg.name + " · " + label + " Update",
      fields: fields,
      footer: { text: footer() },
      timestamp: new Date().toISOString()
    }, false);
  }

  async function morning(minutesBefore) {
    var msg = morningMessages(cfg.theme, cfg.name)[minutesBefore];
    if (!msg || !cfg.webhook) return;
    var ping = !!msg.content;
    await sendRaw(msg.content || null, { color: msg.color, title: msg.title, description: msg.description, footer: { text: msg.footer }, timestamp: new Date().toISOString() }, ping);
    if (minutesBefore === 45) await openPositions("Pre-Market 45 Min");
  }

  function updateLastKnownPrice(ticker, price) { if (account.positions[ticker] && price) account.positions[ticker].lastKnownPrice = price; }

  async function pollPosition(ticker, rhAvailable) {
    var pos = account.positions[ticker]; if (!pos) return;

    // Backfill strike/instrument for positions opened without webhook `close`.
    if (!pos.strike) {
      var und = await resolveUnderlying(ticker, null);
      if (und) pos.strike = Math.round(und);
    }
    if (pos.strike && !pos.instrumentUrl) {
      var resolved = await fetchOptionMark(ticker, pos.side, pos.strike, pos.expiry);
      if (resolved) {
        if (resolved.instrument) pos.instrumentUrl = resolved.instrument;
        if (resolved.expiry) pos.expiry = resolved.expiry;
        if (resolved.strike) pos.strike = resolved.strike;
      }
    }

    var price = null;
    if (rhAvailable) {
      try {
        if (pos.instrumentUrl) price = await rh.getOptionMarkByUrl(pos.instrumentUrl);
        if ((!price || price <= 0) && pos.strike) {
          var m = await fetchOptionMark(ticker, pos.side, pos.strike, pos.expiry);
          if (m) {
            price = m.price;
            if (m.instrument && !pos.instrumentUrl) pos.instrumentUrl = m.instrument;
            if (m.expiry) pos.expiry = m.expiry;
            if (m.strike) pos.strike = m.strike;
          }
        }
      } catch (e) { console.log("[PAPER_ENGINE][" + cfg.id + "] price " + ticker + ": " + e.message); }
    } else if (pos.strike) {
      var ym = await fetchOptionMark(ticker, pos.side, pos.strike, pos.expiry);
      if (ym) {
        price = ym.price;
        if (ym.expiry) pos.expiry = ym.expiry;
        if (ym.strike) pos.strike = ym.strike;
      }
    }

    if (!price || price <= 0) return;

    if (!pos.entryPrice || pos.entryPrice <= 0) { pos.entryPrice = price; pos.posValue = price * pos.contracts * 100; pos.lastKnownPrice = price; pos.maxPrice = price; return; }

    updateLastKnownPrice(ticker, price);
    if (!pos.maxPrice || price > pos.maxPrice) pos.maxPrice = price;   // track day's high mark

    var decision = exitlogic.evaluate(pos, price);
    pos.stopPct = decision.newStopPct;

    if (exitlogic.isEndOfDayWindow() && pos.eodSold !== exitlogic.etDateKey()) {
      var eodQty = Math.max(1, Math.floor(pos.contracts * exitlogic.EOD_SELL_FRAC));
      pos.eodSold = exitlogic.etDateKey();
      await eodSell(ticker, eodQty, price, decision.gain);
      return;
    }
    if (decision.activateBreakeven) { pos.breakEvenActivated = true; await breakeven(ticker); }
    if (decision.stopOut) {
      var still = account.positions[ticker];
      if (still) { var reason = still.breakEvenActivated ? "Trailing Stop " + decision.newStopPct + "%" : "Initial Stop -15%"; await stop(ticker, price, reason); }
      return;
    }
    if (decision.scaleOut) {
      var s10 = Math.max(1, Math.floor(pos.contracts * decision.sellFraction));
      await profitTier(ticker, 1, s10, price, decision.gain);
      if (account.positions[ticker]) account.positions[ticker].lastProfitTier = decision.newTier;
    }
  }

  return {
    cfg: cfg, account: account,
    trades: function(t) { return cfg.tickers.indexOf(t) !== -1; },
    entry: entry, add: add, stop: stop, fullClose: fullClose,
    breakeven: breakeven, profitTier: profitTier, eodSell: eodSell,
    openPositions: openPositions, dailySummary: dailySummary, morning: morning,
    pollPosition: pollPosition, updateLastKnownPrice: updateLastKnownPrice,
    getAccount: function() { return account; }
  };
}

// ── channel registry + fan-out ──────────────────────────────────────────────
var channels = [];

function buildChannelConfigs() {
  var list = [];
  if (process.env.DISCORD_WEBHOOK_URL)
    list.push({ id: "main", name: "Argus ORB Trader 50K", webhook: process.env.DISCORD_WEBHOOK_URL, startBalance: 50000, contracts: 50, tickers: ["SPY", "IWM"], dte: null, updateMins: 15, theme: "default" });
  if (process.env.DISCORD_WEBHOOK_FREE)
    list.push({ id: "free", name: "Free Alerts", webhook: process.env.DISCORD_WEBHOOK_FREE, startBalance: 10000, contracts: 10, tickers: ["IWM"], dte: 0, updateMins: 30, theme: "free" });
  if (process.env.DISCORD_WEBHOOK_SPY0DTE)
    list.push({ id: "spy0dte", name: "SPY 0DTE", webhook: process.env.DISCORD_WEBHOOK_SPY0DTE, startBalance: 10000, contracts: 5, tickers: ["SPY"], dte: 0, updateMins: 30, theme: "spy" });
  return list;
}

function forTicker(ticker, fn) { return Promise.all(channels.filter(function(c){ return c.trades(ticker); }).map(fn)); }

async function onEntry(ticker, side, optionPrice, orbHigh, orbLow, underlying) { await forTicker(ticker, function(c){ return c.entry(ticker, side, optionPrice, orbHigh, orbLow, underlying); }); }
async function onAdd(ticker, optionPrice) { await forTicker(ticker, function(c){ return c.add(ticker, optionPrice); }); }
async function onStop(ticker, optionPrice, reason) { await forTicker(ticker, function(c){ return c.stop(ticker, optionPrice, reason); }); }
async function onFullClose(ticker, optionPrice) { await forTicker(ticker, function(c){ return c.fullClose(ticker, optionPrice); }); }

// ── schedulers ──────────────────────────────────────────────────────────────
function scheduleMorning(channel) {
  var alerts = [
    { utcHour: 12, utcMin: 45, m: 45 }, { utcHour: 12, utcMin: 30, m: 60 },
    { utcHour: 13, utcMin: 0,  m: 30 }, { utcHour: 13, utcMin: 25, m: 5 },
    { utcHour: 13, utcMin: 29, m: 1 }
  ];
  function msUntil(h, mi) { var now=new Date(); var t=new Date(); t.setUTCHours(h,mi,0,0); if(t<=now)t.setUTCDate(t.getUTCDate()+1); return t-now; }
  alerts.forEach(function(a) {
    (function next() { setTimeout(async function(){ await channel.morning(a.m); next(); }, msUntil(a.utcHour, a.utcMin)); })();
  });
}

function scheduleUpdates(channel) {
  var stepMs = channel.cfg.updateMins * 60 * 1000;
  function msUntilNext() { var now=new Date(); var ms = now.getUTCMinutes()*60000 + now.getUTCSeconds()*1000 + now.getUTCMilliseconds(); var into = ms % stepMs; return stepMs - into; }
  (function next() {
    setTimeout(async function() { if (paperMarketHours()) await channel.openPositions(channel.cfg.updateMins + "-Min Update"); next(); }, msUntilNext());
  })();
  console.log("[DISCORD] " + channel.cfg.id + " position updates every " + channel.cfg.updateMins + " min");
}

function scheduleDaily(channel) {
  function msUntil4pmET() { var now=new Date(); var t=new Date(); t.setUTCHours(20,0,0,0); if(t<=now)t.setUTCDate(t.getUTCDate()+1); return t-now; }
  (function next() { setTimeout(async function(){ await channel.dailySummary(); next(); }, msUntil4pmET()); })();
}

function initChannels(getToken) {
  channels = buildChannelConfigs().map(createChannel);
  if (channels.length === 0) { console.log("[DISCORD] no channels active (set DISCORD_WEBHOOK_URL / _FREE / _SPY0DTE)"); return; }
  console.log("[DISCORD] active channels: " + channels.map(function(c){ return c.cfg.id + "(" + c.cfg.tickers.join("+") + "," + c.cfg.contracts + "c)"; }).join(", "));
  channels.forEach(function(c) { scheduleMorning(c); scheduleUpdates(c); scheduleDaily(c); });
  // shared paper engine: one 30s loop pricing every channel's positions
  setInterval(async function() {
    try {
      if (!paperMarketHours()) return;
      var rhAvailable = !!(getToken && getToken());
      if (!rhAvailable) {
        // Still backfill strikes from Yahoo so position labels aren't "?".
        try { await rh.reauthorize(); rhAvailable = !!(getToken && getToken()); } catch (e) {}
      }
      for (var i = 0; i < channels.length; i++) {
        var c = channels[i];
        for (var j = 0; j < c.cfg.tickers.length; j++) { await c.pollPosition(c.cfg.tickers[j], rhAvailable); }
      }
    } catch (e) { console.log("[PAPER_ENGINE_ERROR] " + e.message); }
  }, 30 * 1000);
  console.log("[DISCORD] paper engine started — marks every 30s");
}

// ── compat shims for /test/discord routes (target the first active channel) ──
function first() { return channels[0] || createChannel({ id: "main", name: "Argus ORB Trader 50K", webhook: process.env.DISCORD_WEBHOOK_URL, startBalance: 50000, contracts: 50, tickers: ["SPY", "IWM"], dte: null, updateMins: 15, theme: "default" }); }

module.exports = {
  initChannels: initChannels,
  onEntry: onEntry, onAdd: onAdd, onStop: onStop, onFullClose: onFullClose,
  getChannels: function() { return channels; },
  // test-route compatibility
  postGoodMorning: function(m) { return first().morning(m); },
  postDailySummary: function() { return first().dailySummary(); },
  postOpenPositions: function(l) { return first().openPositions(l); },
  postEntry: function(ticker, side, optPrice, orbHigh, orbLow, underlying) { return first().entry(ticker, side, optPrice, orbHigh, orbLow, underlying); },
  postStopLoss: function(ticker, price, reason) { return first().stop(ticker, price, reason); },
  postProfitTier: function(ticker, tierNum, sell, price, gain) { return first().profitTier(ticker, tierNum, sell, price, gain); }
};
