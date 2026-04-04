/* ═══════════════════════════════════════════════════
   Omingle — Client App (Text + Video modes only)
   ═══════════════════════════════════════════════════ */

// ── Socket ────────────────────────────────────────────────
const socket = io({
  // Prefer WebSocket; fall back to polling for strict firewalls/mobile networks
  transports: ["websocket", "polling"],
  // Reconnection — generous for Render.com cold starts (can take 30-60s)
  reconnectionDelay:    1500,
  reconnectionDelayMax: 8000,
  reconnectionAttempts: 20,
  // Timeout for each individual connection attempt
  timeout: 20000
});

// ── DOM refs ──────────────────────────────────────────────
const joinScreen      = document.getElementById("joinScreen");
const chatScreen      = document.getElementById("chatScreen");
const nameInput       = document.getElementById("nameInput");
const genderSelect    = document.getElementById("genderSelect");
const interestsInput  = document.getElementById("interestsInput");
const interestPreview = document.getElementById("interestPreview");
const startBtn        = document.getElementById("startBtn");
const homeLink        = document.getElementById("homeLink");
const onlineCount     = document.getElementById("onlineCount");
const soundToggleBtn  = document.getElementById("soundToggleBtn");
const reconnectOverlay = document.getElementById("reconnectOverlay");
const toastContainer  = document.getElementById("toastContainer");

const localVideo   = document.getElementById("localVideo");
const remoteVideo  = document.getElementById("remoteVideo");
const remoteCard   = document.getElementById("remoteCard");
const localCard    = document.getElementById("localCard");
const remotePlaceholder = document.getElementById("remotePlaceholder");
const remoteInitial = document.getElementById("remoteInitial");
const textModeNotice= document.getElementById("textModeNotice");
const videoStage   = document.getElementById("videoStage");

const remoteTag    = document.getElementById("remoteTag");
const statusBadge  = document.getElementById("statusBadge");
const strangerLabel= document.getElementById("strangerLabel");
const modePill     = document.getElementById("modePill");
const sharedInterests = document.getElementById("sharedInterests");

const muteBtn      = document.getElementById("muteBtn");
const cameraBtn    = document.getElementById("cameraBtn");
const nextBtn      = document.getElementById("nextBtn");
const endBtn       = document.getElementById("endBtn");
const reportBtn    = document.getElementById("reportBtn");

const messages     = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn      = document.getElementById("sendBtn");
const charCount    = document.getElementById("charCount");
const typingDots   = document.getElementById("typingDots");
const scrollLockBtn= document.getElementById("scrollLockBtn");
const emojiBar     = document.getElementById("emojiBar");
const emojiFloatZone = document.getElementById("emojiFloatZone");
const particleCanvas = document.getElementById("particleCanvas");

const modeInputs = Array.from(document.querySelectorAll('input[name="chatMode"]'));

// ── State ─────────────────────────────────────────────────
let localStream      = null;
let peerConnection   = null;
let pendingCandidates= [];
let isMuted          = false;
let isCameraOff      = false;
let isMatched        = false;
let soundEnabled     = true;
let isScrollLocked   = false;
let username         = "";
let currentMode      = "video";
let currentInterests = [];
let typingTimeout    = null;
let audioCtx         = null;

// ── WebRTC config ─────────────────────────────────────────
const rtcConfig = {
  iceServers: [
    // ── STUN servers (P2P, free, global) ─────────────────────────────────
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },

    // ── TURN servers (relay, ESSENTIAL for mobile internet / CGNAT) ──────
    // FreeTURN — reliable, dedicated free TURN server
    { urls: "turn:freeturn.net:3479",         username: "free", credential: "free" },
    { urls: "turn:freeturn.net:5349",         username: "free", credential: "free" },  // TLS

    // OpenRelay (metered.ca) — backup TURN, multiple ports/protocols
    { urls: "turn:openrelay.metered.ca:80",              username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:80?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443",              username: "openrelayproject", credential: "openrelayproject" },
    { urls: "turn:openrelay.metered.ca:443?transport=tcp",username: "openrelayproject", credential: "openrelayproject" },
  ],
  bundlePolicy:         "max-bundle",
  rtcpMuxPolicy:        "require",
  iceTransportPolicy:   "all",
  iceCandidatePoolSize: 10
};

// ── Particle background ───────────────────────────────────
(function initParticles() {
  const canvas = particleCanvas;
  const ctx = canvas.getContext("2d");
  let particles = [];
  let W, H;

  function resize() {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function Particle() {
    this.x    = Math.random() * W;
    this.y    = Math.random() * H;
    this.r    = Math.random() * 1.5 + 0.3;
    this.vx   = (Math.random() - 0.5) * 0.3;
    this.vy   = (Math.random() - 0.5) * 0.3;
    this.alpha = Math.random() * 0.5 + 0.1;
    this.hue  = Math.random() > 0.5 ? 220 : 270; // blue or purple
  }

  function spawn(n) {
    for (let i = 0; i < n; i++) particles.push(new Particle());
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x = W; if (p.x > W) p.x = 0;
      if (p.y < 0) p.y = H; if (p.y > H) p.y = 0;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${p.hue}, 80%, 70%, ${p.alpha})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener("resize", () => { resize(); });
  resize();
  spawn(80);
  draw();
})();

// ── Sound engine (Web Audio API) ──────────────────────────
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function playTone(freq, type = "sine", duration = 0.12, vol = 0.15) {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (_) {}
}

const sounds = {
  message: () => playTone(880, "sine", 0.08, 0.1),
  match:   () => { playTone(440, "sine", 0.12, 0.15); setTimeout(() => playTone(660, "sine", 0.12, 0.15), 130); },
  leave:   () => playTone(220, "triangle", 0.2, 0.1),
  emoji:   () => playTone(1046, "sine", 0.07, 0.08)
};

// ── Toast notifications ───────────────────────────────────
function showToast(message, type = "info", duration = 3500) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("toast-out");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
  }, duration);
}

// ── Interest utilities ────────────────────────────────────
function parseInterests(raw) {
  return [...new Set(
    String(raw || "").split(/[\n,]/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 8);
}

function formatInterest(s) {
  return String(s || "").split(" ").filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function getSelectedMode() {
  return document.querySelector('input[name="chatMode"]:checked')?.value || "video";
}

// ── Interest preview chips ────────────────────────────────
function renderInterestPreview() {
  const interests = parseInterests(interestsInput.value);
  interestPreview.innerHTML = "";
  interestPreview.classList.toggle("empty", interests.length === 0);
  interests.forEach(item => {
    const chip = document.createElement("span");
    chip.className = "interest-chip";
    chip.textContent = formatInterest(item);
    interestPreview.appendChild(chip);
  });
}

// ── Shared interests (sidebar) ────────────────────────────
function renderShared(items) {
  sharedInterests.innerHTML = "";
  sharedInterests.classList.toggle("empty", items.length === 0);
  if (items.length === 0) {
    sharedInterests.textContent = "None this round";
    return;
  }
  items.forEach(item => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = formatInterest(item);
    sharedInterests.appendChild(chip);
  });
}

// ── Message rendering ─────────────────────────────────────
function getTimestamp() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function addSystemMessage(text) {
  const node = document.createElement("div");
  node.className = "message system";
  node.textContent = text;
  messages.appendChild(node);
  autoScroll();
}

function addChatMessage(text, type) {
  const node = document.createElement("div");
  node.className = `message ${type}`;

  const content = document.createElement("span");
  content.textContent = text;

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = getTimestamp();

  node.appendChild(content);
  node.appendChild(time);
  messages.appendChild(node);
  autoScroll();
}

// ── Scroll lock ───────────────────────────────────────────
function autoScroll() {
  if (!isScrollLocked) {
    messages.scrollTop = messages.scrollHeight;
  }
}

messages.addEventListener("scroll", () => {
  const atBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  if (atBottom && isScrollLocked) {
    isScrollLocked = false;
    scrollLockBtn.classList.add("hidden");
  } else if (!atBottom && !isScrollLocked) {
    isScrollLocked = true;
    scrollLockBtn.classList.remove("hidden");
  }
});

scrollLockBtn.addEventListener("click", () => {
  isScrollLocked = false;
  scrollLockBtn.classList.add("hidden");
  messages.scrollTop = messages.scrollHeight;
});

// ── Character counter ─────────────────────────────────────
messageInput.addEventListener("input", () => {
  const len = messageInput.value.length;
  charCount.textContent = `${len}/500`;
  charCount.className = "char-count" + (len >= 480 ? " danger" : len >= 380 ? " warn" : "");

  if (!isMatched) return;
  socket.emit("typing");
});

// ── Chat enable/disable ───────────────────────────────────
function setChatEnabled(enabled) {
  messageInput.disabled = !enabled;
  sendBtn.disabled      = !enabled;
  reportBtn.disabled    = !enabled;
  messageInput.placeholder = enabled
    ? "Type a message… (Enter to send)"
    : "Waiting for a match…";
  emojiBar.querySelectorAll(".emoji-btn").forEach(b => {
    b.disabled = !enabled;
  });
}

// ── Mode UI sync ──────────────────────────────────────────
function syncModeUi(mode) {
  currentMode = mode;
  const isVideo = mode === "video";
  modePill.textContent = isVideo ? "Video" : "Text";

  videoStage.classList.toggle("hidden", !isVideo);
  textModeNotice.classList.toggle("hidden", isVideo);
  muteBtn.disabled   = !isVideo;
  cameraBtn.disabled = !isVideo;

  if (!isVideo) {
    remoteVideo.srcObject = null;
  } else if (localStream) {
    localVideo.srcObject = localStream;
  }
}

// ── Local media ───────────────────────────────────────────
// Pre-warm flag — camera acquired before user clicks Start
let _prewarmPromise = null;

/**
 * Pre-warm the camera silently in the background.
 * Called as soon as the page loads (video mode default) and on mode switch.
 * This means zero camera-permission delay when the user clicks "Start Omingle".
 */
function prewarmCamera() {
  if (_prewarmPromise) return; // already warming
  // Fast, low-res capture just to get the permission grant & stream ready
  _prewarmPromise = navigator.mediaDevices
    .getUserMedia({
      video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    .then(stream => {
      localStream = stream;
      localVideo.srcObject = stream;
      localVideo.muted = true;
      localVideo.setAttribute("playsinline", "");
      localVideo.setAttribute("webkit-playsinline", "");
      localVideo.play().catch(() => {});
    })
    .catch(() => {
      // Permission denied or no camera — silently ignore, setupLocalMedia handles the error toast
      _prewarmPromise = null;
    });
}

async function setupLocalMedia() {
  // Reuse existing live stream (pre-warmed or already running)
  if (localStream && localStream.getTracks().every(t => t.readyState === "live")) {
    localVideo.srcObject = localStream;
    return;
  }

  // Quality ladder: start at 480p for speed → 360p → basic
  // Starting at 480p (not 720p) means camera opens 2-3x faster on mobile
  const QUALITY_LADDER = [
    {
      video: {
        width:     { ideal: 640, max: 1280 },
        height:    { ideal: 480, max: 720 },
        frameRate: { ideal: 24,  max: 30 },
        facingMode: "user"
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        sampleRate:       { ideal: 48000 }
      }
    },
    {
      video: {
        width:     { ideal: 480 },
        height:    { ideal: 360 },
        frameRate: { ideal: 20 },
        facingMode: "user"
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    },
    { video: { facingMode: "user" }, audio: true }
  ];

  let stream = null;
  for (const constraints of QUALITY_LADDER) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      break;
    } catch (e) {
      console.warn("[media] Quality fallback:", e.name);
    }
  }

  if (!stream) throw new Error("Camera/mic access denied");

  localStream = stream;
  localVideo.srcObject = stream;
  localVideo.muted = true;
  localVideo.setAttribute("playsinline", "");
  localVideo.setAttribute("webkit-playsinline", "");
  await localVideo.play().catch(() => {});
}

function stopLocalMedia() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  localVideo.srcObject = null;
  isMuted = false;
  isCameraOff = false;
  muteBtn.innerHTML = muteBtn.innerHTML.replace(/Unmute|Mute/, "Mute");
  cameraBtn.innerHTML = cameraBtn.innerHTML.replace(/Camera On|Camera Off/, "Camera Off");
}

// ── Peer connection ───────────────────────────────────────
function closePeerConnection() {
  pendingCandidates = [];
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  remotePlaceholder.classList.remove("hidden");
}

function buildPeerConnection() {
  if (!localStream) throw new Error("No local stream");
  closePeerConnection();

  // NOTE: Do NOT pre-assign an empty MediaStream to remoteVideo.srcObject here.
  // Setting srcObject to an empty stream can freeze mobile browser video rendering.
  // We set it only when real tracks arrive in ontrack.

  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    const sender = peerConnection.addTrack(track, localStream);
    if (track.kind === "video") {
      setTimeout(() => {
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate      = 800_000;
          params.encodings[0].maxFramerate    = 24;
          params.encodings[0].networkPriority = "high";
          params.encodings[0].scaleResolutionDownBy = 1;
          sender.setParameters(params).catch(() => {});
        } catch (_) {}
      }, 500);
    }
  });

  peerConnection.ontrack = event => {
    const inStream = (event.streams && event.streams[0]) || null;
    if (inStream) {
      // Only replace srcObject if we don’t already have this stream playing
      if (remoteVideo.srcObject !== inStream) remoteVideo.srcObject = inStream;
    } else {
      // Some mobile browsers only give track, no stream reference
      if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
      remoteVideo.srcObject.addTrack(event.track);
    }
    remoteVideo.setAttribute("playsinline", "");
    remoteVideo.setAttribute("webkit-playsinline", "");
    if (remoteVideo.paused) remoteVideo.play().catch(() => {});
    remotePlaceholder.classList.add("hidden");
  };

  peerConnection.onicecandidate = event => {
    if (event.candidate) socket.emit("webrtc-ice-candidate", { candidate: event.candidate });
  };

  // ── ICE connection state — fires reliably on mobile (unlike connectionstatechange) ──
  peerConnection.oniceconnectionstatechange = () => {
    if (!peerConnection) return;
    const s = peerConnection.iceConnectionState;
    console.log("[ICE]", s);
    if (s === "connected" || s === "completed") {
      statusBadge.textContent = "Connected";
      statusBadge.classList.remove("searching");
    }
    if (s === "disconnected") {
      statusBadge.textContent = "Reconnecting…";
    }
    if (s === "failed") {
      // Initiate a proper ICE restart: create new offer with iceRestart flag
      // This is more reliable than restartIce() which doesn’t resend an offer
      _doIceRestart();
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    const s = peerConnection.connectionState;
    if (s === "connected") {
      statusBadge.textContent = "Connected";
      statusBadge.classList.remove("searching");
    }
    if (s === "disconnected") statusBadge.textContent = "Reconnecting…";
  };
}

// Proper ICE restart — creates a new offer with iceRestart:true and sends it to the peer.
// Must be called only by the original offerer to avoid glare.
let _iceRestartPending = false;
async function _doIceRestart() {
  if (!peerConnection || !isMatched || _iceRestartPending) return;
  _iceRestartPending = true;
  console.warn("[ICE] Restarting ICE via new offer…");
  try {
    const offer = await peerConnection.createOffer({ iceRestart: true });
    await peerConnection.setLocalDescription(offer);
    socket.emit("webrtc-offer", { sdp: peerConnection.localDescription });
  } catch (e) {
    console.error("[ICE restart]", e);
  } finally {
    setTimeout(() => { _iceRestartPending = false; }, 4000); // cooldown
  }
}

async function createOffer() {
  buildPeerConnection();
  const offer = await peerConnection.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true
  });
  await peerConnection.setLocalDescription(offer);
  socket.emit("webrtc-offer", { sdp: offer });
}

async function handleOffer(sdp) {
  // ── ICE restart detection ─────────────────────────────────────────
  // If we already have an active peer connection, this is likely an ICE restart offer.
  // CRITICAL: Do NOT call buildPeerConnection() here — that would destroy the PC
  // and all its media senders, breaking video for both users.
  if (peerConnection && peerConnection.signalingState !== "closed") {
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
      for (const c of pendingCandidates) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
      pendingCandidates = [];
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("webrtc-answer", { sdp: peerConnection.localDescription });
      return;
    } catch (e) {
      console.warn("[handleOffer] ICE restart update failed, rebuilding PC:", e.message);
      // Fall through to full rebuild below
    }
  }

  // Fresh connection — build a new peer connection
  buildPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of pendingCandidates) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
  pendingCandidates = [];
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", { sdp: peerConnection.localDescription });
}

async function handleAnswer(sdp) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of pendingCandidates) await peerConnection.addIceCandidate(new RTCIceCandidate(c));
  pendingCandidates = [];
}

async function handleIceCandidate(candidate) {
  if (!candidate) return;
  if (peerConnection?.remoteDescription) {
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  } else {
    pendingCandidates.push(candidate);
  }
}

// ── UI helpers ────────────────────────────────────────────
function resetRemoteUi(statusText) {
  statusBadge.textContent = statusText;
  statusBadge.classList.add("searching");
  strangerLabel.textContent = "Waiting for match";
  remoteTag.textContent = "Stranger";
  remoteInitial.textContent = "?";
  renderShared([]);
  remotePlaceholder.classList.remove("hidden");
}

function returnToLobby() {
  isMatched = false;
  setChatEnabled(false);
  closePeerConnection();
  stopLocalMedia();

  // Show join screen
  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");

  // ✅ BUG FIX: always re-enable the start button so user can start again
  startBtn.disabled = false;

  // Clean up chat state
  typingDots.classList.add("hidden");
  clearTimeout(typingTimeout);
  messages.innerHTML = "";
  charCount.textContent = "0/500";
  isScrollLocked = false;
  scrollLockBtn.classList.add("hidden");

  // Hide reconnect overlay in case it was showing
  reconnectOverlay.classList.add("hidden");

  renderInterestPreview();
}

// ── Start chat flow ───────────────────────────────────────
async function startChatFlow() {
  const name      = nameInput.value.trim() || "Anonymous";
  const gender    = genderSelect.value;
  const mode      = getSelectedMode();
  const interests = parseInterests(interestsInput.value);

  startBtn.disabled = true;
  currentInterests = interests;
  syncModeUi(mode);

  // ── USER GESTURE BLESSING ─────────────────────────────────
  // iOS/Android require a user gesture to play video elements.
  // Calling .play() here "blesses" them so they can autoplay
  // the incoming WebRTC streams later without another click.
  localVideo.play().catch(() => {});
  remoteVideo.play().catch(() => {});

  try {
    if (mode === "video") {
      await setupLocalMedia();
    } else {
      stopLocalMedia();
    }

    joinScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    messages.innerHTML = "";
    setChatEnabled(false);
    resetRemoteUi(mode === "video" ? "Finding video match…" : "Finding text match…");
    addSystemMessage(mode === "video"
      ? "🎥 Searching for a video chat partner…"
      : "💬 Searching for a text chat partner…");

    username = name;
    socket.emit("start-chat", { name, gender, mode, interests });
  } catch (err) {
    showToast("Camera/mic permission required for video mode.", "danger");
    startBtn.disabled = false;
  }
}

// ── Send message ──────────────────────────────────────────
function sendMessage() {
  const message = messageInput.value.trim();
  if (!message || !isMatched) return;
  socket.emit("chat-message", { message });
  addChatMessage(message, "self");
  messageInput.value = "";
  charCount.textContent = "0/500";
  charCount.className = "char-count";
}

// ── Emoji reactions ───────────────────────────────────────
function spawnFloatingEmoji(emoji, side = "right") {
  const el = document.createElement("div");
  el.className = "emoji-float";
  el.textContent = emoji;
  el.style.left  = side === "right"
    ? `${60 + Math.random() * 30}%`
    : `${5 + Math.random() * 25}%`;
  el.style.bottom = `${40 + Math.random() * 20}px`;
  emojiFloatZone.appendChild(el);
  el.addEventListener("animationend", () => el.remove(), { once: true });
}

emojiBar.addEventListener("click", e => {
  const btn = e.target.closest(".emoji-btn");
  if (!btn || !isMatched) return;
  const emoji = btn.dataset.emoji;
  socket.emit("emoji-reaction", { emoji });
  spawnFloatingEmoji(emoji, "right");
  sounds.emoji();
});

// ── Keyboard shortcuts ────────────────────────────────────
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && isMatched && !chatScreen.classList.contains("hidden")) {
    nextBtn.click();
  }
});

// ── Event listeners ───────────────────────────────────────
modeInputs.forEach(inp => inp.addEventListener("change", () => {
  const mode = getSelectedMode();
  syncModeUi(mode);
  // Pre-warm camera immediately when user switches to video mode
  if (mode === "video") prewarmCamera();
}));
interestsInput.addEventListener("input", renderInterestPreview);
startBtn.addEventListener("click", startChatFlow);
homeLink.addEventListener("click", e => { e.preventDefault(); if (!chatScreen.classList.contains("hidden")) returnToLobby(); });

// Sound toggle
soundToggleBtn.addEventListener("click", () => {
  soundEnabled = !soundEnabled;
  soundToggleBtn.classList.toggle("muted", !soundEnabled);
  showToast(soundEnabled ? "Sounds on 🔊" : "Sounds off 🔇", "info", 1800);
});

// Mute
muteBtn.addEventListener("click", () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.querySelector("svg + *") // update text node
  muteBtn.innerHTML = muteBtn.innerHTML.replace(/Unmute|Mute/, isMuted ? "Unmute" : "Mute");
  showToast(isMuted ? "Mic muted 🔇" : "Mic on 🎙️", "info", 1500);
});

// Camera
cameraBtn.addEventListener("click", () => {
  if (!localStream) return;
  isCameraOff = !isCameraOff;
  localStream.getVideoTracks().forEach(t => { t.enabled = !isCameraOff; });
  cameraBtn.innerHTML = cameraBtn.innerHTML.replace(/Camera On|Camera Off/, isCameraOff ? "Camera On" : "Camera Off");
  showToast(isCameraOff ? "Camera off 📷" : "Camera on 🎥", "info", 1500);
});

// Next
nextBtn.addEventListener("click", () => {
  addSystemMessage("⏭ Skipping to next conversation…");
  isMatched = false;
  setChatEnabled(false);
  closePeerConnection();
  resetRemoteUi(currentMode === "video" ? "Finding next match…" : "Finding next match…");
  typingDots.classList.add("hidden");
  socket.emit("next");
});

// End
endBtn.addEventListener("click", () => {
  socket.emit("end-chat");
  returnToLobby();
});

// Report
reportBtn.addEventListener("click", () => {
  if (!isMatched) return;
  const reason = prompt("Reason for reporting:", "Abusive behavior") || "User reported";
  socket.emit("report-user", { reason });
  showToast("Report submitted. Thanks! ✅", "success");
});

// Send
sendBtn.addEventListener("click", sendMessage);
messageInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

// ── Socket events ─────────────────────────────────────────
socket.on("user-count", ({ count }) => {
  onlineCount.textContent = count.toLocaleString();
});

socket.on("waiting", ({ message, mode }) => {
  syncModeUi(mode || currentMode);
  resetRemoteUi("Searching…");
  addSystemMessage(message || "Searching for a stranger…");
});

socket.on("matched", ({ strangerGender, strangerName, mode, sharedInterests: si = [], shouldInitiateOffer }) => {
  const resolvedMode  = mode || currentMode;
  const genderLabel   = (strangerGender || "other").replace(/^./, c => c.toUpperCase());
  const displayName   = strangerName || `Stranger (${genderLabel})`;

  currentMode = resolvedMode;
  isMatched   = true;
  syncModeUi(resolvedMode);
  setChatEnabled(true);

  statusBadge.textContent = resolvedMode === "video" ? "Video Live" : "Text Live";
  statusBadge.classList.remove("searching");
  strangerLabel.textContent = strangerName ? `${strangerName} · ${genderLabel}` : `Stranger · ${genderLabel}`;
  remoteTag.textContent = displayName;
  remoteInitial.textContent = (strangerName || "S")[0].toUpperCase();
  renderShared(si);

  const siText = si.length ? ` · Shared: ${si.map(formatInterest).join(", ")}` : "";
  addSystemMessage(`✅ Connected with ${displayName}${siText}`);
  sounds.match();
  showToast(`Matched with ${displayName}! 🎉`, "success");

  if (resolvedMode === "video" && shouldInitiateOffer) {
    // Reset ICE restart flag for fresh match
    _iceRestartPending = false;
    // 30ms delay — just enough for both peers to register the match before offer
    setTimeout(() => {
      if (isMatched) createOffer().catch(err => console.error("Offer failed:", err));
    }, 30);
  }

  if (resolvedMode === "video") {
    // ── Black-screen watchdog ────────────────────────────────────────────────
    // After 6s, if remote video hasn't started rendering, force an ICE restart.
    // This catches silent TURN failures where ICE state never explicitly says "failed".
    setTimeout(() => {
      if (!isMatched || !peerConnection) return;
      const notPlaying = remoteVideo.readyState < 2 || remoteVideo.videoWidth === 0;
      const iceNotGood = peerConnection.iceConnectionState !== "connected" &&
                         peerConnection.iceConnectionState !== "completed";
      if (notPlaying && iceNotGood) {
        console.warn("[watchdog] Remote video not playing after 6s — forcing ICE restart");
        showToast("Video connection slow, retrying…", "info", 3000);
        _doIceRestart();
      }
    }, 6000);

    // Second watchdog at 14s — if still black after first restart attempt
    setTimeout(() => {
      if (!isMatched || !peerConnection) return;
      const stillBlack = remoteVideo.readyState < 2 || remoteVideo.videoWidth === 0;
      if (stillBlack) {
        console.warn("[watchdog] Still black after 14s — hard rebuild");
        showToast("Video reconnecting…", "info", 3000);
        _iceRestartPending = false;
        _doIceRestart();
      }
    }, 14000);
  }
});

socket.on("webrtc-offer", async ({ sdp }) => {
  try { await handleOffer(sdp); } catch (e) { console.error("Offer handling:", e); }
});
socket.on("webrtc-answer", async ({ sdp }) => {
  try { await handleAnswer(sdp); } catch (e) { console.error("Answer handling:", e); }
});
socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  try { await handleIceCandidate(candidate); } catch (e) { console.error("ICE:", e); }
});

socket.on("chat-message", ({ from, message }) => {
  if (!message || from === socket.id) return;
  addChatMessage(message, "other");
  sounds.message();
});

socket.on("typing", name => {
  typingDots.classList.remove("hidden");
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => typingDots.classList.add("hidden"), 1800);
});

socket.on("emoji-reaction", ({ emoji }) => {
  spawnFloatingEmoji(emoji, "left");
  sounds.emoji();
});

socket.on("partner-left", ({ reason }) => {
  isMatched = false;
  setChatEnabled(false);
  closePeerConnection();
  resetRemoteUi("Disconnected");
  typingDots.classList.add("hidden");
  addSystemMessage(`👋 ${reason || "Stranger left the chat."}`);
  sounds.leave();
  showToast("Stranger disconnected", "info");
});

socket.on("chat-ended", ({ message }) => {
  addSystemMessage(message || "Chat ended.");
});

// ── Reconnection ──────────────────────────────────────────
// Only show overlay for unexpected drops (not when user intentionally ends chat)
let _intentionalLeave = false;

const _origEndBtn = endBtn.onclick;
endBtn.addEventListener("click", () => { _intentionalLeave = true; }, { capture: true });
nextBtn.addEventListener("click", () => { _intentionalLeave = true; }, { capture: true });
homeLink.addEventListener("click", () => { _intentionalLeave = true; }, { capture: true });

socket.on("disconnect", (reason) => {
  // Don't flash the overlay when WE initiated the disconnect
  if (_intentionalLeave) { _intentionalLeave = false; return; }
  // Only show reconnect overlay if we're actually in a chat session
  if (!chatScreen.classList.contains("hidden")) {
    reconnectOverlay.classList.remove("hidden");
  }
  showToast("Connection lost — reconnecting…", "danger");
});

function _hideReconnectOverlay() {
  reconnectOverlay.classList.add("hidden");
  _intentionalLeave = false;
}

socket.on("reconnect",         () => { _hideReconnectOverlay(); showToast("Reconnected! ✅", "success"); });
socket.on("reconnect_attempt", (n) => {
  // After 5 failed attempts try switching to polling as fallback
  if (n === 5) socket.io.opts.transports = ["polling", "websocket"];
});
socket.on("reconnect_failed",  () => {
  _hideReconnectOverlay();
  showToast("Could not reconnect. Please refresh.", "danger", 8000);
  returnToLobby();
});

// Also hide overlay as soon as socket re-connects at transport level
socket.on("connect", () => {
  _hideReconnectOverlay();
  startBtn.disabled = false; // re-enable in case it was stuck
});

// ── Page visibility — reconnect when phone wakes from sleep/background ──────
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!socket.connected) {
      socket.connect(); // force reconnect attempt immediately
    }
  }
});

// ── Safety net: auto-dismiss stuck reconnect overlay after 90s ───────────────
let _reconnectKillTimer = null;

socket.on("disconnect", () => {
  // Kill timer if already running
  clearTimeout(_reconnectKillTimer);
  // After 90 s of failed reconnect, give up and return to lobby
  _reconnectKillTimer = setTimeout(() => {
    if (!socket.connected) {
      _hideReconnectOverlay();
      showToast("Connection lost. Please check your network.", "danger", 8000);
      returnToLobby();
    }
  }, 90_000);
});

socket.on("connect", () => {
  clearTimeout(_reconnectKillTimer);
});


// ── Init ──────────────────────────────────────────────────
renderInterestPreview();
syncModeUi(getSelectedMode());
setChatEnabled(false);
resetRemoteUi("Ready");
statusBadge.classList.remove("searching");

// Pre-warm camera in the background on page load (video is the default mode)
// By the time user fills the form + clicks Start, camera is already open → instant start
if (getSelectedMode() === "video") {
  // Small delay so page renders first, then ask for camera
  setTimeout(prewarmCamera, 800);
}
