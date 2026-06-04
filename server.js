const express = require("express");
const path = require("path");
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "dashboard")));

const { handleAlert } = require("./routes/alert");
const { getState, setContractSize } = require("./utils/state");
const { scheduleDailyReauth, ensureLoggedIn } = require("./utils/reauth");

app.get("/health", (req, res) => {
  res.json({ status: "running", time: new Date().toISOString() });
});

app.get("/api/state", (req, res) => {
  res.json(getState());
});

app.post("/api/reauth", async (req, res) => {
  const ok = await ensureLoggedIn();
  res.json({ ok: ok, message: ok ? "Logged in" : "Login failed" });
});

// Contract size update from dashboard
app.post("/api/contracts", (req, res) => {
  const { spy, iwm } = req.body;
  if (!spy || !iwm) return res.status(400).json({ error: "spy and iwm required" });
  setContractSize(spy, iwm);
  res.json({ ok: true, contracts: getState().contracts });
});

app.post("/webhook", async (req, res) => {
  console.log("[WEBHOOK]", JSON.stringify(req.body));
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
