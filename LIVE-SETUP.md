# ORB Live Trader — Setup Guide

Live Opening Range Breakout auto-trader for **SPY** and **IWM** options through **Robinhood**. TradingView sends the signal. This server places and manages the orders.

This guide covers **live trading only**.

---

## What you get

- A webhook server that receives TradingView alerts
- Live Robinhood option orders (ATM, configurable 0DTE–5DTE)
- Dashboard to watch buying power, positions, sizing, and DTE
- Automatic opening-range capture (9:30–9:35 ET, 5-minute bar)
- Profit manager during regular hours:
  - Initial stop at **−15%** of option premium
  - Scale out **10%** of the position every **+20%**
  - Breakeven stop at **+30%**
  - Trailing stop: **+10%** for every additional **+20%** after breakeven
  - End-of-day trim: **50%** of remaining size at **3:45–4:00 PM ET**

**You need:** a Robinhood account with options enabled, a TradingView account, and a Railway account (free tier works to start).

This is not financial advice. Options can go to zero. Size so a full loser is acceptable.

---

## 1. Deploy on Railway

1. Create an account at [railway.app](https://railway.app) and start a **New Project**.
2. Add a service from **GitHub** and point it at this repository (branch `main`).
3. Railway will detect Node and run `node server.js`.
4. Open the service → **Settings → Networking → Generate Domain**.  
   Copy that URL. Example: `https://your-app.up.railway.app`
5. Confirm it is up: open `https://your-app.up.railway.app/health`  
   You should see `"status":"running"`.

### Attach a volume (strongly recommended)

Without a volume, a redeploy wipes session tokens and the day’s positions.

1. Service → **Volumes** → add a volume.
2. Mount path: `/data`
3. Redeploy once after attaching it.

---

## 2. Environment variables

Service → **Variables**. Set these, then redeploy.

### Required for live orders

| Variable | Purpose |
|---|---|
| `RH_TOKEN` | Robinhood **access** token (Bearer). Paste a fresh one if login shows disconnected. |
| `RH_ACCOUNT_NUMBER` | Your Robinhood account id (the UUID in Robinhood API account URLs, not your email). |

### Strongly recommended

| Variable | Purpose |
|---|---|
| `RH_REFRESH_TOKEN` | Lets the server refresh the session so you are not pasting `RH_TOKEN` every morning. |
| `WEBHOOK_SECRET` | Shared secret so strangers cannot fire your webhook. Use a long random string. |

### Optional login fallback

Use these only if you cannot supply a token. Robinhood often requires device/SMS verification; token + refresh is more reliable.

| Variable | Purpose |
|---|---|
| `RH_EMAIL` | Robinhood email |
| `RH_PASSWORD` | Robinhood password |
| `RH_MFA_CODE` | Current authenticator code, if you use app-based 2FA |

### Optional behavior

| Variable | Default | Purpose |
|---|---|---|
| `ORB_DAILY_INCREMENT` | on | Set to `0` to **disable** the automatic +1 contract per ticker each new trading day. |
| `ORB_DEDUP_MS` | `30000` | Ignore duplicate TradingView signals for the same ticker/event within this many milliseconds. |

Do not set any other webhook or chat variables. This product is live Robinhood only.

---

## 3. Connect Robinhood

1. Put `RH_TOKEN` and `RH_ACCOUNT_NUMBER` in Railway Variables and redeploy.
2. Open the dashboard at your Railway URL.
3. If you set `WEBHOOK_SECRET`, open:  
   `https://your-app.up.railway.app/?secret=YOUR_SECRET`
4. Go to **Settings → Test Connection**. Status should show connected / verified.
5. **Dashboard** should show **Buying Power** from Robinhood.

If auth fails with `invalid_grant` or “update to the newest version”:

- Paste a **new** `RH_TOKEN` (old access tokens expire quickly).
- Update `RH_REFRESH_TOKEN` if you have a newer refresh token.
- Redeploy, then tap **Test Connection** again.

The server also tries to refresh the token on its own. A volume at `/data` keeps the rotated refresh token across redeploys.

---

## 4. Live trade settings (dashboard)

On **Dashboard → Live Trade Settings**:

| Setting | Default | Meaning |
|---|---|---|
| SPY contracts | 1 | Full SPY size. First fill is **half** (rounded up). Retest adds the other half. |
| IWM contracts | 1 | Same split for IWM. |
| SPY expiry | **1DTE** | Next trading session |
| IWM expiry | **0DTE** | Same session |

Example: SPY contracts = 4 → first breakout buys **2**, retest buys **2** more.

Use **Save SPY** / **Save IWM** after changes. Presets:

- Default (SPY 1DTE · IWM 0DTE)
- Both 0DTE
- 1 contract each

Orders are **limit at the ask** (buys) / **bid** (sells) on ATM options.

---

## 5. TradingView alerts

Webhook URL:

```
https://YOUR-APP.up.railway.app/webhook
```

If you set `WEBHOOK_SECRET`:

```
https://YOUR-APP.up.railway.app/webhook?secret=YOUR_SECRET
```

Create alerts on the **5-minute chart**. Trigger: **Once Per Bar Close**.

Message body is JSON. These minimal messages are enough — the server fills ORB levels, underlying, and option marks from Yahoo when fields are omitted.

### Required alerts

**ORB set (optional — server also captures 9:30–9:35 ET from Yahoo every 2 minutes)**

```json
{"ticker":"SPY","event":"orb_set"}
```

```json
{"ticker":"IWM","event":"orb_set"}
```

**Breakouts**

```json
{"ticker":"SPY","event":"breakout_long"}
```

```json
{"ticker":"SPY","event":"breakout_short"}
```

```json
{"ticker":"IWM","event":"breakout_long"}
```

```json
{"ticker":"IWM","event":"breakout_short"}
```

**Stops (ORB midpoint — create both)**

```json
{"ticker":"SPY","event":"stop_long"}
```

```json
{"ticker":"SPY","event":"stop_short"}
```

```json
{"ticker":"IWM","event":"stop_long"}
```

```json
{"ticker":"IWM","event":"stop_short"}
```

### Optional

Faster strike resolution if you add the bar close:

```json
{"ticker":"SPY","event":"breakout_long","close":{{close}}}
```

ORB from the chart instead of Yahoo:

```json
{"ticker":"SPY","event":"orb_set","orb_high":{{high}},"orb_low":{{low}}}
```

Expected-move 90% scale-out (if you have an expected-move alert):

```json
{"ticker":"SPY","event":"expected_move_hit","timeframe":"daily"}
```

Copy the JSON into TradingView **Message**. Webhook URL goes in **Notifications → Webhook URL**.

---

## 6. How live entries work

1. **ORB** is the 9:30–9:35 ET 5-minute range (high / low / midpoint).
2. **Breakout long** (`breakout_long`) buys ATM **calls**, half size.
3. **Breakout short** (`breakout_short`) buys ATM **puts**, half size.
4. A **second** same-side breakout on a later bar is the **retest add** (the other half).
5. Opposite-side breakout **flips**: closes the live position, then opens the new side.
6. **IWM breakout** also opens a **half SPY** position in the same direction if SPY is flat (cross-entry). That SPY leg stops on **ORB high/low**, not midpoint.
7. **stop_long** / **stop_short** close the matching live side.
8. Duplicate signals within ~30 seconds are ignored.

Profit manager runs by itself during the regular session. You do not need bar-close alerts for scale-outs, trailing stops, or the 3:45 PM ET trim.

---

## 7. Checklist before the open

- [ ] Railway service running (`/health` → `"status":"running"`)
- [ ] Volume mounted at `/data`
- [ ] `RH_TOKEN` + `RH_ACCOUNT_NUMBER` set; dashboard shows buying power
- [ ] `WEBHOOK_SECRET` set; TradingView URL includes `?secret=...`
- [ ] Contract counts and DTE saved on the dashboard
- [ ] TradingView 5-minute alerts: breakout long/short + stop long/short for **SPY** and **IWM**
- [ ] Alert trigger is **Once Per Bar Close**
- [ ] Robinhood has options buying power for the size you set

---

## 8. Troubleshooting

| Symptom | What to do |
|---|---|
| Dashboard “disconnected” | Paste a fresh `RH_TOKEN`, redeploy, Test Connection. |
| `401 Unauthorized` on webhook | Add `?secret=YOUR_SECRET` to the TradingView URL, matching `WEBHOOK_SECRET`. |
| Buying power is “—” | Token invalid or `RH_ACCOUNT_NUMBER` wrong. |
| No fill on breakout | Check Railway logs for `[ORDER]` / `[ORDER_ERROR]`. Confirm options are enabled and buying power covers the debit. |
| Positions vanish after redeploy | Attach the `/data` volume. |
| Size keeps growing each day | Set `ORB_DAILY_INCREMENT=0`. |
| ORB never sets | Wait until after 9:35 ET, or send `orb_set`. Server polls Yahoo every 2 minutes. |

Railway logs: service → **Deployments → View Logs**. Look for `[WEBHOOK]`, `[WEBHOOK_DONE]`, `[ORDER]`, `[AUTH]`.

---

## 9. Local run (optional)

Node 18+.

```bash
npm install
RH_TOKEN=... RH_ACCOUNT_NUMBER=... WEBHOOK_SECRET=... node server.js
```

Open `http://localhost:3000`. Webhook: `POST http://localhost:3000/webhook`.

---

## Disclaimer

This software places **real option orders** with real money. You are solely responsible for sizing, risk, and compliance with Robinhood and TradingView terms. Past results do not predict future results. Not an offer of investment advice.
