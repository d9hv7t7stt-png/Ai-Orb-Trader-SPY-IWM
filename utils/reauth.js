var rh = require("./robinhood");
var stateModule = require("./state");

async function ensureLoggedIn() {
  var email = process.env.RH_EMAIL;
  var password = process.env.RH_PASSWORD;
  var mfa = process.env.RH_MFA_CODE;
  var token = process.env.RH_TOKEN;

  // If we already have a token stored in env, use it
  if (token && !rh.getToken()) {
    rh.setToken(token);
    stateModule.logEvent("AUTH", "Using stored RH_TOKEN");
    return true;
  }

  // If already logged in
  if (rh.getToken()) {
    stateModule.logEvent("AUTH", "Already logged in");
    return true;
  }

  // Login fresh
  stateModule.logEvent("AUTH", "Logging into Robinhood...");
  var result = await rh.login(email, password, mfa);
  
  if (result.ok) {
    stateModule.logEvent("AUTH", "Robinhood login successful");
    return true;
  } else if (result.mfa_required) {
    stateModule.logEvent("AUTH_ERROR", "MFA required — set RH_MFA_CODE in Railway variables");
    return false;
  } else if (result.challenge) {
    stateModule.logEvent("AUTH_CHALLENGE", "Challenge required: " + result.challenge.type + " — ID: " + result.challenge.id);
    return false;
  } else {
    stateModule.logEvent("AUTH_ERROR", "Login failed: " + result.error);
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

module.exports = { ensureLoggedIn: ensureLoggedIn, scheduleDailyReauth: scheduleDailyReauth };
