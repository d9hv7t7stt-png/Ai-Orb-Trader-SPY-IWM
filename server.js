const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { ensureLoggedIn, scheduleDailyReauth } = require("./utils/reauth");
const rh = require("./utils/robinhood");

app.get("/health", (req, res) => {
  res.json({ status: "running", time: new Date().toISOString(), auth: rh.getToken() ? "connected" : "disconnected" });
});

app.get("/api/state", (req, res) => {
  var s = getState();
  s.auth = { logged_in: !!rh.getToken() };
  res.json(s);
});

app.post("/api/reauth", async (req, res) => {
  var ok = await ensureLoggedIn();
  res.json({ ok: ok, message: ok ? "Connected to Robinhood" : "Login failed — check Railway logs" });
});

// Submit SMS/challenge code from dashboard
app.post("/api/challenge", async (req, res) => {
  var { challengeId, code } = req.body;
  if (!challengeId || !code) return res.status(400).json({ error: "challengeId and code required" });
  try {
    var result = await rh.respondToChallenge(challengeId, code);
    // Try login again after challenge
    var email = process.env.RH_EMAIL;
    var password = process.env.RH_PASSWORD;
    var loginResult = await rh.login(email, password);
    res.json({ ok: loginResult.ok, result: result });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/contracts", (req, res) => {
  const { spy, iwm } = req.body;
  if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
  setContractSize(spy, iwm);
  res.json({ ok: true, contracts: getState().contracts });
});

app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
  if (!rh.getToken()) {
    var ok = await ensureLoggedIn();
    if (!ok) return res.status(403).json({ error: "Not connected to Robinhood" });
  }
  try {
    const result = await handleAlert(req.body);
    res.json(result);
  } catch (err) {
    console.error("[ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "dashboard", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log("ORB server listening on port " + PORT);
  await ensureLoggedIn();
  scheduleDailyReauth();
});
