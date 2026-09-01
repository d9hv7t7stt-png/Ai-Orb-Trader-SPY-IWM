// utils/grokVideo.js
// Automates TikTok recap videos via xAI Grok Imagine Video API after daily P&L packages.

var fs = require("fs");
var path = require("path");
var https = require("https");
var grokContent = require("./grokContent");

function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function envBool(name, fallback) {
  var v = process.env[name];
  if (v == null || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

function config() {
  var duration = parseInt(process.env.GROK_VIDEO_DURATION || "15", 10);
  if (isNaN(duration)) duration = 15;
  duration = Math.min(15, Math.max(1, duration));
  return {
    enabled: envBool("GROK_VIDEO_AUTO", false),
    apiKey: process.env.XAI_API_KEY || "",
    webhook: process.env.GROK_VIDEO_WEBHOOK || "",
    postToChannel: envBool("GROK_VIDEO_POST_TO_CHANNEL", false),
    channels: String(process.env.GROK_VIDEO_CHANNELS || "main,free,spy0dte,qqq")
      .split(",").map(function(s) { return s.trim(); }).filter(Boolean),
    model: process.env.GROK_VIDEO_MODEL || "grok-imagine-video-1.5",
    duration: duration,
    aspectRatio: process.env.GROK_VIDEO_ASPECT || "9:16",
    resolution: process.env.GROK_VIDEO_RESOLUTION || "720p",
    pollIntervalMs: parseInt(process.env.GROK_VIDEO_POLL_MS || "8000", 10) || 8000,
    pollTimeoutMs: parseInt(process.env.GROK_VIDEO_TIMEOUT_MS || "600000", 10) || 600000
  };
}

function isConfigured() {
  var c = config();
  return !!(c.enabled && c.apiKey);
}

function isEnabledForChannel(channelId) {
  var c = config();
  return c.enabled && c.apiKey && c.channels.indexOf(channelId) >= 0;
}

function readJsonSafe(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return null;
  }
}

function saveJob(job) {
  var file = grokContent.videoJobFile(job.date, job.channelId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
  return file;
}

function loadJob(date, channelId) {
  return readJsonSafe(grokContent.videoJobFile(date, channelId));
}

function listJobsForDate(date) {
  var dir = path.join(grokContent.contentRoot(), date);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(function(name) { return name.endsWith("-video.json"); })
    .map(function(name) { return readJsonSafe(path.join(dir, name)); })
    .filter(Boolean);
}

function listPendingJobs() {
  var dates = grokContent.listDates();
  var pending = [];
  for (var i = 0; i < dates.length; i++) {
    var jobs = listJobsForDate(dates[i]);
    for (var j = 0; j < jobs.length; j++) {
      if (jobs[j].status === "pending" || jobs[j].status === "submitting") pending.push(jobs[j]);
    }
  }
  return pending;
}

function httpsJson(method, apiPath, body, apiKey) {
  return new Promise(function(resolve, reject) {
    var payload = body ? JSON.stringify(body) : null;
    var options = {
      hostname: "api.x.ai",
      path: apiPath,
      method: method,
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      }
    };
    if (payload) options.headers["Content-Length"] = Buffer.byteLength(payload);
    var req = https.request(options, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() {
        var data = null;
        try { data = raw ? JSON.parse(raw) : {}; } catch (e) {
          return reject(new Error("Invalid JSON from xAI (" + res.statusCode + ")"));
        }
        if (res.statusCode >= 400) {
          var msg = (data && (data.error || data.message)) || raw || ("HTTP " + res.statusCode);
          return reject(new Error(String(msg)));
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function httpsPostJson(url, data) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(data);
    var u = new URL(url);
    var options = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      }
    };
    var req = https.request(options, function(res) {
      var raw = "";
      res.on("data", function(c) { raw += c; });
      res.on("end", function() { resolve({ status: res.statusCode, body: raw }); });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function submitGeneration(pkg) {
  var cfg = config();
  var prompt = grokContent.buildVideoPrompt(pkg);
  var data = await httpsJson("POST", "/v1/videos/generations", {
    model: cfg.model,
    prompt: prompt,
    duration: cfg.duration,
    aspect_ratio: cfg.aspectRatio,
    resolution: cfg.resolution
  }, cfg.apiKey);
  if (!data.request_id) throw new Error("xAI did not return request_id");
  return { requestId: data.request_id, prompt: prompt };
}

async function pollUntilDone(requestId) {
  var cfg = config();
  var started = Date.now();
  while (Date.now() - started < cfg.pollTimeoutMs) {
    var data = await httpsJson("GET", "/v1/videos/" + encodeURIComponent(requestId), null, cfg.apiKey);
    if (data.status === "done") return data;
    if (data.status === "failed" || data.status === "expired") {
      throw new Error("Video generation " + data.status + (data.error ? ": " + data.error : ""));
    }
    await sleep(cfg.pollIntervalMs);
  }
  throw new Error("Video generation timed out after " + cfg.pollTimeoutMs + "ms");
}

async function postToDiscord(webhook, pkg, job) {
  if (!webhook) return;
  var color = pkg.headline.label === "GREEN DAY" ? 0x00e5a0 : 0xff4d6a;
  var embed = {
    color: color,
    title: "🎬 TikTok Recap Ready — " + pkg.headline.emoji + " " + pkg.headline.label,
    description: "**" + pkg.channel.name + "** · " + pkg.date + "\n\n"
      + "**P&L:** " + pkg.headline.dailyPnlFormatted + " (" + pkg.headline.dailyPctFormatted + ")\n"
      + "**Trades:** " + pkg.stats.totalTrades + " (" + pkg.stats.wins + "W / " + pkg.stats.losses + "L)\n\n"
      + "[Download / watch video](" + job.videoUrl + ")",
    fields: [
      { name: "Caption", value: (pkg.tiktok.caption || "").slice(0, 1000), inline: false },
      { name: "Hashtags", value: (pkg.tiktok.hashtags || []).join(" "), inline: false }
    ],
    footer: { text: "Auto-generated · Paper sim · Not financial advice" },
    timestamp: new Date().toISOString()
  };
  await httpsPostJson(webhook, { embeds: [embed] });
}

async function runJob(date, channelId, pkg, opts) {
  opts = opts || {};
  var existing = loadJob(date, channelId);
  if (existing && existing.status === "done" && existing.videoUrl && !opts.force) return existing;
  if (existing && existing.status === "pending" && existing.requestId && !opts.force) {
    return resumeJob(existing, pkg, opts);
  }

  var job = {
    date: date,
    channelId: channelId,
    status: "submitting",
    submittedAt: new Date().toISOString(),
    requestId: null,
    videoUrl: null,
    duration: null,
    model: config().model,
    prompt: null,
    error: null
  };
  saveJob(job);

  try {
    var submitted = await submitGeneration(pkg);
    job.requestId = submitted.requestId;
    job.prompt = submitted.prompt;
    job.status = "pending";
    saveJob(job);
    console.log("[GROK-VIDEO][" + channelId + "] submitted " + job.requestId);

    var result = await pollUntilDone(job.requestId);
    if (!result.video || !result.video.url) throw new Error("No video URL in xAI response");
    if (result.video.respect_moderation === false) throw new Error("Video blocked by moderation");

    job.status = "done";
    job.completedAt = new Date().toISOString();
    job.videoUrl = result.video.url;
    job.duration = result.video.duration || config().duration;
    job.respectModeration = result.video.respect_moderation !== false;
    saveJob(job);

    grokContent.attachVideoToPackage(date, channelId, {
      status: job.status,
      videoUrl: job.videoUrl,
      duration: job.duration,
      requestId: job.requestId,
      completedAt: job.completedAt
    });

    var webhook = opts.webhook || config().webhook;
    if (webhook) {
      try {
        await postToDiscord(webhook, pkg, job);
        job.discordNotifiedAt = new Date().toISOString();
        saveJob(job);
      } catch (discordErr) {
        console.log("[GROK-VIDEO][" + channelId + "] Discord notify failed: " + discordErr.message);
      }
    }

    console.log("[GROK-VIDEO][" + channelId + "] done → " + job.videoUrl);
    return job;
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    job.failedAt = new Date().toISOString();
    saveJob(job);
    grokContent.attachVideoToPackage(date, channelId, {
      status: job.status,
      error: job.error,
      requestId: job.requestId,
      failedAt: job.failedAt
    });
    throw e;
  }
}

async function resumeJob(job, pkg, opts) {
  opts = opts || {};
  if (!pkg) pkg = grokContent.loadPackage(job.date, job.channelId);
  if (!pkg) throw new Error("Missing package for resume " + job.date + "/" + job.channelId);
  if (!job.requestId) throw new Error("Pending job missing request_id");

  console.log("[GROK-VIDEO][" + job.channelId + "] resuming " + job.requestId);
  try {
    var result = await pollUntilDone(job.requestId);
    if (!result.video || !result.video.url) throw new Error("No video URL in xAI response");
    if (result.video.respect_moderation === false) throw new Error("Video blocked by moderation");

    job.status = "done";
    job.completedAt = new Date().toISOString();
    job.videoUrl = result.video.url;
    job.duration = result.video.duration || config().duration;
    saveJob(job);

    grokContent.attachVideoToPackage(job.date, job.channelId, {
      status: job.status,
      videoUrl: job.videoUrl,
      duration: job.duration,
      requestId: job.requestId,
      completedAt: job.completedAt
    });

    var webhook = opts.webhook || config().webhook;
    if (webhook) await postToDiscord(webhook, pkg, job);
    return job;
  } catch (e) {
    job.status = "failed";
    job.error = e.message;
    job.failedAt = new Date().toISOString();
    saveJob(job);
    throw e;
  }
}

function queueGeneration(date, channelId, pkg, opts) {
  setImmediate(function() {
    runJob(date, channelId, pkg, opts).catch(function(e) {
      console.log("[GROK-VIDEO][" + channelId + "] " + e.message);
    });
  });
}

function maybeAutoGenerate(pkg, channelWebhook) {
  if (!isEnabledForChannel(pkg.channel.id)) return false;
  var webhook = config().webhook || (config().postToChannel ? channelWebhook : null);
  queueGeneration(pkg.date, pkg.channel.id, pkg, { webhook: webhook });
  console.log("[GROK-VIDEO][" + pkg.channel.id + "] queued auto-generation for " + pkg.date);
  return true;
}

function resumePendingJobs() {
  if (!config().apiKey) return;
  var pending = listPendingJobs();
  if (!pending.length) return;
  console.log("[GROK-VIDEO] resuming " + pending.length + " pending job(s)");
  pending.forEach(function(job) {
    var pkg = grokContent.loadPackage(job.date, job.channelId);
    if (!pkg) return;
    queueGeneration(job.date, job.channelId, pkg, {});
  });
}

module.exports = {
  config: config,
  isConfigured: isConfigured,
  isEnabledForChannel: isEnabledForChannel,
  loadJob: loadJob,
  listJobsForDate: listJobsForDate,
  listPendingJobs: listPendingJobs,
  runJob: runJob,
  queueGeneration: queueGeneration,
  maybeAutoGenerate: maybeAutoGenerate,
  resumePendingJobs: resumePendingJobs
};
