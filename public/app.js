/* ═══════════════════════════════════════════════════
   Omingle — Client App (Text + Video modes only)
   ═══════════════════════════════════════════════════ */

// ── Socket ────────────────────────────────────────────────
const socket = io({
  // WebSocket preferred; polling fallback for strict firewalls/corporate proxies
  transports: ["websocket", "polling"],
  // Reconnection
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 10
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
    // STUN — Google public servers
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    // TURN — OpenRelay (free public, UDP + TCP on 80 & 443)
    // Port 80 works through restrictive firewalls that block 3478
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:80?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    // Port 443 bypasses most corporate/ISP deep-packet inspection
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ],
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require",
  // "all" tries STUN first (direct P2P), falls back to TURN automatically
  iceTransportPolicy: "all",
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

// ── Local media (adaptive quality ladder) ───────────────────
async function setupLocalMedia() {
  // Reuse existing stream if all tracks are still live
  if (localStream && localStream.getTracks().every(t => t.readyState === "live")) {
    localVideo.srcObject = localStream;
    return;
  }

  // Quality ladder: 720p → 480p → basic. First success wins.
  const QUALITY_LADDER = [
    {
      video: {
        width:     { ideal: 1280, min: 640 },
        height:    { ideal: 720,  min: 480 },
        frameRate: { ideal: 30,   min: 15 },
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
        width:     { ideal: 640 },
        height:    { ideal: 480 },
        frameRate: { ideal: 24 },
        facingMode: "user"
      },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    },
    {
      video: { facingMode: "user" },
      audio: true
    }
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
  // iOS Safari needs explicit play() after setting srcObject
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

  const remoteStream = new MediaStream();
  remoteVideo.srcObject = remoteStream;

  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    const sender = peerConnection.addTrack(track, localStream);
    if (track.kind === "video") {
      // Apply bitrate & framerate caps after SDP negotiation (async)
      setTimeout(() => {
        try {
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          // 1.5 Mbps handles 720p cleanly; browser downgrades if link is poor
          params.encodings[0].maxBitrate      = 1_500_000;
          params.encodings[0].maxFramerate    = 30;
          params.encodings[0].networkPriority = "high";
          sender.setParameters(params).catch(() => {});
        } catch (_) {}
      }, 2000);
    }
  });

  // Prefer VP9 (better quality/compression) then H264, then fallback
  peerConnection.ontrack = event => {
    const [stream] = event.streams;
    if (stream) {
      stream.getTracks().forEach(t => {
        if (!remoteStream.getTracks().some(r => r.id === t.id)) remoteStream.addTrack(t);
      });
    } else {
      remoteStream.addTrack(event.track);
    }
    remoteVideo.srcObject = remoteStream;
    // iOS Safari requires playsinline + explicit play
    remoteVideo.setAttribute("playsinline", "");
    remoteVideo.setAttribute("webkit-playsinline", "");
    remoteVideo.play().catch(() => {});
    remotePlaceholder.classList.add("hidden");
  };

  peerConnection.onicecandidate = event => {
    if (event.candidate) socket.emit("webrtc-ice-candidate", { candidate: event.candidate });
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    const state = peerConnection.connectionState;
    if (state === "connected") {
      statusBadge.textContent = "Connected";
      statusBadge.classList.remove("searching");
    }
    if (state === "failed")       peerConnection.restartIce();
    if (state === "disconnected") statusBadge.textContent = "Reconnecting…";
  };
}

async function createOffer() {
  buildPeerConnection();
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  socket.emit("webrtc-offer", { sdp: offer });
}

async function handleOffer(sdp) {
  buildPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  for (const c of pendingCandidates) await peerConnection.addIceCandidate(new RTCIceCandidate(c));
  pendingCandidates = [];
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit("webrtc-answer", { sdp: answer });
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
  chatScreen.classList.add("hidden");
  joinScreen.classList.remove("hidden");
  typingDots.classList.add("hidden");
  clearTimeout(typingTimeout);
  messages.innerHTML = "";
  charCount.textContent = "0/500";
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
modeInputs.forEach(inp => inp.addEventListener("change", () => syncModeUi(getSelectedMode())));
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
    setTimeout(() => {
      if (isMatched) createOffer().catch(err => console.error("Offer failed:", err));
    }, 120);
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
socket.on("disconnect", () => {
  reconnectOverlay.classList.remove("hidden");
  showToast("Connection lost — reconnecting…", "danger");
});

socket.on("reconnect", () => {
  reconnectOverlay.classList.add("hidden");
  showToast("Reconnected! ✅", "success");
});

socket.on("reconnect_failed", () => {
  reconnectOverlay.classList.add("hidden");
  showToast("Could not reconnect. Please refresh.", "danger", 8000);
});

// ── Init ──────────────────────────────────────────────────
renderInterestPreview();
syncModeUi(getSelectedMode());
setChatEnabled(false);
resetRemoteUi("Ready");
statusBadge.classList.remove("searching");
