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
  return open[0];
}

async function backfillEntryFromRh(ticker, pos, rhPositions) {
  if (!pos || pos.entryPrice > 0) return pos;
  var rhPos = findRhPosition(rhPositions, ticker, pos);
  if (!rhPos) return pos;

  var mark = await rh.getOptionMarkByUrl(rhPos.option);
  if (mark && mark > 0) {
    stateModule.applyOrderFill(ticker, {
      entryPrice: mark,
      instrumentUrl: rhPos.option,
      strike: rhPos.strike_price ? Math.round(parseFloat(rhPos.strike_price)) : null,
      expiry: rhPos.expiration_date || null
    });
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
    var fill = {
      entryPrice: mark && mark > 0 ? mark : 0,
      instrumentUrl: rhPos.option,
      strike: rhPos.strike_price ? Math.round(parseFloat(rhPos.strike_price)) : null,
      expiry: rhPos.expiration_date || null
    };

    if (!statePos || statePos.stopped) {
      stateModule.openHalfPosition(ticker, side, qty, fill.entryPrice, fill);
      stateModule.logEvent("RECONCILE", ticker + " imported RH " + side + " " + qty + "c" +
        (fill.entryPrice ? " @ $" + fill.entryPrice.toFixed(2) : ""));
      synced.push(ticker);
      continue;
    }

    if (statePos.side !== side) {
      stateModule.logEvent("RECONCILE_WARN", ticker + " state=" + statePos.side + " RH=" + side + " — syncing to RH");
      stateModule.openHalfPosition(ticker, side, qty, fill.entryPrice || statePos.entryPrice, fill);
      synced.push(ticker);
      continue;
    }

    statePos.contracts = qty;
    stateModule.applyOrderFill(ticker, fill);
    if (fill.entryPrice > 0 && statePos.entryPrice <= 0) {
      stateModule.setEntryPrice(ticker, fill.entryPrice);
    }
    synced.push(ticker);
  }

  return { ok: true, synced: synced };
}

module.exports = {
  findRhPosition: findRhPosition,
  backfillEntryFromRh: backfillEntryFromRh,
  reconcileRhPositions: reconcileRhPositions
};
