"use strict";

/**
 * Omingle — Production Server (Single Process)
 *
 * Why single-process instead of cluster:
 *   - Cluster splits users across workers → they can't match each other cross-worker
 *     without a shared Redis store. Single process = ALL users in one pool → true random matching.
 *   - Render.com free/starter tiers are single-instance anyway.
 *   - Node.js + Socket.IO single process reliably handles 3000–10 000 concurrent
 *     WebSocket connections for a signalling-only workload like this.
 *
 * Scale strategy:
 *   - WebSocket + polling transports (fallback for firewalls)
 *   - 300 ms message rate-limit per socket
 *   - Per-IP connection cap (abuse prevention)
 *   - Stale-entry GC every 5 min
 *   - Memory cap via NODE_OPTIONS env var or npm start script
 */

const path    = require("path");
const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ── Static files ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Health-check endpoint (Render uses this) ──────────────
app.get("/healthz", (_req, res) => res.json({ ok: true, users: users.size }));

// ── Socket.IO ─────────────────────────────────────────────
const io = new Server(server, {
  transports: ["websocket", "polling"],   // polling fallback for strict firewalls
  pingTimeout:        20000,   // 20s — detect dead clients faster, free slots sooner
  pingInterval:       10000,   // 10s — more frequent heartbeat
  maxHttpBufferSize:  1e5,               // 100 KB max payload
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ── In-memory state ───────────────────────────────────────
// All users are in ONE shared pool → true random matching across everyone.

const waitingPools = {
  text:  { male: [], female: [], other: [] },
  video: { male: [], female: [], other: [] }
};

const users      = new Map(); // socketId → { name, gender, mode, interests, roomId, partnerId }
const rooms      = new Map(); // roomId   → { a: socketId, b: socketId }
const rateLimits = new Map(); // socketId → lastMessageTimestamp
const ipConns    = new Map(); // ip       → connectionCount

const IP_MAX = 10; // max simultaneous connections per IP (generous for NAT/proxies)

// Periodic GC — remove stale rate-limit entries (prevents slow memory leak)
setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [id, ts] of rateLimits) {
    if (ts < cutoff) rateLimits.delete(id);
  }
}, 300_000);

// ── Utility ───────────────────────────────────────────────
function normalizeGender(v) {
  const s = String(v || "").toLowerCase();
  return s === "male" || s === "female" ? s : "other";
}

function normalizeMode(v) {
  return String(v || "").toLowerCase() === "text" ? "text" : "video";
}

function parseInterests(raw) {
  const src = Array.isArray(raw) ? raw : String(raw || "").split(/[\n,]/);
  return [
    ...new Set(src.map(s => String(s).trim().toLowerCase()).filter(Boolean))
  ].slice(0, 8);
}

function sharedInterests(a, b) {
  const bSet = new Set(b.interests || []);
  return (a.interests || []).filter(x => bSet.has(x)).slice(0, 4);
}

// Gender preference order for matching attempts
function genderOrder(gender) {
  if (gender === "male")   return ["female", "other", "male"];
  if (gender === "female") return ["male",   "other", "female"];
  return ["male", "female", "other"];
}

function removeFromPool(mode, gender, socketId) {
  const pool = waitingPools[mode]?.[gender];
  if (!pool) return;
  const i = pool.indexOf(socketId);
  if (i !== -1) pool.splice(i, 1);
}

function removeFromAllPools(socketId) {
  for (const mode of ["text", "video"])
    for (const g of ["male", "female", "other"])
      removeFromPool(mode, g, socketId);
}

function makeRoomId(a, b) {
  return `room_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function broadcastCount() {
  io.emit("user-count", { count: users.size });
}

// ── Matching ──────────────────────────────────────────────
// Scans the relevant gender pools in preference order.
// Scores candidates by shared-interest overlap + gender preference + random tiebreak.
// Full random match when no interests overlap.

function selectPartner(user, mySocketId) {
  const modePools = waitingPools[user.mode];
  const order     = genderOrder(user.gender);
  let bestId = null, bestGender = null, bestScore = -1;

  for (let pi = 0; pi < order.length; pi++) {
    const gender = order[pi];
    const pool   = modePools[gender];

    // Iterate backwards so we can safely splice stale entries
    for (let i = pool.length - 1; i >= 0; i--) {
      const candidateId = pool[i];
      if (candidateId === mySocketId) continue;

      const candidate = users.get(candidateId);
      if (!candidate || candidate.mode !== user.mode || candidate.roomId) {
        pool.splice(i, 1);   // stale entry — remove
        continue;
      }

      // Score: shared interests dominate, then gender preference, then pure random
      const overlap = sharedInterests(user, candidate).length;
      const score   = overlap * 100 + (order.length - pi) * 10 + Math.random();
      if (score > bestScore) {
        bestScore  = score;
        bestId     = candidateId;
        bestGender = gender;
      }
    }
  }

  if (bestId) removeFromPool(user.mode, bestGender, bestId);
  return bestId;
}

function connectPair(sockA, sockB) {
  const userA = users.get(sockA.id);
  const userB = users.get(sockB.id);
  if (!userA || !userB) return;

  const roomId = makeRoomId(sockA.id, sockB.id);
  userA.roomId = userB.roomId = roomId;
  userA.partnerId = sockB.id;
  userB.partnerId = sockA.id;

  rooms.set(roomId, { a: sockA.id, b: sockB.id });
  sockA.join(roomId);
  sockB.join(roomId);

  const si       = sharedInterests(userA, userB);
  const isVideo  = userA.mode === "video";
  // Deterministically decide who sends the WebRTC offer (avoid double-offer)
  const aOffers  = isVideo && sockA.id < sockB.id;

  sockA.emit("matched", {
    roomId,
    strangerName:   userB.name,
    strangerGender: userB.gender,
    mode:           userA.mode,
    sharedInterests: si,
    shouldInitiateOffer: aOffers
  });
  sockB.emit("matched", {
    roomId,
    strangerName:   userA.name,
    strangerGender: userA.gender,
    mode:           userB.mode,
    sharedInterests: si,
    shouldInitiateOffer: isVideo && !aOffers
  });
}

function tryMatch(socket) {
  const user = users.get(socket.id);
  if (!user) return;

  // Always remove self from pool before searching (avoid self-match)
  removeFromAllPools(socket.id);

  const partnerId = selectPartner(user, socket.id);

  if (!partnerId) {
    // No one available — join the waiting pool
    waitingPools[user.mode][user.gender].push(socket.id);
    socket.emit("waiting", {
      mode: user.mode,
      message: user.mode === "video"
        ? "Searching for a video match…"
        : "Searching for a text match…"
    });
    return;
  }

  const partnerSocket = io.sockets.sockets.get(partnerId);
  if (!partnerSocket) {
    // Partner disconnected between selection and now — retry
    tryMatch(socket);
    return;
  }

  connectPair(socket, partnerSocket);
}

function disconnect(socketId, reason = "Stranger disconnected") {
  const user = users.get(socketId);
  if (!user) return;
  const { roomId, partnerId } = user;

  removeFromAllPools(socketId);
  user.roomId    = null;
  user.partnerId = null;

  if (!roomId || !partnerId) return;

  rooms.delete(roomId);
  io.sockets.sockets.get(socketId)?.leave(roomId);

  const partner = users.get(partnerId);
  if (partner) { partner.roomId = null; partner.partnerId = null; }
  io.sockets.sockets.get(partnerId)?.leave(roomId);
  io.to(partnerId).emit("partner-left", { reason });
}

// ── Socket events ─────────────────────────────────────────
io.on("connection", (socket) => {
  // Per-IP cap
  const ip    = socket.handshake.headers["x-forwarded-for"]?.split(",")[0].trim()
                || socket.handshake.address;
  const count = (ipConns.get(ip) || 0) + 1;
  if (count > IP_MAX) {
    socket.emit("too-many-connections", { message: "Too many connections from your IP." });
    socket.disconnect(true);
    return;
  }
  ipConns.set(ip, count);

  broadcastCount();

  // ── join ──────────────────────────────────────────────
  socket.on("start-chat", ({ name, gender, mode, interests } = {}) => {
    // If re-joining, cleanly detach from any previous session
    if (users.has(socket.id)) {
      disconnect(socket.id, "Stranger started a new chat");
      removeFromAllPools(socket.id);
    }

    users.set(socket.id, {
      name:      String(name || "Stranger").trim().slice(0, 30) || "Stranger",
      gender:    normalizeGender(gender),
      mode:      normalizeMode(mode),
      interests: parseInterests(interests),
      roomId:    null,
      partnerId: null
    });

    broadcastCount();
    tryMatch(socket);
  });

  // ── skip ──────────────────────────────────────────────
  socket.on("next", () => {
    if (!users.has(socket.id)) return;
    disconnect(socket.id, "Stranger skipped to the next chat");
    tryMatch(socket);
  });

  // ── end ───────────────────────────────────────────────
  socket.on("end-chat", () => {
    disconnect(socket.id, "Stranger ended the chat");
    removeFromAllPools(socket.id);
    users.delete(socket.id);
    broadcastCount();
    socket.emit("chat-ended", { message: "You ended the chat." });
  });

  // ── message (rate-limited) ────────────────────────────
  socket.on("chat-message", ({ message } = {}) => {
    const user = users.get(socket.id);
    if (!user?.partnerId) return;

    const now  = Date.now();
    const last = rateLimits.get(socket.id) || 0;
    if (now - last < 300) return;               // 300 ms cooldown
    rateLimits.set(socket.id, now);

    const clean = String(message || "").trim().slice(0, 500);
    if (!clean) return;

    io.to(user.partnerId).emit("chat-message", { from: socket.id, message: clean });
  });

  // ── emoji reaction ────────────────────────────────────
  socket.on("emoji-reaction", ({ emoji } = {}) => {
    const user = users.get(socket.id);
    if (!user?.partnerId) return;
    const ALLOWED = new Set(["❤️","😂","😮","🔥","👍","😢","🎉","💀"]);
    if (!ALLOWED.has(emoji)) return;
    io.to(user.partnerId).emit("emoji-reaction", { emoji });
  });

  // ── typing ────────────────────────────────────────────
  socket.on("typing", () => {
    const user = users.get(socket.id);
    if (!user?.partnerId) return;
    io.to(user.partnerId).emit("typing", user.name);
  });

  // ── report ────────────────────────────────────────────
  socket.on("report-user", ({ reason } = {}) => {
    const reporter = users.get(socket.id);
    if (!reporter?.partnerId) return;
    const reported = users.get(reporter.partnerId);
    console.log("[REPORT]", {
      at:           new Date().toISOString(),
      reporterId:   socket.id,
      reporterName: reporter.name,
      reportedId:   reporter.partnerId,
      reportedName: reported?.name ?? "Unknown",
      reason:       String(reason || "No reason provided").slice(0, 300)
    });
  });

  // ── WebRTC signalling ─────────────────────────────────
  socket.on("webrtc-offer", ({ sdp } = {}) => {
    const user = users.get(socket.id);
    if (!user || user.mode !== "video" || !user.partnerId) return;
    io.to(user.partnerId).emit("webrtc-offer", { sdp });
  });

  socket.on("webrtc-answer", ({ sdp } = {}) => {
    const user = users.get(socket.id);
    if (!user || user.mode !== "video" || !user.partnerId) return;
    io.to(user.partnerId).emit("webrtc-answer", { sdp });
  });

  socket.on("webrtc-ice-candidate", ({ candidate } = {}) => {
    const user = users.get(socket.id);
    if (!user || user.mode !== "video" || !user.partnerId || !candidate) return;
    io.to(user.partnerId).emit("webrtc-ice-candidate", { candidate });
  });

  // ── disconnect ────────────────────────────────────────
  socket.on("disconnect", () => {
    // Release IP slot
    const cnt = ipConns.get(ip) || 1;
    cnt <= 1 ? ipConns.delete(ip) : ipConns.set(ip, cnt - 1);

    disconnect(socket.id, "Stranger disconnected");
    removeFromAllPools(socket.id);
    users.delete(socket.id);
    rateLimits.delete(socket.id);
    broadcastCount();
  });
});

// ── Start ─────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Omingle running → http://localhost:${PORT}`);
  console.log(`   Node ${process.version} | PID ${process.pid}`);

  // Keep Render free-tier warm: self-ping every 14 min so it doesn't spin down
  // Only runs when RENDER_EXTERNAL_URL is set (i.e. deployed on Render)
  if (process.env.RENDER_EXTERNAL_URL) {
    const https = require("https");
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/healthz`;
    setInterval(() => {
      https.get(pingUrl, res => {
        console.log(`[keep-alive] ping → ${res.statusCode}`);
      }).on("error", err => {
        console.warn("[keep-alive] failed:", err.message);
      });
    }, 14 * 60 * 1000);
    console.log(`   Keep-alive pinging ${pingUrl} every 14 min`);
  }
});
