#!/usr/bin/env bash
# Build a LIVE-ONLY Whop customer zip (no Discord paper trading).
# Output: /opt/cursor/artifacts/orb-live-whop-customer/ + .zip
# NOT published to GitHub as a customer repo — zip/folder only.
#
# Required to bake seller credentials:
#   WHOP_API_KEY   — Dashboard → Developer → API keys (Bearer token)
#   optional WHOP_PRODUCT_ID — single prod_… override
#   optional WHOP_PRODUCT_IDS — comma-separated prod_… list (default: whop-products.json)
#
# Buyer later sets only:
#   WHOP_LICENSE_KEY — from their Whop Software Licensing purchase

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_ROOT="${CUSTOMER_OUT:-/opt/cursor/artifacts}"
DEST="$OUT_ROOT/orb-live-whop-customer"
ZIP="$OUT_ROOT/orb-live-whop-customer.zip"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -z "${WHOP_API_KEY:-}" ]]; then
  echo "WARNING: WHOP_API_KEY not set — baking placeholder. Rebuild with a real key before selling."
  WHOP_API_KEY="REPLACE_ME_SELLER_API_KEY"
fi

rm -rf "$DEST"
mkdir -p "$DEST/utils" "$DEST/routes" "$DEST/dashboard" "$DEST/config" "$DEST/scripts"

# Core live runtime
cp "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/railway.toml" "$DEST/" 2>/dev/null || cp "$ROOT/package.json" "$DEST/"
cp "$ROOT/server.js" "$DEST/"
cp -R "$ROOT/routes/." "$DEST/routes/"
cp -R "$ROOT/utils/." "$DEST/utils/"
cp -R "$ROOT/dashboard/." "$DEST/dashboard/"

# Whop license module
cp "$ROOT/scripts/whop-customer-templates/whopLicense.js" "$DEST/utils/whopLicense.js"

# Strip seller-only / Discord modules (keep paperLegs — live dual-leg strikes need it)
rm -f "$DEST/utils/discord.js" "$DEST/utils/closeDigest.js" "$DEST/utils/grokContent.js" "$DEST/utils/qqqYahooSignals.js"

# Neutralize Discord requires in alert.js / server.js without breaking live path
python3 - "$DEST" <<'PY'
import re, sys, pathlib
root = pathlib.Path(sys.argv[1])

alert = root / "routes" / "alert.js"
t = alert.read_text()
t = re.sub(
    r'var discord = null;\ntry \{ discord = require\("\.\./utils/discord"\); \} catch \(e\) \{ discord = null; \}\n',
    "var discord = null; // Discord paper trading removed in Whop customer build\n",
    t,
)
t = t.replace(
"""async function notify(fn, args) {
  try {
    if (discord && typeof discord[fn] === "function") return await discord[fn].apply(null, args);
  } catch (e) { console.log("[DISCORD_NOTIFY_ERROR] " + fn + ": " + e.message); }
}""",
"""async function notify(fn, args) {
  return null; // Discord paper trading removed in Whop customer build
}""")
alert.write_text(t)

server = root / "server.js"
s = server.read_text()
s = s.replace('const discord = require("./utils/discord");\n',
              'const whopLicense = require("./utils/whopLicense");\n')
s = s.replace("  discord.initChannels(rh.getToken.bind(rh));\n",
              "  // Discord paper trading removed in Whop customer build\n")
if "whopLicense.startLicenseGate" not in s:
  s = s.replace(
    "app.listen(PORT, async () => {\n  console.log(\"ORB server listening on port \" + PORT);",
    "app.listen(PORT, async () => {\n  await whopLicense.startLicenseGate();\n  console.log(\"ORB server listening on port \" + PORT);"
  )
s = s.replace("var posted = await discord.postSundayPremarket(ch);",
              "var posted = [];")
s = s.replace("var posted = await discord.postExistingOrbs(force);",
              "var posted = [];")
server.write_text(s)
print("patched alert/server")
PY

# Stub remaining discord references for optional test routes
python3 - "$DEST" <<'PY'
import pathlib, sys
server = pathlib.Path(sys.argv[1]) / "server.js"
s = server.read_text()
if "discord." in s and "const discord =" not in s and "var discord =" not in s:
    s = s.replace(
        'const whopLicense = require("./utils/whopLicense");\n',
        'const whopLicense = require("./utils/whopLicense");\n'
        'const discord = { postSundayPremarket: async () => [], postExistingOrbs: async () => [], '
        'postGoodMorning: async () => {}, postDailySummary: async () => {}, postExpectedMoves: async () => {}, '
        'postCloseDigest: async () => {}, postOpenPositions: async () => {}, postEntry: async () => {}, '
        'postStopLoss: async () => {}, postProfitTier: async () => {}, getChannels: () => [], '
        'initChannels: () => {} };\n'
    )
if "await whopLicense.startLicenseGate()" not in s:
    s = s.replace(
        "app.listen(PORT, async () => {\n  console.log(\"ORB server listening on port \" + PORT);",
        "app.listen(PORT, async () => {\n  await whopLicense.startLicenseGate();\n  console.log(\"ORB server listening on port \" + PORT);"
    )
server.write_text(s)
print("server discord stub ready")
PY

python3 - "$DEST" <<'PY'
import re, pathlib, sys
server = pathlib.Path(sys.argv[1]) / "server.js"
s = server.read_text()
s = re.sub(r'const grokContent = require\("\./utils/grokContent"\);\n', "", s)
s = re.sub(r'const qqqYahooSignals = require\("\./utils/qqqYahooSignals"\);\n', "", s)
s = re.sub(
    r'app\.get\("/api/grok/tiktok/dates"[\s\S]*?^\}\);\n\n',
    "",
    s,
    count=1,
    flags=re.M,
)
s = re.sub(
    r'app\.get\("/api/grok/tiktok"[\s\S]*?^\}\);\n\n',
    "",
    s,
    count=1,
    flags=re.M,
)
s = re.sub(
    r'app\.get\("/api/grok/tiktok/daily"[\s\S]*?^\}\);\n\n',
    "",
    s,
    count=1,
    flags=re.M,
)
s = re.sub(
    r'// Build \(or rebuild\)[^\n]*\napp\.get\("/api/grok/tiktok/build"[\s\S]*?^\}\);\n\n',
    "",
    s,
    count=1,
    flags=re.M,
)
s = s.replace("  qqqYahooSignals.startQqqYahooSignals();\n", "  // QQQ Yahoo paper signals removed in Whop customer build\n")
s = re.sub(
    r'\n  app\.get\("/test/grok/tiktok/:channel"[\s\S]*?^\  \}\);\n',
    "\n",
    s,
    count=1,
    flags=re.M,
)
server.write_text(s)
print("server grok/qqq stripped")
PY

python3 - "$DEST" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
trayd = root / "utils" / "trayd.js"
tt = trayd.read_text()
if "whopLicense" not in tt:
  tt = "var whopLicense = require(\"./whopLicense\");\n" + tt
  tt = tt.replace(
    "async function placeOrder(opts) {\n",
    "async function placeOrder(opts) {\n  whopLicense.requireLicense(\"place_order\");\n"
  )
  tt = tt.replace(
    "async function closePartialPosition(opts) {\n",
    "async function closePartialPosition(opts) {\n  whopLicense.requireLicense(\"close_order\");\n"
  )
  trayd.write_text(tt)

pm = root / "utils" / "profitmanager.js"
p = pm.read_text()
if "whopLicense" not in p:
  p = "var whopLicense = require(\"./whopLicense\");\n" + p
  p = p.replace(
    "async function checkProfitTiers() {\n  if (!exitlogic.isRegularMarketHours()) return;\n",
    "async function checkProfitTiers() {\n  if (!whopLicense.isLicensed()) return;\n  if (!exitlogic.isRegularMarketHours()) return;\n"
  )
  pm.write_text(p)
print("patched trayd/profitmanager")
PY

# Bake seller API key + integrity hash
python3 - <<PY
import json, hashlib, pathlib, os
dest = pathlib.Path("$DEST")
root = pathlib.Path("$ROOT")
lic = (dest / "utils" / "whopLicense.js").read_bytes()
sha = hashlib.sha256(lic).hexdigest()
catalog_path = root / "scripts" / "whop-customer-templates" / "whop-products.json"
catalog = json.loads(catalog_path.read_text()) if catalog_path.exists() else {}

if os.environ.get("WHOP_PRODUCT_IDS"):
  product_ids = [p.strip() for p in os.environ["WHOP_PRODUCT_IDS"].split(",") if p.strip()]
elif os.environ.get("WHOP_PRODUCT_ID"):
  product_ids = [os.environ["WHOP_PRODUCT_ID"].strip()]
else:
  product_ids = [p["id"] for p in catalog.get("products", []) if p.get("id")]

company_id = catalog.get("companyId") or ""

cfg = {
  "apiKey": """$WHOP_API_KEY""",
  "productIds": product_ids,
  "productId": product_ids[0] if len(product_ids) == 1 else "",
  "companyId": company_id,
  "licenseModuleSha256": sha,
  "builtAt": "$STAMP",
  "build": "whop-customer-live"
}
(dest / "config" / "whop.baked.json").write_text(json.dumps(cfg, indent=2) + "\n")
print("baked whop config sha=", sha[:16], "products=", len(product_ids))
PY

# Customer env example + setup
cat > "$DEST/.env.example" <<'EOF'
# === Whop (required) ===
# Paste the license key from your Whop purchase (Software Licensing).
# Format: uppercase letters/numbers with dashes, e.g. T-D9825F-713A53FD-DD2E4CW
WHOP_LICENSE_KEY=

# === Robinhood ===
RH_TOKEN=
RH_REFRESH_TOKEN=
RH_DEVICE_TOKEN=
RH_ACCOUNT_NUMBER=

# === App ===
PORT=3000
WEBHOOK_SECRET=
# Optional: enable next-phase live tickers after you confirm RH chains
# LIVE_TICKERS=QQQ,SPX
EOF

cat > "$DEST/WHOP-SETUP.md" <<'EOF'
# ORB Live Trader — Whop Customer Build

Live Robinhood ORB trader only. **No Discord paper trading.**

## What you need (buyer)

After purchase, Whop gives you a **license key**. In Railway (or `.env`), set:

| Variable | Where it comes from |
|----------|---------------------|
| `WHOP_LICENSE_KEY` | Your Whop purchase (Software Licensing) |
| `RH_TOKEN` / `RH_REFRESH_TOKEN` / `RH_DEVICE_TOKEN` / `RH_ACCOUNT_NUMBER` | Your Robinhood login flow |
| Volume mount **`/data`** | Railway → attach a persistent volume |

You do **not** configure Whop API keys or run any seller scripts.

## Install

1. Deploy this package (Railway recommended) with a volume at `/data`.
2. Paste env vars from `.env.example`.
3. Start: `npm install && npm start`
4. On boot the app validates your license with Whop (binds a device id on `/data`).
5. **Every trading day** at **8:30 AM ET** and **9:29 AM ET** the app re-validates.
6. If the license fails or is revoked, the process exits and live orders are blocked.

## Anti-tamper (practical)

- License check on startup (process exits if invalid)
- Re-check **8:30 ET** and **9:29 ET** every trading day
- Device id at `/data/whop-device-id` (survives redeploys on the same volume)
- Live place/close blocked if unlicensed

## Optional

- `WEBHOOK_SECRET` — protect dashboard/API routes (TradingView `/webhook` stays open)
- `LIVE_TICKERS=QQQ,SPX` — only after confirming RH option chains on your account
EOF

cat > "$DEST/README.md" <<'EOF'
# ORB Live Trader (Whop)

Live-only ORB auto-trader for Robinhood. Requires an active Whop license key.

## What you set in Railway

1. **`WHOP_LICENSE_KEY`** — from your Whop purchase (Software Licensing)
2. **Robinhood tokens** — see `.env.example` (`RH_TOKEN`, `RH_REFRESH_TOKEN`, `RH_DEVICE_TOKEN`, `RH_ACCOUNT_NUMBER`)
3. Attach a **volume at `/data`** (license device id + bot state persist)

That is it. You do **not** need a Whop seller API key — licensing is already configured in this build.

See **WHOP-SETUP.md** for full deploy steps.
EOF

# Seller-only helper stays in the repo; do not ship to buyers (avoids confusion).

cat > "$DEST/CHANGELOG.md" <<'EOF'
# Customer build changelog

## 2026-09-02 — Live sell / close reliability (current export)

This export includes Robinhood sell fixes that were missing or broken in earlier customer zips.

### Robinhood closes (stops, tiers, EOD, flips)

- **Close uses the open position's instrument URL** — no re-resolving strike/expiry on 0DTE (fixes "RH won't sell" when the chain lookup fails but RH still holds the contract)
- **Per-leg matching** on dual-leg (0DTE + 1DTE): strike, expiry, side, and instrument URL when closing
- **`closeAllLegs`** for cross-entry stops and dual-leg flatten — both legs get sell orders
- **Profit manager dual-leg path** — each leg managed independently with its own RH mark and close match
- **Reconcile improvements** — backfills entry from RH `average_price`, refuses ambiguous multi-position picks, 10-minute grace before marking flat
- **Fill price normalization** — per-share vs total premium stored correctly so stops/tiers fire at the right levels
- **`syncPositionQty`** — trims no longer re-arm "half in" state after partial sells

### Other live fixes in this build

- Proactive RH token refresh + daily 9:00 AM ET reauth
- Durable webhook queue with retry backoff
- TradingView `/webhook` open (no secret required on webhook itself)
- Dual-leg live toggle + cross-entry toggle on dashboard
- Kill switch (flatten / halt entries)

### Not included (seller production only)

- Discord paper-trading channels
- Grok TikTok content API
- QQQ Yahoo paper signal fallback

### Customer deploy (buyers)

1. Attach a Railway volume at `/data`
2. Set `WHOP_LICENSE_KEY` + Robinhood tokens from `.env.example`
3. Deploy — no seller API key or extra setup required
EOF

# Sanity check: live dual-leg module graph loads
node -e "process.chdir('$DEST'); require('./utils/trayd'); require('./utils/profitmanager'); require('./utils/robinhood'); console.log('customer module check ok')" 

# Zip
rm -f "$ZIP"
( cd "$OUT_ROOT" && zip -qr "$(basename "$ZIP")" "$(basename "$DEST")" )
echo "Built: $DEST"
echo "Zip:   $ZIP ($(du -h "$ZIP" | awk '{print $1}'))"
ls -la "$DEST/utils/whopLicense.js" "$DEST/config/whop.baked.json"
