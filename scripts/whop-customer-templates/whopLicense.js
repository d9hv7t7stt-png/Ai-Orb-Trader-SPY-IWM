// Whop Software Licensing gate for the customer live ORB trader build.
// Buyer sets WHOP_LICENSE_KEY. Seller API key is baked at zip build time.
//
// Docs: https://docs.whop.com/supported-business-models/saas (License key integration)
// POST https://api.whop.com/api/v2/memberships/{licenseKey}/validate_license

var https = require("https");
var crypto = require("crypto");
var os = require("os");
var fs = require("fs");
var path = require("path");

var REVALIDATE_MS = 6 * 60 * 60 * 1000; // every 6 hours
var _ok = false;
var _lastCheck = 0;
var _lastError = null;
var _timer = null;

function readBakedConfig() {
  try {
    return require("../config/whop.baked.json");
  } catch (e) {
    return {};
  }
}

function machineId() {
  var parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    (os.networkInterfaces() && Object.keys(os.networkInterfaces()).join(",")) || "",
    os.userInfo().username || ""
  ];
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32);
}

function apiKey() {
  var baked = readBakedConfig();
  return process.env.WHOP_API_KEY || baked.apiKey || null;
}

function licenseKey() {
  return (process.env.WHOP_LICENSE_KEY || "").trim();
}

function postValidate(license, token, metadata) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify({ metadata: metadata || {} });
    var req = https.request({
      hostname: "api.whop.com",
      path: "/api/v2/memberships/" + encodeURIComponent(license) + "/validate_license",
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    }, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        var parsed = null;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = { raw: raw }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function moduleFingerprint() {
  try {
    var p = path.join(__dirname, "whopLicense.js");
    var buf = fs.readFileSync(p);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch (e) {
    return null;
  }
}

function verifyIntegrity() {
  var baked = readBakedConfig();
  if (!baked.licenseModuleSha256) return true; // older builds
  var fp = moduleFingerprint();
  if (!fp || fp !== baked.licenseModuleSha256) {
    _lastError = "license_module_tampered";
    _ok = false;
    return false;
  }
  return true;
}

async function validateNow() {
  if (!verifyIntegrity()) return false;
  var key = licenseKey();
  var token = apiKey();
  if (!key) {
    _ok = false;
    _lastError = "missing_WHOP_LICENSE_KEY";
    return false;
  }
  if (!token) {
    _ok = false;
    _lastError = "missing_WHOP_API_KEY";
    return false;
  }
  try {
    var res = await postValidate(key, token, { hwid: machineId(), app: "orb-live-trader" });
    // 201 = first bind or matching metadata; 200 also treated as ok on some API versions
    if (res.status === 201 || res.status === 200) {
      var status = (res.body && (res.body.status || (res.body.membership && res.body.membership.status))) || "active";
      var st = String(status).toLowerCase();
      if (st && st !== "active" && st !== "completed" && st !== "trialing" && st !== "valid") {
        _ok = false;
        _lastError = "membership_status_" + st;
        _lastCheck = Date.now();
        return false;
      }
      _ok = true;
      _lastError = null;
      _lastCheck = Date.now();
      return true;
    }
    _ok = false;
    _lastError = "whop_http_" + res.status + (res.body && res.body.error ? (":" + res.body.error) : "");
    _lastCheck = Date.now();
    return false;
  } catch (e) {
    _ok = false;
    _lastError = e.message || "whop_network_error";
    _lastCheck = Date.now();
    return false;
  }
}

function isLicensed() {
  return !!_ok;
}

function lastError() {
  return _lastError;
}

function requireLicense(action) {
  if (!verifyIntegrity() || !_ok) {
    var err = new Error("Whop license required" + (_lastError ? (" (" + _lastError + ")") : "")
      + (action ? (" — blocked: " + action) : ""));
    err.code = "WHOP_LICENSE";
    throw err;
  }
}

async function startLicenseGate() {
  var ok = await validateNow();
  if (!ok) {
    console.error("[LICENSE] Whop validation failed: " + (_lastError || "unknown"));
    console.error("[LICENSE] Set WHOP_LICENSE_KEY from your Whop purchase. Contact support if this persists.");
    process.exit(1);
  }
  console.log("[LICENSE] Whop license OK (hwid bound)");
  if (_timer) clearInterval(_timer);
  _timer = setInterval(function() {
    validateNow().then(function(still) {
      if (!still) {
        console.error("[LICENSE] Revalidation failed: " + (_lastError || "unknown") + " — shutting down");
        process.exit(1);
      }
    });
  }, REVALIDATE_MS);
  return true;
}

module.exports = {
  startLicenseGate: startLicenseGate,
  validateNow: validateNow,
  requireLicense: requireLicense,
  isLicensed: isLicensed,
  lastError: lastError,
  machineId: machineId,
  moduleFingerprint: moduleFingerprint,
  verifyIntegrity: verifyIntegrity
};
