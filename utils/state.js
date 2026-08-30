var fs = require("fs");
var persist = require("./persist");

var PERSIST_FILE = persist.filePath("orb-state.json");

function etDateKey() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

function loadPersistedState() {
  try {
    if (fs.existsSync(PERSIST_FILE)) return JSON.parse(fs.readFileSync(PERSIST_FILE, "utf8"));
  } catch (e) {}
  return null;
}

function savePersistedState() {
  try {
    fs.writeFileSync(PERSIST_FILE, JSON.stringify({
      contracts: state.contracts,
      orb: state.orb,
      positions: state.positions,
      lastReset: state.lastReset
    }));
  } catch (e) {}
}

var _saved = loadPersistedState();
var _today = etDateKey();

function freshOrb() {
  return {
    SPY: { high: null, low: null, mid: null, set: false, date: null, source: null },
    IWM: { high: null, low: null, mid: null, set: false, date: null, source: null }
  };
}

function restoreOrb(savedOrb) {
  var orb = freshOrb();
  if (!savedOrb) return orb;
  ["SPY", "IWM"].forEach(function(t) {
    var o = savedOrb[t];
    if (o && o.set && o.date === _today) orb[t] = o;
  });
  return orb;
}

function restorePositions(savedPos) {
  var positions = { SPY: null, IWM: null };
  if (!savedPos || _saved.lastReset !== _today) return positions;
  ["SPY", "IWM"].forEach(function(t) {
    if (savedPos[t] && !savedPos[t].stopped) positions[t] = savedPos[t];
  });
  return positions;
}

let state = {
  contracts: (_saved && _saved.contracts) ? _saved.contracts : { SPY: 1, IWM: 1 },
  orb: restoreOrb(_saved && _saved.orb),
  positions: restorePositions(_saved && _saved.positions),
  lastReset: (_saved && _saved.lastReset === _today) ? _saved.lastReset : null,
  log: []
};

function getState() { return state; }

function resetDay() {
  var today = etDateKey();
  if (state.lastReset !== today) {
    var hadPrior = !!state.lastReset;
    state.orb = freshOrb();
    state.positions = { SPY: null, IWM: null };
    if (hadPrior && process.env.ORB_DAILY_INCREMENT !== "0") {
      state.contracts.SPY = Math.min(100, (state.contracts.SPY || 1) + 1);
      state.contracts.IWM = Math.min(100, (state.contracts.IWM || 1) + 1);
      logEvent("CONTRACTS", "Daily +1 → SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
    }
    state.lastReset = today;
    logEvent("DAY_RESET", "New day. Contracts SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
    savePersistedState();
  }
}

function setORB(ticker, high, low, source) {
  var h = parseFloat(high);
  var l = parseFloat(low);
  var mid = parseFloat(((h + l) / 2).toFixed(4));
  var etDate = etDateKey();
  state.orb[ticker] = { high: h, low: l, mid: mid, set: true, date: etDate, source: source || "webhook" };
  logEvent("ORB_SET", ticker + " High=" + h + " Low=" + l + " Mid=" + mid + " (" + (source || "webhook") + ")");
  savePersistedState();
}

function getPosition(ticker) { return state.positions[ticker]; }

function openHalfPosition(ticker, side, contracts, entryPrice, meta) {
  meta = meta || {};
  state.positions[ticker] = {
    side: side,
    halfIn: true,
    fullIn: false,
    contracts: contracts,
    totalContracts: contracts,
    entryPrice: parseFloat(entryPrice) || 0,
    breakEvenActivated: false,
    lastProfitTier: 0,
    stopPct: null,
    stopped: false,
    crossEntry: !!meta.crossEntry,
    stopMode: meta.stopMode || "mid",
    strike: meta.strike || null,
    expiry: meta.expiry || null,
    instrumentUrl: meta.instrumentUrl || null
  };
  logEvent("POSITION_OPEN", ticker + " " + side + " half " + contracts + "c @ $" + entryPrice +
    (meta.crossEntry ? " (cross-entry stop=" + meta.stopMode + ")" : ""));
  savePersistedState();
}

function addSecondHalf(ticker, contracts, fillPrice) {
  var pos = state.positions[ticker];
  if (!pos || pos.fullIn) return;
  pos.contracts += contracts;
  pos.fullIn = true;
  pos.halfIn = false;
  logEvent("POSITION_ADD", ticker + " +half +" + contracts + "c @ $" + fillPrice + " total=" + pos.contracts);
  savePersistedState();
}

function setBreakEven(ticker) {
  var pos = state.positions[ticker];
  if (pos && !pos.breakEvenActivated) {
    pos.breakEvenActivated = true;
    logEvent("BREAKEVEN", ticker + " breakeven stop activated @ entry $" + pos.entryPrice);
    savePersistedState();
  }
}

function markProfitTier(ticker, tier) {
  var pos = state.positions[ticker];
  if (pos) {
    pos.lastProfitTier = Math.max(pos.lastProfitTier, tier);
    savePersistedState();
  }
}

function reduceContracts(ticker, sold) {
  var pos = state.positions[ticker];
  if (!pos) return;
  pos.contracts = Math.max(0, pos.contracts - sold);
  savePersistedState();
}

function closePosition(ticker, reason) {
  var pos = state.positions[ticker];
  if (pos) {
    pos.stopped = true;
    logEvent("POSITION_CLOSE", ticker + " closed: " + reason);
    savePersistedState();
  }
}

function setEntryPrice(ticker, price) {
  var pos = state.positions[ticker];
  if (pos && price > 0) {
    pos.entryPrice = parseFloat(price);
    savePersistedState();
  }
}

function applyOrderFill(ticker, order) {
  if (!order) return;
  var pos = state.positions[ticker];
  if (!pos || pos.stopped) return;
  if (order.entryPrice && order.entryPrice > 0) pos.entryPrice = parseFloat(order.entryPrice);
  if (order.instrumentUrl) pos.instrumentUrl = order.instrumentUrl;
  if (order.strike) pos.strike = Math.round(parseFloat(order.strike));
  if (order.expiry) pos.expiry = order.expiry;
  savePersistedState();
  if (order.entryPrice && order.entryPrice > 0) {
    logEvent("ENTRY_FILL", ticker + " live entry @ $" + parseFloat(order.entryPrice).toFixed(2));
  }
}

function setContractSize(spy, iwm) {
  state.contracts.SPY = Math.min(100, Math.max(1, parseInt(spy, 10) || 1));
  state.contracts.IWM = Math.min(100, Math.max(1, parseInt(iwm, 10) || 1));
  savePersistedState();
  logEvent("CONTRACTS", "Size updated SPY=" + state.contracts.SPY + " IWM=" + state.contracts.IWM);
}

function getTradeSizingFromTotal(total) {
  total = Math.min(100, Math.max(1, parseInt(total, 10) || 1));
  var half = Math.ceil(total / 2);
  return {
    total: total,
    halfEntry: half,
    retestAdd: half,
    fullPosition: half * 2
  };
}

function getTradeSizing(ticker) {
  return getTradeSizingFromTotal(state.contracts[ticker] || 1);
}

function inferPositionPhase(ticker, qty) {
  var half = getTradeSizing(ticker).halfEntry;
  var q = Math.max(1, Math.floor(parseFloat(qty) || 1));
  var isFull = q > half;
  return { halfIn: !isFull, fullIn: isFull, contracts: q, totalContracts: half };
}

function importRhPosition(ticker, side, qty, entryPrice, meta) {
  meta = meta || {};
  var phase = inferPositionPhase(ticker, qty);
  state.positions[ticker] = {
    side: side,
    halfIn: phase.halfIn,
    fullIn: phase.fullIn,
    contracts: phase.contracts,
    totalContracts: phase.totalContracts,
    entryPrice: parseFloat(entryPrice) || 0,
    breakEvenActivated: false,
    lastProfitTier: 0,
    stopPct: null,
    stopped: false,
    crossEntry: !!meta.crossEntry,
    stopMode: meta.stopMode || "mid",
    strike: meta.strike || null,
    expiry: meta.expiry || null,
    instrumentUrl: meta.instrumentUrl || null
  };
  logEvent("POSITION_OPEN", ticker + " " + side + " " + phase.contracts + "c @ $" + entryPrice +
    (phase.halfIn ? " (half)" : " (full)") +
    (meta.crossEntry ? " cross-entry stop=" + meta.stopMode : "") + " [reconcile]");
  savePersistedState();
}

function syncPositionQty(ticker, qty) {
  var pos = state.positions[ticker];
  if (!pos || pos.stopped) return;
  var phase = inferPositionPhase(ticker, qty);
  pos.contracts = phase.contracts;
  pos.halfIn = phase.halfIn;
  pos.fullIn = phase.fullIn;
  pos.totalContracts = phase.totalContracts;
  savePersistedState();
}

function logEvent(type, message) {
  var entry = { time: new Date().toISOString(), type: type, message: message };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log("[" + type + "] " + message);
}

module.exports = {
  getState: getState,
  resetDay: resetDay,
  setORB: setORB,
  getPosition: getPosition,
  openHalfPosition: openHalfPosition,
  addSecondHalf: addSecondHalf,
  setBreakEven: setBreakEven,
  markProfitTier: markProfitTier,
  reduceContracts: reduceContracts,
  closePosition: closePosition,
  setEntryPrice: setEntryPrice,
  applyOrderFill: applyOrderFill,
  setContractSize: setContractSize,
  getTradeSizing: getTradeSizing,
  getTradeSizingFromTotal: getTradeSizingFromTotal,
  inferPositionPhase: inferPositionPhase,
  importRhPosition: importRhPosition,
  syncPositionQty: syncPositionQty,
  logEvent: logEvent,
  etDateKey: etDateKey
};
