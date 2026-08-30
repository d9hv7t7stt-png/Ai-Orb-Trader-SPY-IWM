const express = require("express");
const path = require("path");
const https = require("https");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth, getAuthInfo } = require("./utils/reauth");
const rh = require("./utils/robinhood");
const discord = require("./utils/discord");
const profitManager = require("./utils/profitmanager");
const orbUtil = require("./utils/orb");
const settings = require("./utils/settings");
const yahoo = require("./utils/yahoo");
const pnlUtil = require("./utils/pnl");
const authguard = require("./utils/authguard");
const persist = require("./utils/persist");
const reconcile = require("./utils/reconcile");

process.on("unhandledRejection", (err) => {
  console.error("[UNHANDLED_REJECTION]", err && err.message ? err.message : err);
});

app.get("/manifest.json", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "manifest.json"));
});
app.get("/sw.js", (req, res) => {
  res.setHeader("Service-Worker-Allowed", "/");
  res.sendFile(path.join(__dirname, "dashboard", "sw.js"));
});
app.get("/icon.svg", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "icon.svg"));
});

app.get("/health", async (req, res) => {
  var auth = await getAuthInfo();
  var s = getState();
  var lastAuthErr = (s.log || []).find(function(e) { return e.type === "AUTH_ERROR"; });
  res.json({
    status: "running",
    time: new Date().toISOString(),
    auth: auth.status,
    verified: auth.verified,
    pending_verification: auth.pending,
    durable: persist.isDurable(),
    webhook_url: ((req.get("x-forwarded-proto") || req.protocol) + "://" + req.get("host") + "/webhook"),
    auth_hint: lastAuthErr ? lastAuthErr.message : null
  });
});

app.get("/api/buying-power", authguard.requireSecret, async (req, res) => {
  try {
    var bp = null;
    var token = rh.getToken();
    var acct = process.env.RH_ACCOUNT_NUMBER;
    if (token && acct) {
      var status = await rh.checkAuthStatus();
      if (status.ok) {
        var body = await new Promise(function(resolve) {
          var opts = {
            hostname: "api.robinhood.com",
            path: "/accounts/" + acct + "/",
            headers: {
              "Authorization": "Bearer " + token,
              "Accept": "application/json",
              "X-Robinhood-API-Version": "1.431.4",
              "User-Agent": "Robinhood/823 (iPhone; iOS 16.0; Scale/3.00)"
            }
          };
          var req3 = https.request(opts, (r) => {
            var raw = ""; r.on("data", c => raw += c);
            r.on("end", () => { try { resolve(JSON.parse(raw)); } catch (e) { resolve({}); } });
          });
          req3.on("error", () => resolve({})); req3.end();
        });
        bp = body.buying_power || body.cash || null;
      }
    }
    res.json({ buying_power: bp });
  } catch (e) {
    console.log("[BUYING_POWER_ERROR]", e.message);
    res.json({ buying_power: null });
  }
});

app.get("/api/state", authguard.requireSecret, async (req, res) => {
  var s = getState();
  s.auth = await getAuthInfo();
  s.dte = settings.getAll().dte;
  s.webhook_secret_required = !!authguard.getSecret();
  s.durable = persist.isDurable();
  res.json(s);
});

app.post("/api/settings/dte", authguard.requireSecret, (req, res) => {
  try {
    const { spy, iwm } = req.body || {};
    if (spy !== undefined) settings.setDTE("SPY", spy);
    if (iwm !== undefined) settings.setDTE("IWM", iwm);
    res.json({ ok: true, dte: settings.getAll().dte, durable: settings.getAll().durable });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/orb/refresh", authguard.requireSecret, async (req, res) => {
  try {
    var results = await orbUtil.populateIfNeeded(true);
    res.json({ ok: true, orb: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/api/prices", authguard.requireSecret, async (req, res) => {
  try {
    var tickers = { SPY: "SPY", IWM: "IWM", QQQ: "QQQ", SPX: "^GSPC" };
    var results = await Promise.all(Object.entries(tickers).map(async function(entry) {
      var display = entry[0];
      var snap = await yahoo.getQuoteSnapshot(display);
      if (!snap) return [display, { price: null, prev_close: null }];
      return [display, { price: snap.price, prev_close: snap.prev_close }];
    }));
    res.json({ prices: Object.fromEntries(results) });
  } catch (e) {
    console.log("[PRICES_ERROR]", e.message);
    res.json({ prices: {} });
  }
});

app.get("/api/pnl", authguard.requireSecret, (req, res) => {
  res.json(pnlUtil.aggregatePnL());
});

app.post("/api/reauth", authguard.requireSecret, async (req, res) => {
  try {
    rh.setToken(null);
    var ok = await ensureLoggedIn();
    var pending = getPendingWorkflow();
    var auth = await getAuthInfo();
    res.json({
      ok: ok,
      auth: auth,
      pending_type: pending ? pending.challenge_type : null,
      message: ok ? "Connected to Robinhood" : pending ? "Check phone or enter SMS code below" : "Login failed — update RH_TOKEN in Railway"
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/sms", authguard.requireSecret, async (req, res) => {
  try {
    var code = req.body.code;
    if (!code) return res.status(400).json({ error: "code required" });
    var result = await submitSmsCode(code);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/contracts", authguard.requireSecret, (req, res) => {
  try {
    const { spy, iwm } = req.body;
    if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
    setContractSize(spy, iwm);
    res.json({ ok: true, contracts: getState().contracts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

if (authguard.allowTestRoutes()) {
  app.get("/test/discord/:type", authguard.requireSecret, async (req, res) => {
    try {
      var type = req.params.type;
      if (type === "60") await discord.postGoodMorning(60);
      if (type === "45") await discord.postGoodMorning(45);
      if (type === "30") await discord.postGoodMorning(30);
      if (type === "5")  await discord.postGoodMorning(5);
      if (type === "1")  await discord.postGoodMorning(1);
      if (type === "summary") await discord.postDailySummary();
      if (type === "positions") await discord.postOpenPositions("Test");
      if (type === "entry") await discord.postEntry("SPY", "call", 2.40, 757.50, 754.25);
      if (type === "stop") await discord.postStopLoss("SPY", 1.80, "Stop Loss — ORB Midpoint");
      if (type === "profit") await discord.postProfitTier("SPY", 1, 5, 2.88, 20);
      res.json({ ok: true, tested: type });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/test/discord/summary/:channel", authguard.requireSecret, async (req, res) => {
    try {
      var ch = req.params.channel;
      var chans = (typeof discord.getChannels === "function") ? discord.getChannels() : [];
      var targets;
      if (ch === "all") targets = chans;
      else if (ch === "bc") targets = chans.filter(function(c){ return c.cfg.id === "free" || c.cfg.id === "spy0dte"; });
      else targets = chans.filter(function(c){ return c.cfg.id === ch; });
      for (var i = 0; i < targets.length; i++) await targets[i].dailySummary();
      res.json({ ok: true, tested: targets.map(function(c){ return c.cfg.id; }), active: chans.map(function(c){ return c.cfg.id; }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

app.post("/webhook", authguard.requireSecret, (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
  res.status(200).json({ ok: true, accepted: true });

  setImmediate(async function() {
    try {
      // Best-effort RH auth — never drop the signal; Discord paper + Yahoo work without RH.
      try {
        if (!rh.getToken()) await ensureLoggedIn();
        else {
          var auth = await rh.checkAuthStatus();
          if (!auth.ok) await ensureLoggedIn();
        }
      } catch (authErr) {
        console.warn("[WEBHOOK_ASYNC] Robinhood offline — paper alerts still processing:", authErr.message);
      }
      var result = await handleAlert(req.body);
      console.log("[WEBHOOK_DONE]", JSON.stringify(result));
    } catch (err) {
      console.error("[WEBHOOK_ASYNC_ERROR]", err.message);
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("ORB server listening on port " + PORT);
  if (authguard.getSecret()) console.log("[AUTH] Webhook/API secret enabled");
  await ensureLoggedIn();
  try {
    var recon = await reconcile.reconcileRhPositions();
    if (recon.ok) console.log("[RECONCILE] synced tickers: " + (recon.synced.join(", ") || "none"));
    else console.log("[RECONCILE] skipped: " + (recon.reason || "unknown"));
  } catch (e) {
    console.log("[RECONCILE_ERROR]", e.message);
  }
  scheduleDailyReauth();
  discord.initChannels(rh.getToken.bind(rh));
  profitManager.startProfitManager();
  orbUtil.scheduleORBCapture();
});
