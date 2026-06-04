var stateModule = require("./state");
var MCP_URL = "https://mcp.trayd.ai/mcp";

function getCreds() {
  var email = process.env.RH_EMAIL;
  var password = process.env.RH_PASSWORD;
  if (!email || !password) throw new Error("RH_EMAIL and RH_PASSWORD env vars must be set");
  return { email: email, password: password };
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

async function ensureLoggedIn() {
  try {
    var status = await callTrayd("Check Robinhood login status using check_login_status.");
    if (status && (status.logged_in === true || status.status === "logged_in")) {
      stateModule.logEvent("AUTH", "Robinhood session active");
      return true;
    }
    return await linkRobinhood();
  } catch(err) {
    stateModule.logEvent("AUTH_ERROR", err.message);
    return false;
  }
}

async function linkRobinhood() {
  var creds = getCreds();
  stateModule.logEvent("AUTH", "Re-linking Robinhood...");
  try {
    var link = await callTrayd('Link Robinhood using link_robinhood with email="' + creds.email + '" and password="' + creds.password + '".');
    if (link && link.status === "awaiting_approval") {
      stateModule.logEvent("AUTH", "Phone notification sent, waiting 20s...");
      await new Promise(function(r) { setTimeout(r, 20000); });
      var complete = await callTrayd('Complete link using complete_robinhood_link with email="' + creds.email + '" and password="' + creds.password + '".');
      if (complete && complete.status === "logged_in") {
        stateModule.logEvent("AUTH", "Re-link successful");
        return true;
      }
    }
    stateModule.logEvent("AUTH_ERROR", "Re-link failed: " + JSON.stringify(link));
    return false;
  } catch(err) {
    stateModule.logEvent("AUTH_ERROR", err.message);
    return false;
  }
}

function scheduleDailyReauth() {
  stateModule.logEvent("AUTH", "Daily reauth scheduler started");
  function msUntilNext9amET() {
    var now = new Date();
    var target = new Date();
    target.setUTCHours(13, 0, 0, 0);
    if (target <= now) target.setUTCDate(target.getUTCDate() + 1);
    return target - now;
  }
  function scheduleNext() {
    var delay = msUntilNext9amET();
    stateModule.logEvent("AUTH", "Next reauth in " + Math.round(delay / 60000) + " min");
    setTimeout(async function() {
      await ensureLoggedIn();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

module.exports = {
  ensureLoggedIn: ensureLoggedIn,
  scheduleDailyReauth: scheduleDailyReauth
};
