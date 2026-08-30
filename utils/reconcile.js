// Reconcile in-memory state with open Robinhood option positions.

var rh = require("./robinhood");
var stateModule = require("./state");

function normalizeSide(rhPos) {
  var side = ((rhPos.option_type || rhPos.type || "") + "").toLowerCase();
  return side === "call" || side === "put" ? side : null;
}

function findRhPosition(rhPositions, ticker, pos) {
  var open = rhPositions.filter(function(p) {
    return p.chain_symbol === ticker && parseFloat(p.quantity) > 0;
  });
  if (!open.length) return null;

  if (pos && pos.instrumentUrl) {
    var byUrl = open.find(function(p) { return p.option === pos.instrumentUrl; });
    if (byUrl) return byUrl;
  }
  if (pos && pos.side) {
    var bySide = open.find(function(p) { return normalizeSide(p) === pos.side; });
    if (bySide) return bySide;
    if (pos.strike) {
      var byStrike = open.find(function(p) {
        return normalizeSide(p) === pos.side &&
          Math.round(parseFloat(p.strike_price)) === Math.round(parseFloat(pos.strike));
      });
      if (byStrike) return byStrike;
    }
  }
  return open.length === 1 ? open[0] : null;
}

function entryPriceFromRh(rhPos, markFallback) {
  var avg = parseFloat(rhPos.average_price || rhPos.pending_average_price || 0);
  if (avg > 0) return avg;
  return markFallback && markFallback > 0 ? markFallback : 0;
}

function fillFromRhPosition(rhPos, markFallback) {
  return {
    entryPrice: entryPriceFromRh(rhPos, markFallback),
    instrumentUrl: rhPos.option,
    strike: rhPos.strike_price ? Math.round(parseFloat(rhPos.strike_price)) : null,
    expiry: rhPos.expiration_date || null
  };
}

async function backfillEntryFromRh(ticker, pos, rhPositions) {
  if (!pos || pos.entryPrice > 0) return pos;
  var rhPos = findRhPosition(rhPositions, ticker, pos);
  if (!rhPos) return pos;

  var mark = await rh.getOptionMarkByUrl(rhPos.option);
  var fill = fillFromRhPosition(rhPos, mark);
  if (fill.entryPrice > 0) {
    stateModule.applyOrderFill(ticker, fill);
    return stateModule.getPosition(ticker);
  }
  return pos;
}

async function reconcileRhPositions() {
  if (!rh.getToken()) return { ok: false, reason: "no_token" };
  var auth = await rh.checkAuthStatus();
  if (!auth.ok) return { ok: false, reason: "auth_failed" };

  var rhPositions = await rh.getOpenOptionPositions();
  var tickers = ["SPY", "IWM"];
  var synced = [];

  for (var i = 0; i < tickers.length; i++) {
    var ticker = tickers[i];
    var statePos = stateModule.getPosition(ticker);
    var rhPos = findRhPosition(rhPositions, ticker, statePos);

    if (!rhPos) {
      if (statePos && !statePos.stopped) {
        stateModule.logEvent("RECONCILE", ticker + " state open but RH flat — marking closed");
        stateModule.closePosition(ticker, "reconcile: RH flat");
      }
      continue;
    }

    var side = normalizeSide(rhPos);
    if (!side) continue;

    var qty = Math.max(1, Math.floor(parseFloat(rhPos.quantity)));
    var mark = await rh.getOptionMarkByUrl(rhPos.option);
    var fill = fillFromRhPosition(rhPos, mark);

    if (!statePos || statePos.stopped) {
      var meta = {
        instrumentUrl: fill.instrumentUrl,
        strike: fill.strike,
        expiry: fill.expiry
      };
      if (statePos) {
        meta.crossEntry = !!statePos.crossEntry;
        meta.stopMode = statePos.stopMode || "mid";
      }
      if (!meta.crossEntry && ticker === "SPY") {
        var iwm = stateModule.getPosition("IWM");
        if (iwm && !iwm.stopped && iwm.side === side) {
          meta.crossEntry = true;
          meta.stopMode = side === "call" ? "orb_low" : "orb_high";
        }
      }
      stateModule.importRhPosition(ticker, side, qty, fill.entryPrice, meta);
      stateModule.logEvent("RECONCILE", ticker + " imported RH " + side + " " + qty + "c" +
        (fill.entryPrice ? " @ $" + fill.entryPrice.toFixed(2) : "") +
        (meta.crossEntry ? " (cross-entry stop=" + meta.stopMode + ")" : ""));
      synced.push(ticker);
      continue;
    }

    if (statePos.side !== side) {
      stateModule.logEvent("RECONCILE_WARN", ticker + " state=" + statePos.side + " RH=" + side + " — syncing to RH");
      var sideMeta = {
        instrumentUrl: fill.instrumentUrl,
        strike: fill.strike,
        expiry: fill.expiry,
        crossEntry: !!statePos.crossEntry,
        stopMode: statePos.stopMode || "mid"
      };
      stateModule.importRhPosition(ticker, side, qty, fill.entryPrice || statePos.entryPrice, sideMeta);
      synced.push(ticker);
      continue;
    }

    stateModule.syncPositionQty(ticker, qty);
    var meta = { instrumentUrl: fill.instrumentUrl, strike: fill.strike, expiry: fill.expiry };
    if (!(statePos.entryPrice > 0)) meta.entryPrice = fill.entryPrice;
    stateModule.applyOrderFill(ticker, meta);
    synced.push(ticker);
  }

  return { ok: true, synced: synced };
}

module.exports = {
  findRhPosition: findRhPosition,
  entryPriceFromRh: entryPriceFromRh,
  backfillEntryFromRh: backfillEntryFromRh,
  reconcileRhPositions: reconcileRhPositions
};
