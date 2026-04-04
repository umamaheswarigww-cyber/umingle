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

const path       = require("path");
const express    = require("express");
const http       = require("http");
const compress   = require("compression");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────
// Gzip all text responses — shrinks CSS/JS by ~70%, faster global load
app.use(compress({ level: 6, threshold: 1024 }));

// Static files with cache headers
// HTML: no-cache so new deployments are picked up immediately
// CSS/JS/fonts: 7-day browser cache for repeat visitors
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    } else if (/\.(css|js|woff2?|ttf|svg|png|jpg|webp)$/.test(filePath)) {
      res.setHeader("Cache-Control", "public, max-age=604800"); // 7 days
    }
  }
}));

// ── ICE / TURN credential service ────────────────────────
// Provides fresh TURN credentials to clients.
// Set env var METERED_API_KEY (from metered.ca free account) for reliable global TURN.
// Without it, falls back to free public servers (less reliable on mobile).

const STATIC_ICE = [
  // STUN — always available, no auth, used for direct P2P
  { urls: "stun:stun.l.google.com:19302"  },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  
  // TURN — FreeTURN (dedicated free TURN server)
  { urls: "turn:freeturn.net:3479", username: "free", credential: "free" },
  { urls: "turn:freeturn.net:5349", username: "free", credential: "free" },

  // TURN — OpenRelay / Global Relay via metered.ca (Backup list)
  // TLS (Turns 443) — Best for bypassing firewalls
  { urls: "turns:openrelay.metered.ca:443",              username: "openrelayproject", credential: "openrelayproject" },
  // TCP 443 — Standard HTTPS port
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
  // TCP 80 — Standard HTTP port
  { urls: "turn:openrelay.metered.ca:80?transport=tcp",  username: "openrelayproject", credential: "openrelayproject" },
  // UDP — Traditional WebRTC relay
  { urls: "turn:openrelay.metered.ca:80",                username: "openrelayproject", credential: "openrelayproject" },
];


let _iceCache = null;
let _iceCacheTime = 0;
const ICE_CACHE_TTL = 55 * 60 * 1000; // 55 min (Metered creds valid ~1hr)

async function getIceServers() {
  if (_iceCache && Date.now() - _iceCacheTime < ICE_CACHE_TTL) return _iceCache;

  const apiKey  = process.env.METERED_API_KEY;
  const appName = process.env.METERED_APP_NAME || "omingle";

  if (apiKey) {
    const https = require("https");
    try {
      const data = await new Promise((resolve, reject) => {
        https.get(
          `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${apiKey}`,
          res => {
            let body = "";
            res.on("data", d => (body += d));
            res.on("end", () => {
              try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
          }
        ).on("error", reject);
      });
      if (Array.isArray(data) && data.length > 0) {
        _iceCache    = data;
        _iceCacheTime = Date.now();
        console.log(`[TURN] Fetched ${data.length} servers from Metered.ca`);
        return _iceCache;
      }
    } catch (e) {
      console.warn("[TURN] Metered.ca fetch failed:", e.message);
    }
  }

  // Static fallback
  _iceCache    = STATIC_ICE;
  _iceCacheTime = Date.now();
  return _iceCache;
}

// Called eagerly at startup so cache is warm before first user arrives
getIceServers().catch(() => {});

// ── Health-check endpoint (Render uses this) ──────────────
app.get("/healthz", (_req, res) => res.json({ ok: true, users: users.size }));

// ── ICE servers endpoint — clients call this before WebRTC ─
app.get("/api/ice-servers", async (_req, res) => {
  try {
    const servers = await getIceServers();
    res.json(servers);
  } catch (_) {
    res.json(STATIC_ICE); // always return something
  }
});

// ── Socket.IO ─────────────────────────────────────────────
const io = new Server(server, {
  transports: ["websocket", "polling"],
  pingTimeout:        45000,
  pingInterval:       15000,
  // 1 MB — large packet buffer for high-latency mobile/VPN socket.io relay traffic
  maxHttpBufferSize:  1e6,
  connectionStateRecovery: {
    // Keep the room and socket state alive long enough for mobile network handoffs.
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  },
  cors: { origin: "*", methods: ["GET", "POST"] }
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
const disconnectTimers = new Map(); // socketId → cleanup timeout
const DISCONNECT_GRACE_MS = (2 * 60 * 1000) + 5000;

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

function clearDisconnectTimer(socketId) {
  const timer = disconnectTimers.get(socketId);
  if (timer) clearTimeout(timer);
  disconnectTimers.delete(socketId);
}

function scheduleDisconnectCleanup(socketId, reason = "Stranger disconnected") {
  const user = users.get(socketId);
  if (!user) return;

  removeFromAllPools(socketId);

  // No active match to preserve, so clean up right away.
  if (!user.roomId || !user.partnerId) {
    clearDisconnectTimer(socketId);
    disconnect(socketId, reason);
    users.delete(socketId);
    broadcastCount();
    return;
  }

  clearDisconnectTimer(socketId);

  // Let the other side know the match is temporarily unavailable, but keep the
  // session alive for the recovery window.
  io.to(user.partnerId).emit("partner-disconnected", { reason });

  const timer = setTimeout(() => {
    disconnectTimers.delete(socketId);
    if (!users.has(socketId)) return;
    disconnect(socketId, reason);
    users.delete(socketId);
    broadcastCount();
  }, DISCONNECT_GRACE_MS);

  disconnectTimers.set(socketId, timer);
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
  clearDisconnectTimer(socketId);
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

  // Socket.IO recovery preserves the socket id and rooms after short network drops.
  if (socket.recovered && disconnectTimers.has(socket.id)) {
    clearDisconnectTimer(socket.id);
    const user = users.get(socket.id);
    if (user?.roomId) socket.join(user.roomId);
    if (user?.partnerId) {
      io.to(user.partnerId).emit("partner-reconnected", { reason: "Stranger reconnected" });
    }
  }

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

  socket.on("webrtc-restart-request", ({ forceRelay = false } = {}) => {
    const user = users.get(socket.id);
    if (!user || user.mode !== "video" || !user.partnerId) return;
    io.to(user.partnerId).emit("webrtc-restart-request", { forceRelay: !!forceRelay });
  });

  socket.on("webrtc-ice-candidate", ({ candidate } = {}) => {
    const user = users.get(socket.id);
    if (!user || user.mode !== "video" || !user.partnerId || !candidate) return;
    io.to(user.partnerId).emit("webrtc-ice-candidate", { candidate });
  });

  // ── Socket.io media relay fallback ───────────────────────
  // Activated on the client when WebRTC ICE fails (mobile internet, VPN, strict NAT).
  // Works on ANY network — just TCP/WebSocket over HTTPS port 443.
  // Rate-limited to prevent abuse.

  let _lastVideoRelay = 0;
  let _lastAudioRelay = 0;

  socket.on("relay-video-frame", (frame) => {
    const user = users.get(socket.id);
    if (!user?.partnerId) return;
    // Max 30 frames/sec to prevent flooding
    const now = Date.now();
    if (now - _lastVideoRelay < 33) return;
    _lastVideoRelay = now;
    io.to(user.partnerId).emit("relay-video-frame", frame);
  });

  socket.on("relay-audio-chunk", (chunk) => {
    const user = users.get(socket.id);
    if (!user?.partnerId) return;
    // Max 50 audio chunks/sec
    const now = Date.now();
    if (now - _lastAudioRelay < 20) return;
    _lastAudioRelay = now;
    io.to(user.partnerId).emit("relay-audio-chunk", chunk);
  });


  // ── disconnect ────────────────────────────────────────
  socket.on("disconnect", () => {
    // Release IP slot
    const cnt = ipConns.get(ip) || 1;
    cnt <= 1 ? ipConns.delete(ip) : ipConns.set(ip, cnt - 1);

    scheduleDisconnectCleanup(socket.id, "Stranger disconnected");
    rateLimits.delete(socket.id);
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
    }, 12 * 60 * 1000); // Every 12 min — before Render's 15-min sleep threshold
    console.log(`   Keep-alive pinging ${pingUrl} every 12 min`);
  }
});
