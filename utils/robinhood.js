// Direct Robinhood API - no Trayd, no MCP, no Claude
// Uses Robinhood's private endpoints directly

const https = require("https");

const RH_BASE = "api.robinhood.com";
let _token = null;

function request(method, path, data, token) {
  return new Promise((resolve, reject) => {
    const isForm = method === "POST" && path.includes("oauth2");
    const body = data ? (isForm ? Object.entries(data).map(([k,v]) => encodeURIComponent(k)+"="+encodeURIComponent(v)).join("&") : JSON.stringify(data)) : null;
    const headers = {
      "Accept": "*/*",
      "Accept-Encoding": "gzip, deflate",
      "Accept-Language": "en-US;q=1",
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      "X-Robinhood-API-Version": "1.431.4",
      "Connection": "keep-alive",
      "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
    };
    if (token) headers["Authorization"] = "Bearer " + token;
    if (body) headers["Content-Length"] = Buffer.byteLength(body);

    const options = {
      hostname: RH_BASE,
      path: path,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let raw = "";
      res.on("data", chunk => raw += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(raw)); }
        catch(e) { resolve({ raw }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(email, password, mfa_code) {
  const data = {
    client_id: "c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS",
    expires_in: 86400,
    grant_type: "password",
    password: password,
    scope: "internal",
    username: email,
    challenge_type: "sms",
    device_token: process.env.RH_DEVICE_TOKEN || "ea9eefb5-8c3a-4f8b-b63f-9d4c74dbc79d"
  };
  if (mfa_code) data.mfa_code = mfa_code;

  const res = await request("POST", "/oauth2/token/", data);
  
  if (res.access_token) {
    _token = res.access_token;
    console.log("[AUTH] Robinhood login successful");
    return { ok: true, token: _token };
  } else if (res.mfa_required) {
    console.log("[AUTH] MFA required");
    return { ok: false, mfa_required: true };
  } else if (res.challenge) {
    console.log("[AUTH] Challenge required:", res.challenge.type);
    return { ok: false, challenge: res.challenge };
  } else {
    console.log("[AUTH_ERROR]", JSON.stringify(res));
    return { ok: false, error: JSON.stringify(res) };
  }
}

async function respondToChallenge(challengeId, code) {
  const res = await request("POST", `/challenge/${challengeId}/respond/`, { response: code });
  return res;
}

function setToken(token) {
  _token = token;
}

function getToken() {
  return _token;
}

async function getQuote(ticker) {
  const res = await request("GET", `/quotes/${ticker}/`, null, _token);
  return parseFloat(res.last_trade_price || res.ask_price || 0);
}

async function getOptionChain(ticker, expiry, strike, optionType) {
  const url = `/options/instruments/?chain_symbol=${ticker}&expiration_dates=${expiry}&strike_price=${strike}&type=${optionType}&state=active`;
  const res = await request("GET", url, null, _token);
  return res.results || [];
}

async function placeOptionOrder(ticker, side, contracts, expiry, strike, optionType) {
  // Get option instrument ID
  const instruments = await getOptionChain(ticker, expiry, strike, optionType);
  if (!instruments.length) throw new Error(`No option found: ${ticker} ${expiry} ${strike} ${optionType}`);
  
  const instrumentUrl = instruments[0].url;
  
  // Get current ask price
  const optionQuote = await request("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, _token);
  const askPrice = optionQuote.results?.[0]?.ask_price || "0.50";
  const limitPrice = (parseFloat(askPrice) * 1.05).toFixed(2); // 5% above ask for fast fill

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: side === "call" || optionType === "call" ? "debit" : "debit",
    legs: [{
      option: instrumentUrl,
      position_effect: "open",
      ratio_quantity: 1,
      side: "buy"
    }],
    override_day_trade_checks: false,
    price: limitPrice,
    quantity: contracts,
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit"
  };

  console.log(`[ORDER] ${ticker} ${optionType} x${contracts} strike=${strike} expiry=${expiry} price=${limitPrice}`);
  const res = await request("POST", "/options/orders/", order, _token);
  
  if (res.id) {
    console.log(`[ORDER_OK] Order ID: ${res.id}`);
    return { ok: true, order_id: res.id, price: limitPrice };
  } else {
    throw new Error(JSON.stringify(res));
  }
}

async function closeOptionPosition(ticker, contracts, reason) {
  // Get open positions
  const positions = await request("GET", "/options/positions/?nonzero=true", null, _token);
  const matching = (positions.results || []).filter(p => 
    p.chain_symbol === ticker && parseFloat(p.quantity) > 0
  );
  
  if (!matching.length) {
    console.log(`[CLOSE_WARN] No open position for ${ticker}`);
    return { ok: false, error: "No open position found" };
  }

  const pos = matching[0];
  const instrumentUrl = pos.option;
  
  // Get current bid price
  const quote = await request("GET", `/marketdata/options/?instruments=${encodeURIComponent(instrumentUrl)}`, null, _token);
  const bidPrice = quote.results?.[0]?.bid_price || "0.10";
  const limitPrice = (parseFloat(bidPrice) * 0.95).toFixed(2); // 5% below bid

  const order = {
    account: `https://api.robinhood.com/accounts/${process.env.RH_ACCOUNT_NUMBER}/`,
    direction: "credit",
    legs: [{
      option: instrumentUrl,
      position_effect: "close",
      ratio_quantity: 1,
      side: "sell"
    }],
    price: limitPrice,
    quantity: contracts,
    time_in_force: "gfd",
    trigger: "immediate",
    type: "limit"
  };

  console.log(`[CLOSE] ${ticker} selling ${contracts}c — ${reason}`);
  const res = await request("POST", "/options/orders/", order, _token);
  
  if (res.id) {
    return { ok: true, order_id: res.id, contracts, reason };
  } else {
    throw new Error(JSON.stringify(res));
  }
}

module.exports = { login, setToken, getToken, getQuote, placeOptionOrder, closeOptionPosition, respondToChallenge };
