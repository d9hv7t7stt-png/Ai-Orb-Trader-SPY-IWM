var rh = require("./robinhood");
var yahoo = require("./yahoo");
var stateModule = require("./state");
var expiryUtil = require("./expiry");

function getExpiry(ticker) {
  return expiryUtil.getExpiry(ticker);
}

async function resolveUnderlying(ticker) {
  var price = await rh.getQuote(ticker);
  if (price && price > 0) return price;
  var y = await yahoo.getUnderlyingPrice(ticker);
  if (y && y > 0) {
    console.log("[ORDER] " + ticker + " RH quote unavailable — Yahoo underlying $" + y.toFixed(2));
    return y;
  }
  return 0;
}

async function resolveEntryPrice(instrumentUrl, limitPrice) {
  if (instrumentUrl) {
    try {
      var mark = await rh.getOptionMarkByUrl(instrumentUrl);
      if (mark && mark > 0) return mark;
    } catch (e) {}
  }
  var lp = parseFloat(limitPrice);
  return lp > 0 ? lp : 0;
}

async function placeOrder(opts) {
  var expiry = getExpiry(opts.ticker);
  var price = await resolveUnderlying(opts.ticker);
  var strike = Math.round(price);
  if (strike <= 0) throw new Error("Could not resolve underlying price for " + opts.ticker + " — check RH_TOKEN");
  console.log("[ORDER] " + opts.ticker + " " + opts.side + " x" + opts.contracts + " strike=" + strike + " expiry=" + expiry);
  var result = await rh.placeOptionOrder(opts.ticker, opts.side, opts.contracts, expiry, strike, opts.side);
  var entryPrice = 0;
  if (result.order_id) {
    entryPrice = await rh.waitForFillPrice(result.order_id, result.instrumentUrl);
  }
  if (!entryPrice) entryPrice = await resolveEntryPrice(result.instrumentUrl, result.price);
  return {
    ticker: opts.ticker,
    side: opts.side,
    strike: result.strike || strike,
    expiry: result.expiry || expiry,
    contracts: opts.contracts,
    entryPrice: entryPrice,
    instrumentUrl: result.instrumentUrl || null,
    result: result
  };
}

function closeMatchFromState(ticker) {
  var pos = stateModule.getPosition(ticker);
  if (!pos || pos.stopped) return {};
  return {
    side: pos.side,
    strike: pos.strike,
    expiry: pos.expiry,
    instrumentUrl: pos.instrumentUrl
  };
}

async function closePartialPosition(opts) {
  console.log("[CLOSE] " + opts.ticker + " selling " + opts.contracts + "c: " + opts.reason);
  var match = opts.match || closeMatchFromState(opts.ticker);
  return await rh.closeOptionPosition(opts.ticker, opts.contracts, opts.reason, match);
}

module.exports = { placeOrder: placeOrder, closePartialPosition: closePartialPosition };
