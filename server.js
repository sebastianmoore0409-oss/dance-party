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

// Temporary debug helper: safely JSON-stringify TikTok event payloads for
// logging, without crashing on BigInt fields or blowing up on huge binary blobs.
function safeStringify(obj) {
  try {
    return JSON.stringify(
      obj,
      (key, value) => {
        if (typeof value === "bigint") return value.toString();
        if (value instanceof Uint8Array) return `[bytes:${value.length}]`;
        return value;
      }
    ).slice(0, 3000);
  } catch (err) {
    return `[could not stringify: ${err.message}]`;
  }
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
    console.log("RAW FOLLOW keys:", Object.keys(data || {}));
    console.log("RAW FOLLOW.user keys:", data?.user ? Object.keys(data.user) : "no user field");
    console.log("RAW FOLLOW dump:", safeStringify(data));

    const uniqueId = data.user?.uniqueId;
    const userId = data.user?.userId;
    console.log(`FOLLOW (fast path): uniqueId=${uniqueId} userId=${userId}`);
    if (userId) recentFollowers.set(userId, Date.now());
  });

  // Fallback: the library's built-in "follow" event only fires if TikTok's
  // internal text key literally contains the word "follow", which isn't
  // always true depending on language/region. WebcastEvent.SOCIAL fires for
  // every follow AND share, so we double check it ourselves as a safety net.
  connection.on(WebcastEvent.SOCIAL, (data) => {
    console.log("RAW SOCIAL dump:", safeStringify(data));
    const uniqueId = data.user?.uniqueId;
    const userId = data.user?.userId;
    const label = (
      data.common?.displayText?.key ||
      data.common?.displayText?.label ||
      data.event?.eventDetails?.displayType ||
      data.event?.eventDetails?.label ||
      ""
    ).toString().toLowerCase();

    console.log(`SOCIAL event from uniqueId=${uniqueId} userId=${userId}, label="${label}"`);

    if (label.includes("follow") && userId) {
      console.log(`FOLLOW (fallback path): ${uniqueId}`);
      recentFollowers.set(userId, Date.now());
    }
  });

  connection.on(WebcastEvent.CHAT, (data) => {
    console.log("RAW CHAT keys:", Object.keys(data || {}));
    console.log("RAW CHAT.user keys:", data?.user ? Object.keys(data.user) : "no user field");
    console.log("RAW CHAT dump:", safeStringify(data));

    const userId = data.user?.userId;
    const uniqueId = data.user?.uniqueId;
    const message = data.comment;
    const followedAt = recentFollowers.get(userId);

    console.log(`CHAT from uniqueId=${uniqueId} userId=${userId}: "${message}" | armed=${!!followedAt}`);

    if (!followedAt) return; // they haven't followed (or already used their turn)
    if (Date.now() - followedAt > FOLLOW_WINDOW_MS) {
      recentFollowers.delete(userId);
      return;
    }

    if (looksLikeRobloxUsername(message)) {
      console.log(`QUEUING SPAWN: ${message} (from TikTok user ${uniqueId})`);
      spawnQueue.push({
        robloxUsername: message.trim(),
        tiktokUser: uniqueId,
        queuedAt: Date.now(),
      });
      recentFollowers.delete(userId); // they've used their one spawn
    } else {
      console.log(`Rejected "${message}" as not a valid-looking Roblox username`);
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

// Manual test trigger — lets you queue a spawn without needing a real TikTok
// follow/chat event. Handy while you're building and testing the Roblox side.
// Example: https://your-app.onrender.com/test-spawn?key=YOUR_SECRET&username=Builderman
app.get("/test-spawn", (req, res) => {
  if (req.query.key !== SHARED_SECRET) {
    return res.status(401).json({ error: "bad key" });
  }
  const username = (req.query.username || "").trim();
  if (!looksLikeRobloxUsername(username)) {
    return res.status(400).json({ error: "give a valid ?username= in the URL" });
  }
  spawnQueue.push({
    robloxUsername: username,
    tiktokUser: "manual-test",
    queuedAt: Date.now(),
  });
  res.json({ ok: true, queued: username });
});

app.listen(PORT, () => {
  console.log(`Bridge server listening on port ${PORT}`);
  connectToTikTok();
});
