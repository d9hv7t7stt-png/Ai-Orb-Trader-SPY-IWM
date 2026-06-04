const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { ensureLoggedIn, submitSmsCode, getPendingWorkflow, scheduleDailyReauth } = require("./utils/reauth");
const rh = require("./utils/robinhood");

app.get("/health", (req, res) => {
  res.json({ status: "running", time: new Date().toISOString(), auth: rh.getToken() ? "connected" : "disconnected" });
});

app.get("/api/state", (req, res) => {
  var s = getState();
  s.auth = { logged_in: !!rh.getToken(), pending: !!getPendingWorkflow() };
  res.json(s);
});

app.post("/api/reauth", async (req, res) => {
  rh.setToken(null);
  var ok = await ensureLoggedIn();
  var pending = getPendingWorkflow();
  res.json({ ok, pending_type: pending ? pending.challenge_type : null, message: ok ? "Connected" : pending ? "Check phone or enter SMS code" : "Login failed" });
});

// Submit SMS code from dashboard
app.post("/api/sms", async (req, res) => {
  var { code } = req.body;
  if (!code) return res.status(400).json({ error: "code required" });
  var result = await submitSmsCode(code);
  res.json(result);
});

app.post("/api/contracts", (req, res) => {
  const { spy, iwm } = req.body;
  if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
  setContractSize(spy, iwm);
  res.json({ ok: true, contracts: getState().contracts });
});

app.post("/webhook", async (req, res) => {
  if (!rh.getToken()) {
    var ok = await ensureLoggedIn();
    if (!ok) return res.status(403).json({ error: "Not authenticated with Robinhood" });
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
