var rh = require("./robinhood");
var stateModule = require("./state");

var pendingWorkflow = null;

async function refreshAccessToken() {
  var refreshToken = rh.getStoredRefreshToken();
  if (!refreshToken) return false;
  try {
    stateModule.logEvent("AUTH", "Refreshing access token...");
    var result = await rh.refreshToken(refreshToken);
    if (result.ok) {
      stateModule.logEvent("AUTH", "Token refreshed successfully");
      return true;
    }
    stateModule.logEvent("AUTH_ERROR", "Token refresh failed: " + result.error);
    return false;
  } catch (err) {
    stateModule.logEvent("AUTH_ERROR", "Token refresh error: " + err.message);
    return false;
  }
}

async function verifyCurrentToken() {
  if (!rh.getToken()) return false;
  var status = await rh.checkAuthStatus();
  if (status.ok) return true;
  stateModule.logEvent("AUTH_ERROR", "Access token rejected — update RH_TOKEN or refresh token in Railway");
  rh.setToken(null);
  return false;
}

async function ensureLoggedIn() {
  if (rh.getToken()) {
    if (await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Session verified");
      return true;
    }
  }

  var refreshToken = rh.getStoredRefreshToken();
  if (refreshToken) {
    var refreshed = await refreshAccessToken();
    if (refreshed && await verifyCurrentToken()) return true;
  }

  var storedToken = process.env.RH_TOKEN;
  if (storedToken) {
    rh.setToken(storedToken);
    if (await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Using stored RH_TOKEN — verified");
      return true;
    }
    stateModule.logEvent("AUTH_ERROR", "RH_TOKEN in Railway is expired — paste a fresh token");
  }

  var email = process.env.RH_EMAIL;
  var password = process.env.RH_PASSWORD;
  var mfa = process.env.RH_MFA_CODE;

  if (!email || !password) {
    stateModule.logEvent("AUTH_ERROR", "No valid token — set RH_TOKEN or RH_EMAIL/RH_PASSWORD in Railway");
    return false;
  }

  stateModule.logEvent("AUTH", "Logging into Robinhood...");
  var result = await rh.login(email, password, mfa);

  if (result.ok && await verifyCurrentToken()) {
    stateModule.logEvent("AUTH", "Login successful");
    pendingWorkflow = null;
    return true;
  }

  if (result.verification_workflow) {
    stateModule.logEvent("AUTH", "Robinhood verification required — checking for challenge...");
    try {
      var challenge = await rh.handleVerificationWorkflow(result.device_token, result.workflow_id);
      pendingWorkflow = {
        challenge_id: challenge.challenge_id,
        challenge_type: challenge.challenge_type,
        machine_id: challenge.machine_id,
        device_token: result.device_token,
        workflow_id: result.workflow_id,
        email: email,
        password: password
      };

      if (challenge.challenge_type === "prompt") {
        stateModule.logEvent("AUTH", "Push notification sent — tap Approve on your Robinhood app");
        var approved = await rh.waitForPushApproval(challenge.challenge_id);
        if (approved) {
          await rh.completeWorkflow(challenge.machine_id);
          var retry = await rh.login(email, password, mfa);
          if (retry.ok && await verifyCurrentToken()) {
            stateModule.logEvent("AUTH", "Login successful after push approval");
            pendingWorkflow = null;
            return true;
          }
        }
      } else if (challenge.challenge_type === "sms" || challenge.challenge_type === "email") {
        stateModule.logEvent("AUTH_CHALLENGE", "SMS/email code required — enter it in the dashboard");
      }
    } catch (err) {
      stateModule.logEvent("AUTH_ERROR", "Verification failed: " + err.message);
    }
    return false;
  }

  if (result.mfa_required) {
    stateModule.logEvent("AUTH_ERROR", "MFA required — add RH_MFA_CODE to Railway variables");
    return false;
  }

  stateModule.logEvent("AUTH_ERROR", "Login failed: " + (result.error || "unknown"));
  return false;
}

async function submitSmsCode(code) {
  if (!pendingWorkflow) return { ok: false, error: "No pending verification" };
  try {
    await rh.respondToSmsChallenge(pendingWorkflow.challenge_id, code);
    await rh.completeWorkflow(pendingWorkflow.machine_id);
    var retry = await rh.login(pendingWorkflow.email, pendingWorkflow.password);
    if (retry.ok && await verifyCurrentToken()) {
      stateModule.logEvent("AUTH", "Login successful after SMS code");
      pendingWorkflow = null;
      return { ok: true };
    }
    return { ok: false, error: "Login failed after SMS code" };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function getPendingWorkflow() { return pendingWorkflow; }

function scheduleDailyReauth() {
  var exitlogic = require("./exitlogic");
  stateModule.logEvent("AUTH", "Daily reauth scheduler started (9:00 AM ET)");
  function scheduleNext() {
    var delay = exitlogic.msUntilNextTimeET(9, 0);
    stateModule.logEvent("AUTH", "Next reauth in " + Math.round(delay / 60000) + " min");
    setTimeout(async function() {
      rh.setToken(null);
      await ensureLoggedIn();
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

async function getAuthInfo() {
  var pending = !!pendingWorkflow;
  if (!rh.getToken()) {
    return { logged_in: false, verified: false, pending: pending, status: pending ? "pending_verification" : "disconnected" };
  }
  var status = await rh.checkAuthStatus();
  if (status.ok) return { logged_in: true, verified: true, pending: pending, status: "connected" };
  return { logged_in: false, verified: false, pending: pending, status: "token_expired" };
}

module.exports = {
  ensureLoggedIn: ensureLoggedIn,
  submitSmsCode: submitSmsCode,
  getPendingWorkflow: getPendingWorkflow,
  scheduleDailyReauth: scheduleDailyReauth,
  getAuthInfo: getAuthInfo,
  verifyCurrentToken: verifyCurrentToken
};
