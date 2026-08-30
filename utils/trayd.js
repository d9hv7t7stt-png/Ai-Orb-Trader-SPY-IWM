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

async function placeOrder(opts) {
  var expiry = getExpiry(opts.ticker);
  var price = await resolveUnderlying(opts.ticker);
  var strike = Math.round(price);
  if (strike <= 0) throw new Error("Could not resolve underlying price for " + opts.ticker + " — check RH_TOKEN");
  console.log("[ORDER] " + opts.ticker + " " + opts.side + " x" + opts.contracts + " strike=" + strike + " expiry=" + expiry);
  var result = await rh.placeOptionOrder(opts.ticker, opts.side, opts.contracts, expiry, strike, opts.side);
  return { ticker: opts.ticker, side: opts.side, strike: strike, expiry: expiry, contracts: opts.contracts, result: result };
}

async function closePartialPosition(opts) {
  console.log("[CLOSE] " + opts.ticker + " selling " + opts.contracts + "c: " + opts.reason);
  return await rh.closeOptionPosition(opts.ticker, opts.contracts, opts.reason);
}

module.exports = { placeOrder: placeOrder, closePartialPosition: closePartialPosition };
