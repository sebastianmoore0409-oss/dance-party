// server.js
// Listens to a TikTok LIVE stream for "follow" events, then treats that
// follower's NEXT chat message as their Roblox username and queues it up.
// Roblox polls GET /queue to fetch (and clear) pending usernames.

const express = require("express");
const { TikTokLiveConnection, WebcastEvent } = require("tiktok-live-connector");

// ---- CONFIG -----------------------------------------------------------
const TIKTOK_USERNAME = process.env.TIKTOK_USERNAME || "your_tiktok_username"; // no @
const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || "change-me"; // simple auth so randoms can't hit your endpoint
const FOLLOW_WINDOW_MS = 5 * 60 * 1000; // how long after a follow we'll accept their username (5 min)
// ------------------------------------------------------------------------

const app = express();

// userId -> timestamp they followed at (only users in here are "armed")
const recentFollowers = new Map();
// queue of usernames waiting to be picked up by Roblox
const spawnQueue = [];

// Very loose Roblox username validator: 3-20 chars, letters/numbers/underscore,
// can't start or end with underscore, no double underscores.
function looksLikeRobloxUsername(text) {
  const name = text.trim();
  if (name.length < 3 || name.length > 20) return false;
  if (!/^[A-Za-z0-9_]+$/.test(name)) return false;
  if (name.startsWith("_") || name.endsWith("_")) return false;
  if (name.includes("__")) return false;
  return true;
}

function connectToTikTok() {
  const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {});

  connection.connect().then((state) => {
    console.log(`Connected to TikTok LIVE room ${state.roomId} for @${TIKTOK_USERNAME}`);
  }).catch((err) => {
    console.error("Failed to connect to TikTok LIVE. Are you actually live right now?", err.message);
    console.log("Retrying in 15s...");
    setTimeout(connectToTikTok, 15000);
  });

  connection.on(WebcastEvent.FOLLOW, (data) => {
    const uniqueId = data.user?.uniqueId;
    const userId = data.user?.userId;
    console.log(`FOLLOW: ${uniqueId}`);
    if (userId) recentFollowers.set(userId, Date.now());
  });

  connection.on(WebcastEvent.CHAT, (data) => {
    const userId = data.user?.userId;
    const uniqueId = data.user?.uniqueId;
    const followedAt = recentFollowers.get(userId);
    if (!followedAt) return; // they haven't followed (or already used their turn)
    if (Date.now() - followedAt > FOLLOW_WINDOW_MS) {
      recentFollowers.delete(userId);
      return;
    }

    const message = data.comment;
    if (looksLikeRobloxUsername(message)) {
      console.log(`QUEUING SPAWN: ${message} (from TikTok user ${uniqueId})`);
      spawnQueue.push({
        robloxUsername: message.trim(),
        tiktokUser: uniqueId,
        queuedAt: Date.now(),
      });
      recentFollowers.delete(userId); // they've used their one spawn
    }
  });

  connection.on("disconnected", () => {
    console.log("Disconnected from TikTok LIVE, reconnecting in 10s...");
    setTimeout(connectToTikTok, 10000);
  });
}

// ---- HTTP API for Roblox ------------------------------------------------

app.get("/queue", (req, res) => {
  if (req.query.key !== SHARED_SECRET) {
    return res.status(401).json({ error: "bad key" });
  }
  const items = spawnQueue.splice(0, spawnQueue.length); // drain the queue
  res.json({ spawns: items });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, queued: spawnQueue.length, armedFollowers: recentFollowers.size });
});

app.listen(PORT, () => {
  console.log(`Bridge server listening on port ${PORT}`);
  connectToTikTok();
});
