// Shared secret for /webhook and /api/* routes. Set WEBHOOK_SECRET in Railway.
// TradingView URL: https://your-app.railway.app/webhook?secret=YOUR_SECRET

function getSecret() {
  return process.env.WEBHOOK_SECRET || process.env.API_SECRET || null;
}

function extractSecret(req) {
  return req.query.secret || req.headers["x-webhook-secret"] || req.headers["x-api-secret"] || null;
}

function requireSecret(req, res, next) {
  var secret = getSecret();
  if (!secret) return next();
  if (extractSecret(req) === secret) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function allowTestRoutes() {
  return process.env.ALLOW_TEST_ROUTES === "1" || process.env.NODE_ENV !== "production";
}

module.exports = { requireSecret: requireSecret, allowTestRoutes: allowTestRoutes, getSecret: getSecret };
