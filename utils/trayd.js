var MCP_URL = "https://mcp.trayd.ai/mcp";
var ACCOUNT = "775450752";

function getExpiry(ticker) {
  var target = new Date();
  if (ticker === "SPY") {
    target.setDate(target.getDate() + 1);
    if (target.getDay() === 6) target.setDate(target.getDate() + 2);
    if (target.getDay() === 0) target.setDate(target.getDate() + 1);
  }
  return target.toISOString().split("T")[0];
}

async function callTrayd(message) {
  var res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: message }],
      mcp_servers: [{ type: "url", url: MCP_URL, name: "trayd" }]
    })
  });
  var data = await res.json();
  var block = data.content && data.content.find(function(b) { return b.type === "mcp_tool_result"; });
  if (block && block.content && block.content[0] && block.content[0].text) {
    try { return JSON.parse(block.content[0].text); } catch(e) { return { raw: block.content[0].text }; }
  }
  return { message: "no result" };
}

async function placeOrder(opts) {
  var expiry = getExpiry(opts.ticker);
  var quote = await callTrayd("Get quote for " + opts.ticker + " using get_quote.");
  var price = parseFloat((quote && (quote.last_trade_price || quote.ask_price)) || 0);
  var strike = Math.round(price);
  console.log("[ORDER] " + opts.ticker + " " + opts.side + " x" + opts.contracts + " strike=" + strike + " expiry=" + expiry);
  var result = await callTrayd(
    "Buy " + opts.contracts + " " + opts.ticker + " " + expiry + " " + opts.side +
    " option at " + strike + " strike. Account " + ACCOUNT + ". Use place_order."
  );
  return { ticker: opts.ticker, side: opts.side, strike: strike, expiry: expiry, contracts: opts.contracts, result: result };
}

async function closePartialPosition(opts) {
  console.log("[CLOSE] " + opts.ticker + " selling " + opts.contracts + "c: " + opts.reason);
  var result = await callTrayd(
    "Sell " + opts.contracts + " " + opts.ticker +
    " options to close. Account " + ACCOUNT + ". Use place_order with side=sell."
  );
  return { ticker: opts.ticker, contracts: opts.contracts, reason: opts.reason, result: result };
}

module.exports = {
  placeOrder: placeOrder,
  closePartialPosition: closePartialPosition
};
