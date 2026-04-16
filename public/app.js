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
const connSignal   = document.getElementById("connSignal");
const connLabel    = document.getElementById("connLabel");
const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

function updateConnStatus(type, text) {
  if (!connSignal || !connLabel) return;
  connLabel.textContent = text;
  connSignal.className  = "conn-dot " + (
    type === "online" ? "online" : 
    type === "relay"  ? "relay"  : "offline"
  );
}

function isLocalhost() {
  return ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
}

function isMediaContextSecure() {
  return window.isSecureContext || isLocalhost();
}

function hasGetUserMedia() {
  return !!navigator.mediaDevices?.getUserMedia;
}

function getMediaSupportError() {
  if (!hasGetUserMedia()) {
    return "This browser can't access your camera or microphone.";
  }
  if (!isMediaContextSecure()) {
    return "Video chat needs HTTPS to access the camera and mic.";
  }
  return "";
}

function createAudioContext(options) {
  if (!AudioContextCtor) {
    throw new Error("Web Audio is not supported in this browser");
  }
  return options ? new AudioContextCtor(options) : new AudioContextCtor();
}

async function resumeKnownAudioContexts() {
  const contexts = [audioCtx, _relayAudioCtx, _relayAudioPlayCtx].filter(Boolean);
  await Promise.all(contexts.map(ctx => (
    ctx.state === "suspended" ? ctx.resume().catch(() => {}) : Promise.resolve()
  )));
}

function attachLocalPreview(stream) {
  localVideo.srcObject = stream;
  localVideo.autoplay = true;
  localVideo.playsInline = true;
  localVideo.muted = true;
  localVideo.volume = 0;
  localVideo.setAttribute("playsinline", "");
  localVideo.setAttribute("webkit-playsinline", "");
  localVideo.play().catch(() => {});
}

function prepareRemoteVideo() {
  remoteVideo.autoplay = true;
  remoteVideo.playsInline = true;
  remoteVideo.muted = false;
  remoteVideo.volume = 1;
  remoteVideo.setAttribute("playsinline", "");
  remoteVideo.setAttribute("webkit-playsinline", "");
}

async function ensureRemotePlayback(reason = "track") {
  if (!remoteVideo.srcObject) return false;

  prepareRemoteVideo();

  try {
    await resumeKnownAudioContexts();
    await remoteVideo.play();
    _remoteIsPlaying = true;
    remotePlaceholder.classList.add("hidden");
    const iceState = peerConnection?.iceConnectionState;
    if (iceState === "connected" || iceState === "completed") {
      clearRelayFallbackTimer();
      if (_relayActive) _stopSocketRelay();
      updateConnStatus("online", "WebRTC");
    }
    return true;
  } catch (err) {
    _remoteIsPlaying = false;
    remotePlaceholder.classList.remove("hidden");
    console.warn(`[WebRTC] Remote playback blocked (${reason}):`, err?.message || err);
    if (err?.name === "NotAllowedError") {
      showToast("Tap the video to resume playback.", "info", 2800);
    }
    return false;
  }
}

function bindRemotePlaybackEvents() {
  if (_remotePlaybackBound) return;
  _remotePlaybackBound = true;

  remoteVideo.addEventListener("playing", () => {
    _remoteIsPlaying = true;
    remotePlaceholder.classList.add("hidden");
    const iceState = peerConnection?.iceConnectionState;
    if (iceState === "connected" || iceState === "completed") {
      clearRelayFallbackTimer();
      if (_relayActive) _stopSocketRelay();
      updateConnStatus("online", "WebRTC");
    } else if (_relayActive) {
      updateConnStatus("relay", "Relay Mode");
    }
  });

  const markBuffering = () => {
    _remoteIsPlaying = false;
    if (isMatched) remotePlaceholder.classList.remove("hidden");
    if (!peerConnection) return;
    const state = peerConnection.iceConnectionState;
    if (state === "connected" || state === "completed") {
      updateConnStatus("offline", "Buffering");
    }
  };

  remoteVideo.addEventListener("canplay", () => {
    if (remoteVideo.srcObject) ensureRemotePlayback("canplay").catch(() => {});
  });
  remoteVideo.addEventListener("loadedmetadata", () => {
    if (remoteVideo.srcObject) ensureRemotePlayback("loadedmetadata").catch(() => {});
  });
  remoteVideo.addEventListener("waiting", markBuffering);
  remoteVideo.addEventListener("stalled", markBuffering);
  remoteVideo.addEventListener("pause", markBuffering);
  remoteVideo.addEventListener("emptied", markBuffering);

  remotePlaceholder.addEventListener("click", async () => {
    await resumeKnownAudioContexts().catch(() => {});
    if (remoteVideo.srcObject) ensureRemotePlayback("manual-tap").catch(() => {});
  });
  remoteVideo.addEventListener("click", async () => {
    await resumeKnownAudioContexts().catch(() => {});
    if (remoteVideo.srcObject) ensureRemotePlayback("video-tap").catch(() => {});
  });
}


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
let _isOfferer       = false; // tracks which peer sent the original WebRTC offer
let _restartRequestPending = false;
let _restartRequestTimer   = null;
let _remotePlaybackBound    = false;
let _remoteIsPlaying        = false;
let _relayCandidateFound    = false; 

// ── Perfect Negotiation State ─────────────────────────────
let _makingOffer            = false;
let _ignoreOffer            = false;
let _isSettingRemoteAnswerPending = false;
let _isPolite               = false; // polite peer gives way during collisions

// ── Adaptive Bitrate & Stats ──────────────────────────────
let _statsInterval          = null;
let _lastBytesSent          = 0;
let _lastStatTime           = 0;
let _currentMaxBitrate      = 800000; // initial 800kbps

// ── Socket.io media relay fallback ────────────────────────
// Used when WebRTC ICE fails on mobile internet, VPN, or restrictive networks.
// Relay works on 100% of networks (pure TCP/WebSocket over HTTPS port 443).
let _relayActive        = false;
let _relayVideoInterval = null;
let _relayAudioCapture  = null;
let _relayAudioCtx      = null;
let _relayCanvas        = null;
let _relayRemoteCanvas  = null;
let _relayRemoteCtx     = null;
let _relayResizeHandler = null;
let _relayFallbackTimer = null;
let _matchWatchdogTimers = [];
let _activeMatchToken   = 0;
let _networkRecoveryTimer = null;
let _lastNetworkRecoveryAt = 0;

function clearRelayFallbackTimer() {
  clearTimeout(_relayFallbackTimer);
  _relayFallbackTimer = null;
}

function clearMatchWatchdogs() {
  for (const timer of _matchWatchdogTimers) clearTimeout(timer);
  _matchWatchdogTimers = [];
}

function nextMatchToken() {
  _activeMatchToken += 1;
  clearMatchWatchdogs();
  clearRelayFallbackTimer();
  return _activeMatchToken;
}

function scheduleMatchWatchdog(delay, fn) {
  const token = _activeMatchToken;
  const timer = setTimeout(() => {
    _matchWatchdogTimers = _matchWatchdogTimers.filter(id => id !== timer);
    if (!isMatched || token !== _activeMatchToken) return;
    fn();
  }, delay);
  _matchWatchdogTimers.push(timer);
  return timer;
}

function scheduleRelayFallback(reason, delay = 6000) {
  clearRelayFallbackTimer();
  if (!isMatched || currentMode !== "video") return;
  _relayFallbackTimer = setTimeout(() => {
    _relayFallbackTimer = null;
    if (!isMatched || _relayActive || _remoteIsPlaying) return;
    const iceState = peerConnection?.iceConnectionState;
    if (iceState === "connected" || iceState === "completed") return;
    console.warn(`[relay] ${reason} — switching to Socket.io relay`);
    _startSocketRelay();
  }, delay);
}

function drawRelayVideoFrame(blob) {
  if (!_relayRemoteCtx || !_relayRemoteCanvas) return;
  const W = _relayRemoteCanvas.width  || 640;
  const H = _relayRemoteCanvas.height || 480;
  if (typeof createImageBitmap === "function") {
    createImageBitmap(blob).then(bitmap => {
      if (!_relayRemoteCtx || !_relayRemoteCanvas) return;
      _relayRemoteCtx.drawImage(bitmap, 0, 0, _relayRemoteCanvas.width, _relayRemoteCanvas.height);
      bitmap.close();
    }).catch(() => drawRelayVideoFrameFallback(blob));
    return;
  }
  drawRelayVideoFrameFallback(blob);
}

function drawRelayVideoFrameFallback(blob) {
  if (!_relayRemoteCtx || !_relayRemoteCanvas) return;
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    if (_relayRemoteCtx && _relayRemoteCanvas) {
      _relayRemoteCtx.drawImage(img, 0, 0, _relayRemoteCanvas.width, _relayRemoteCanvas.height);
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function _startSocketRelay() {
  if (_relayActive) return;
  _relayActive = true;
  clearRelayFallbackTimer();
  _relayFrameRecvCount = 0;
  _relayFrameSendCount = 0;
  console.warn("[relay] WebRTC failed — switching to Socket.io media relay");
  showToast("Using relay mode (video quality reduced)", "info", 5000);

  // \u2500\u2500 Remote video: draw incoming JPEG frames onto a canvas overlay \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  _relayRemoteCanvas = document.createElement("canvas");
  _relayRemoteCanvas.width  = 320;
  _relayRemoteCanvas.height = 240;
  Object.assign(_relayRemoteCanvas.style, {
    position: "absolute", inset: "0", width: "100%", height: "100%",
    objectFit: "cover", zIndex: "2", background: "#000"
  });
  // Insert into remote video card
  const remoteCard = document.getElementById("remoteCard");
  if (remoteCard) remoteCard.style.position = "relative";
  remoteVideo.parentElement?.appendChild(_relayRemoteCanvas);
  _relayRemoteCtx = _relayRemoteCanvas.getContext("2d");
  remotePlaceholder.classList.add("hidden");
  
  // Set explicit z-index to be on top of everything
  _relayRemoteCanvas.style.zIndex = "10";
  _relayRemoteCanvas.style.pointerEvents = "none";
  updateConnStatus("relay", "Relay Mode");

  // Keep canvas pixel buffer in sync with its CSS display size.
  // CRITICAL: use remoteCard (always full-stage size), NOT remoteVideo
  // — remoteVideo has no srcObject in relay mode so its height reports 0,
  //   which was overriding height:100% with height:0px (the half-screen bug).
  const _getRelayCanvasRect = () => {
    const card = document.getElementById("remoteCard");
    return card ? card.getBoundingClientRect() : { width: 640, height: 480 };
  };

  _relayResizeHandler = () => {
    if (!_relayRemoteCanvas) return;
    const rect = _getRelayCanvasRect();
    // Update the internal pixel buffer to match display — fills the whole card
    const dpr = window.devicePixelRatio || 1;
    _relayRemoteCanvas.width  = Math.round(rect.width  * dpr) || 640;
    _relayRemoteCanvas.height = Math.round(rect.height * dpr) || 480;
    // CSS stays as inset:0 / 100%x100% — no need to set px values
  };
  window.addEventListener("resize", _relayResizeHandler);
  _relayResizeHandler();


  // \u2500\u2500 Local video capture \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  _relayCanvas = document.createElement("canvas");
  _relayCanvas.width  = 320;
  _relayCanvas.height = 240;
  const captureCtx = _relayCanvas.getContext("2d");

  _relayVideoInterval = setInterval(() => {
    if (!isMatched || !localVideo.srcObject) return;
    try {
      captureCtx.drawImage(localVideo, 0, 0, 320, 240);
      // Low-bandwidth mode: 0.3 quality is plenty for fallback (5-10KB per jpeg)
      _relayCanvas.toBlob(blob => {
        if (!blob || !socket.connected || !isMatched) return;
        blob.arrayBuffer().then(buf => {
          _relayFrameSendCount++;
          if (_relayFrameSendCount === 1) console.log("[relay] First video frame sent to partner");
          socket.emit("relay-video-frame", buf);
        });
      }, "image/jpeg", 0.3);
    } catch (_) {}
  }, 125); // 8 fps — more stable on mobile networks


  // \u2500\u2500 Audio capture via Web Audio API \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  try {
    const stream = localStream || localVideo.srcObject;
    if (stream && stream.getAudioTracks().length > 0) {
      _relayAudioCtx = createAudioContext({ sampleRate: 16000 });
      // Ensure AudioContext is running (user gesture should already have unlocked it)
      _relayAudioCtx.resume().catch(() => {});
      const src       = _relayAudioCtx.createMediaStreamSource(stream);
      const processor = _relayAudioCtx.createScriptProcessor(1024, 1, 1);
      src.connect(processor);
      processor.connect(_relayAudioCtx.destination);
      let _audioSendCount = 0;
      processor.onaudioprocess = (e) => {
        if (!isMatched || !socket.connected) return;
        const floats = e.inputBuffer.getChannelData(0);
        const int16  = new Int16Array(floats.length);
        for (let i = 0; i < floats.length; i++) {
          int16[i] = Math.max(-32768, Math.min(32767, floats[i] * 32767));
        }
        _audioSendCount++;
        if (_audioSendCount === 1) console.log("[relay] First audio chunk sent to partner");
        socket.emit("relay-audio-chunk", int16.buffer);
      };
      _relayAudioCapture = processor;
      console.log("[relay] Audio capture started at 16kHz");
    } else {
      console.warn("[relay] No audio tracks in local stream");
    }
  } catch (e) {
    console.warn("[relay audio capture]", e.message);
  }
}

function _stopSocketRelay() {
  clearRelayFallbackTimer();
  if (!_relayActive && !_relayRemoteCanvas && !_relayCanvas && !_relayResizeHandler) return;
  _relayActive = false;
  clearInterval(_relayVideoInterval);
  _relayVideoInterval = null;
  if (_relayAudioCapture) { try { _relayAudioCapture.disconnect(); } catch (_) {} }
  if (_relayAudioCtx)    { try { _relayAudioCtx.close(); }         catch (_) {} }
  _relayAudioCapture = null; _relayAudioCtx = null;
  if (_relayResizeHandler) window.removeEventListener("resize", _relayResizeHandler);
  _relayResizeHandler = null;
  if (_relayRemoteCanvas) _relayRemoteCanvas.remove();
  _relayRemoteCanvas = null; _relayRemoteCtx = null;
  _relayCanvas = null;
}

// Receive remote video frames and draw on canvas overlay
let _relayAudioPlayCtx  = null;
let _relayNextPlayTime   = 0;
let _relayFrameRecvCount = 0;
let _relayFrameSendCount = 0;

socket.on("relay-video-frame", (frame) => {
  // Auto-start relay on receive side too — don’t wait for the 22s watchdog
  // This fires as soon as the remote peer starts sending relay frames
  if (!_relayActive) {
    console.warn("[relay] Received remote relay frame — auto-starting local relay");
    _startSocketRelay();
  }
  if (!_relayRemoteCtx) return;
  clearRelayFallbackTimer();
  _remoteIsPlaying = true;
  remotePlaceholder.classList.add("hidden");
  updateConnStatus("relay", "Relay Mode");
  _relayFrameRecvCount++;
  if (_relayFrameRecvCount === 1) console.log("[relay] First video frame received from remote");
  // Ensure frame is always an ArrayBuffer (Socket.io may give Buffer on some platforms)
  const buf  = frame instanceof ArrayBuffer ? frame
             : frame.buffer ? frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)
             : frame;
  const blob = new Blob([buf], { type: "image/jpeg" });
  drawRelayVideoFrame(blob);
});

// Receive remote audio chunks and schedule playback with minimal jitter
socket.on("relay-audio-chunk", (chunk) => {
  try {
    clearRelayFallbackTimer();
    if (!_relayAudioPlayCtx || _relayAudioPlayCtx.state === "closed") {
      _relayAudioPlayCtx = createAudioContext({ sampleRate: 16000 });
      _relayNextPlayTime  = _relayAudioPlayCtx.currentTime + 0.1;
    }
    // NUCLEAR FIX: Always try to resume on every chunk (fails silent if already running)
    // Helps bypass aggressive mobile power-saver/suspension.
    if (_relayAudioPlayCtx.state === "suspended") {
      _relayAudioPlayCtx.resume().catch(() => {});
    }

    // Coerce to ArrayBuffer regardless of Node.js Buffer vs ArrayBuffer
    const rawBuf = chunk instanceof ArrayBuffer ? chunk
                 : chunk.buffer ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
                 : chunk;
    const int16  = new Int16Array(rawBuf);
    const floats = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) floats[i] = int16[i] / 32767;
    const buf    = _relayAudioPlayCtx.createBuffer(1, floats.length, 16000);
    buf.copyToChannel(floats, 0);
    const src    = _relayAudioPlayCtx.createBufferSource();
    src.buffer   = buf;
    src.connect(_relayAudioPlayCtx.destination);
    // Schedule 80ms ahead to absorb network jitter
    const now    = _relayAudioPlayCtx.currentTime;
    const playAt = Math.max(now + 0.08, _relayNextPlayTime);
    src.start(playAt);
    _relayNextPlayTime = playAt + buf.duration;
  } catch (e) {
    console.warn("[relay audio playback]", e.message);
  }
});

// ── WebRTC config ─────────────────────────────────────────
// ── WebRTC config ─────────────────────────────────────────
/**
 * Local fallback servers used when /api/ice-servers fetch fails.
 * Includes TURN UDP, TCP and TLS to survive every network topology:
 *   - Mobile data: TURN UDP usually blocked → TCP works
 *   - VPN / corporate: port 3478 blocked → turns:443 works
 *   - All networks: Socket.io relay is the absolute last resort
 */
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
  // Free TURN UDP + TCP + TLS — provides relay even without a private VPS
  { urls: "turn:freeturn.net:3479",                      username: "free", credential: "free" },
  { urls: "turn:freeturn.net:3479?transport=tcp",        username: "free", credential: "free" },
  { urls: "turns:freeturn.net:5349?transport=tcp",       username: "free", credential: "free" },
  { urls: "turns:openrelay.metered.ca:443",              username: "openrelayproject", credential: "openrelayproject" },
  { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
];






function cloneIceServer(server) {
  if (!server || !server.urls) return null;
  return {
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls
  };
}

function mergeIceServers(primary = []) {
  const merged = [];
  const seen = new Set();
  for (const source of [...primary, ...DEFAULT_ICE_SERVERS]) {
    const server = cloneIceServer(source);
    if (!server) continue;
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    const key = `${urls.join(",")}|${server.username || ""}|${server.credential || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(server);
  }
  return merged;
}

function buildRtcConfiguration(overrides = {}) {
  return {
    ...rtcConfig,
    ...overrides,
    iceServers: mergeIceServers(overrides.iceServers || rtcConfig.iceServers)
  };
}

function setRtcTransportPolicy(policy) {
  rtcConfig.iceTransportPolicy = policy === "relay" ? "relay" : "all";
}

const rtcConfig = {
  bundlePolicy:         "max-bundle",
  rtcpMuxPolicy:        "require",
  iceTransportPolicy:   "all",
  iceCandidatePoolSize: 10,
  iceServers: mergeIceServers()
};

// Fetch fresh ICE servers from our server.
// Server returns Metered.ca time-limited credentials if METERED_API_KEY is set,
// otherwise returns static TURN list. Cached for 55 min on the server side.
async function refreshIceServers() {
  let tid = null;
  try {
    const ctrl = new AbortController();
    tid = setTimeout(() => ctrl.abort(), 4000); // 4s timeout
    const res  = await fetch("/api/ice-servers", { signal: ctrl.signal });
    if (!res.ok) return;
    const servers = await res.json();
    if (Array.isArray(servers) && servers.length > 0) {
      rtcConfig.iceServers = mergeIceServers(servers);
      console.log(`[ICE] Loaded ${rtcConfig.iceServers.length} servers from server`);
    }
  } catch (e) {
    console.warn("[ICE] Server fetch failed, using static fallback:", e.message);
  } finally {
    clearTimeout(tid);
  }
}

function scheduleNetworkRecovery(reason, { forceRelay = false, immediate = false } = {}) {
  clearTimeout(_networkRecoveryTimer);
  const delay = immediate ? 0 : 900;
  _networkRecoveryTimer = setTimeout(async () => {
    _networkRecoveryTimer = null;
    const now = Date.now();
    if (now - _lastNetworkRecoveryAt < 1500) return;
    _lastNetworkRecoveryAt = now;

    console.warn(`[network] Recovery requested by ${reason}`);
    if (!socket.connected) socket.connect();
    if (!isMatched || currentMode !== "video") return;

    try {
      await refreshIceServers();
    } catch (_) {}

    if (!peerConnection) {
      if (_isOfferer) createOffer().catch(err => console.error("[network] Re-offer failed:", err));
      return;
    }

    _doIceRestart(forceRelay).catch(err => {
      console.error("[network] ICE restart failed:", err);
    });
  }, delay);
}

// Fire at startup (background — ready before user clicks Start)
refreshIceServers();

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
  if (!audioCtx) audioCtx = createAudioContext();
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
    _remoteIsPlaying = false;
    try { remoteVideo.pause(); } catch (_) {}
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
  if (localStream && localStream.getTracks().every(t => t.readyState === "live")) {
    return Promise.resolve(localStream);
  }
  if (_prewarmPromise) return _prewarmPromise; // already warming
  if (getMediaSupportError()) return Promise.resolve(null);
  // Fast, low-res capture just to get the permission grant & stream ready
  _prewarmPromise = navigator.mediaDevices
    .getUserMedia({
      video: { width: { ideal: 480 }, height: { ideal: 360 }, facingMode: "user" },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    .then(stream => {
      localStream = stream;
      attachLocalPreview(stream);
      return stream;
    })
    .catch(() => {
      // Permission denied or no camera — silently ignore, setupLocalMedia handles the error toast
      _prewarmPromise = null;
      return null;
    });
  return _prewarmPromise;
}

async function setupLocalMedia() {
  const mediaSupportError = getMediaSupportError();
  if (mediaSupportError) {
    throw new Error(mediaSupportError);
  }

  if (_prewarmPromise) {
    try { await _prewarmPromise; } catch (_) {}
  }

  // Reuse existing live stream (pre-warmed or already running)
  if (localStream && localStream.getTracks().every(t => t.readyState === "live")) {
    attachLocalPreview(localStream);
    return localStream;
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
  attachLocalPreview(stream);
  return stream;
}

function stopLocalMedia() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  _prewarmPromise = null;
  localVideo.srcObject = null;
  isMuted = false;
  isCameraOff = false;
  muteBtn.innerHTML = muteBtn.innerHTML.replace(/Unmute|Mute/, "Mute");
  cameraBtn.innerHTML = cameraBtn.innerHTML.replace(/Camera On|Camera Off/, "Camera Off");
}

// ── Peer connection ───────────────────────────────────────
function closePeerConnection() {
  pendingCandidates  = [];
  _isOfferer         = false;
  _iceRestartPending = false;
  _restartRequestPending = false;
  clearTimeout(_restartRequestTimer);
  _restartRequestTimer = null;
  _remoteIsPlaying    = false;
  _relayCandidateFound = false;
  _stopStatsMonitoring();
  _stopSocketRelay();  // always clean up relay when chat ends
  if (peerConnection) {
    peerConnection.ontrack                 = null;
    peerConnection.onicecandidate          = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.oniceconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  try { remoteVideo.pause(); } catch (_) {}
  remoteVideo.srcObject = null;
  remotePlaceholder.classList.remove("hidden");
}

function buildPeerConnection() {
  if (!localStream) throw new Error("No local stream");
  closePeerConnection();

  // NOTE: Do NOT pre-assign an empty MediaStream to remoteVideo.srcObject here.
  // Setting srcObject to an empty stream can freeze mobile browser video rendering.
  // We set it only when real tracks arrive in ontrack.
  const urlParams = new URLSearchParams(window.location.search);
  const forceRelayMode = urlParams.has("testRelay") || urlParams.has("forceRelay");

  const config = buildRtcConfiguration();
  if (forceRelayMode) {
    config.iceTransportPolicy = "relay";
    console.warn("[WebRTC] Debug: FORCING RELAY TRANSPORT POLICY");
  }

  peerConnection = new RTCPeerConnection(config);

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
      if (remoteVideo.srcObject !== inStream) {
        console.log("[WebRTC] Remote stream attached");
        remoteVideo.srcObject = inStream;
      }
    } else {
      if (!remoteVideo.srcObject) {
        console.log("[WebRTC] Creating new MediaStream for track");
        remoteVideo.srcObject = new MediaStream();
      }
      remoteVideo.srcObject.addTrack(event.track);
    }

    prepareRemoteVideo();
    event.track.onunmute = () => {
      ensureRemotePlayback("track-unmute").catch(() => {});
    };
    ensureRemotePlayback("ontrack").catch(() => {});
  };

  peerConnection.onicecandidate = event => {
    if (event.candidate) {
      const c = event.candidate;
      if (c.candidate.indexOf("typ relay") !== -1) {
        _relayCandidateFound = true;
        console.log("%c[ICE] RELAY candidate found!", "color:green;font-weight:bold");
      } else if (c.candidate.indexOf("typ srflx") !== -1) {
        console.log("[ICE] STUN (srflx) candidate found");
      } else if (c.candidate.indexOf("typ host") !== -1) {
        console.log("[ICE] Local (host) candidate found");
      }
      socket.emit("webrtc-ice-candidate", { candidate: c });
    } else {
      // ── Diagnostics: Host-Only Candidate Check ─────────────
      const sdp = peerConnection.localDescription?.sdp || "";
      const hasSrflx = sdp.includes("typ srflx");
      const hasRelay = sdp.includes("typ relay");

      console.log(`[ICE] Gathering complete. Statistics: relay=${hasRelay}, srflx=${hasSrflx}`);

      if (!hasRelay && isMatched && currentMode === "video") {
        if (!hasSrflx) {
          console.error("%c[ICE] CRITICAL: Only host candidates found. TURN/STUN are unreachable!", "color:red;font-weight:bold");
        } else {
          console.warn("%c[ICE] WARNING: No relay candidates found. Connections to restrictive NATs will FAIL.", "color:orange;font-weight:bold");
        }
      }
    }
  };


  // ── ICE connection state — fires reliably on mobile (unlike connectionstatechange) ──
  peerConnection.oniceconnectionstatechange = () => {
    if (!peerConnection) return;
    const s = peerConnection.iceConnectionState;
    console.log("[ICE]", s);
    if (s === "connected" || s === "completed") {
      statusBadge.textContent = "Connected";
      statusBadge.classList.remove("searching");
      clearRelayFallbackTimer();
      if (_relayActive && remoteVideo.srcObject) _stopSocketRelay();
      updateConnStatus("online", "WebRTC");
      clearTimeout(_restartRequestTimer);
      _restartRequestTimer = null;
      _restartRequestPending = false;
    }
    if (s === "disconnected") {
      statusBadge.textContent = "Reconnecting…";
      updateConnStatus("offline", "Signal Weak");
      // ICE disconnected — retry with relay after 6s
      setTimeout(() => {
        if (isMatched && peerConnection && !_remoteIsPlaying) _doIceRestart(true);
      }, 6000);
    }
    if (s === "failed") {
      console.warn("[ICE] Connection failed — forcing relay-only ICE restart immediately...");
      updateConnStatus("offline", "ICE Failed");
      // Immediate relay-only restart — no waiting
      _doIceRestart(true);
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
let _iceRestartPending = false;
async function _doIceRestart(forceRelay = false) {
  if (!peerConnection || !isMatched) return;

  // With Perfect Negotiation, the 'impolite' side usually initiates restarts,
  // but if we're forced to (e.g. state failed), we trigger it regardless.
  try {
    _makingOffer = true;
    setRtcTransportPolicy(forceRelay ? "relay" : "all");
    if (forceRelay) {
      console.warn("[ICE] HARD RESTART: Forcing relay-only transport policy");
    }
    // Reset gathering flags
    _relayCandidateFound = false;

    const nextConfig = buildRtcConfiguration();
    if (forceRelay) nextConfig.iceTransportPolicy = "relay";

    try {
      peerConnection.setConfiguration(nextConfig);
    } catch (configErr) {
      console.warn("[ICE] Failed to apply updated RTC config:", configErr?.message || configErr);
    }
    const offer = await peerConnection.createOffer({ iceRestart: true });
    
    // ── SDP MUNGING: Prefer VP8 (matches createOffer) ──
    const mungedSdp = preferCodec(offer.sdp, "VP8");
    offer.sdp = mungedSdp;

    await peerConnection.setLocalDescription(offer);
    if (forceRelay) scheduleRelayFallback("Relay-only ICE restart timed out");
    socket.emit("webrtc-offer", { sdp: peerConnection.localDescription });

  } catch (e) {
    console.error("[ICE restart]", e);
  } finally {
    _makingOffer = false;
    setTimeout(() => { _iceRestartPending = false; }, 4000);
  }
}



async function createOffer() {
  await refreshIceServers();
  // Reset policy to 'all' for new match start
  setRtcTransportPolicy("all");
  _isOfferer = true;
  buildPeerConnection();
  
  try {
    _makingOffer = true;
    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });

    // ── SDP MUNGING: Prefer VP8 for max cross-platform compat ──
    // VP8 is supported universally. H264 hardware acceleration can cause
    // black screens on Android when codec mismatch occurs.
    offer.sdp = preferCodec(offer.sdp, "VP8");

    await peerConnection.setLocalDescription(offer);
    socket.emit("webrtc-offer", { sdp: peerConnection.localDescription });

  } catch (err) {
    console.error("[createOffer]", err);
  } finally {
    _makingOffer = false;
  }
}


async function handleOffer(sdp) {
  try {
    const offerCollision = (sdp.type === "offer") &&
                           (_makingOffer || peerConnection.signalingState !== "stable");

    _ignoreOffer = !_isPolite && offerCollision;
    if (_ignoreOffer) {
      console.warn("[WebRTC] Offer collision — ignoring (impolite)");
      return;
    }

    // Prepare PeerConnection if it doesn't exist or is closed
    if (!peerConnection || peerConnection.signalingState === "closed") {
      await refreshIceServers();
      setRtcTransportPolicy("all");
      _isOfferer = false;
      buildPeerConnection();
    }

    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    if (sdp.type === "offer") {
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socket.emit("webrtc-answer", { sdp: peerConnection.localDescription });
    }
  } catch (err) {
    console.error("[handleOffer]", err);
  }
}


async function handleAnswer(sdp) {
  if (!peerConnection) return;
  clearTimeout(_restartRequestTimer);
  _restartRequestTimer = null;
  _restartRequestPending = false;
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
  nextMatchToken();
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
  const mediaSupportError = mode === "video" ? getMediaSupportError() : "";

  startBtn.disabled = true;
  currentInterests = interests;
  syncModeUi(mode);

  // Start Audio Contexts EARLY (User Gesture Blessing)
  // This 'pre-warms' the audio systems while the user's thumb is still on the button.
  try {
    if (!_relayAudioPlayCtx) {
      _relayAudioPlayCtx = createAudioContext({ sampleRate: 16000 });
      console.log("[Audio] Fallback playback pre-warmed");
    }
    if (_relayAudioPlayCtx.state === "suspended") _relayAudioPlayCtx.resume();
  } catch (e) {
    console.warn("Audio Context pre-warm failed:", e);
  }

  if (mediaSupportError) {
    showToast(mediaSupportError, "danger", 6000);
    startBtn.disabled = false;
    return;
  }

  // Block start until camera is ready (Ironclad Guard)

  if (mode === "video") {
    startBtn.disabled = true;
    startBtn.querySelector(".btn-text").textContent = "Camera Warming Up...";
    try {
      await setupLocalMedia();
      startBtn.disabled = false;
      startBtn.querySelector(".btn-text").textContent = "Start Omingle";
    } catch (e) {
      showToast(e?.message || "Camera failed. Please allow access.", "danger", 5000);
      startBtn.disabled = false;
      startBtn.querySelector(".btn-text").textContent = "Start Omingle";
      return;
    }
  }

  try {
    username = name;
    joinScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    messages.innerHTML = "";
    setChatEnabled(false);
    resetRemoteUi(mode === "video" ? "Finding video match…" : "Finding text match…");
    addSystemMessage(mode === "video"
      ? "🎥 Searching for a video chat partner…"
      : "💬 Searching for a text chat partner…");

    socket.emit("start-chat", { name, gender, mode, interests });
  } catch (err) {
    console.error("Start chat error:", err);
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
  nextMatchToken();
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
  nextMatchToken();
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

  if (resolvedMode === "video") {
    _startStatsMonitoring();
    // Set role for both sides before any async timer fires
    if (shouldInitiateOffer) {
      _isOfferer         = true;
      _isPolite          = false; // polite peer gives way
      _iceRestartPending = false;
      _makingOffer       = false;
      // createOffer() fetches fresh ICE servers itself before building PC
      setTimeout(() => {
        if (isMatched) createOffer().catch(err => console.error("Offer failed:", err));
      }, 30);
    } else {
      _isOfferer         = false;
      _isPolite          = true;
      _iceRestartPending = false;
      refreshIceServers(); // answerer pre-fetches fresh TURN creds too
    }


    // Proactive relay detection at 4.5s
    scheduleMatchWatchdog(4500, () => {
      if (!isMatched || _remoteIsPlaying || _relayCandidateFound || currentMode !== "video") return;
      // If no relay candidate found after 4.5s, TURN might be blocked.
      console.warn("[watchdog] No relay candidates after 4.5s — TURN likely blocked by firewall");
      updateConnStatus("offline", "Firewall detected");
    });

    // ── WATCHDOG 2: ICE restart at 5s if no video yet ──
    scheduleMatchWatchdog(5000, () => {
      if (!isMatched || !peerConnection) return;
      if (!_remoteIsPlaying) {
        console.warn("[watchdog] Remote video not playing after 5s — ICE restart");
        _doIceRestart();
      }
    });

    // ── WATCHDOG 3: Force relay-only at 8s (was 10s — faster for mobile UX) ──
    scheduleMatchWatchdog(8000, () => {
      if (!isMatched || !peerConnection) return;
      if (!_remoteIsPlaying) {
        console.warn("[watchdog] Connection failed at 8s — Forcing relay transport policy");
        
        // Hard media reset helps mobile browser recover
        if (localStream) {
          localVideo.srcObject = null;
          setTimeout(() => { 
            if (localVideo) localVideo.srcObject = localStream; 
          }, 50);
        }

        _iceRestartPending = false;
        _doIceRestart(true);
      }
    });


    // Socket.io canvas relay disabled — WebRTC + TURN is the final fallback.

  }
});

socket.on("webrtc-offer", async ({ sdp }) => {
  console.log("[Signaling] Received Offer");
  try { await handleOffer(sdp); } catch (e) { console.error("Offer handling:", e); }
});
socket.on("webrtc-answer", async ({ sdp }) => {
  console.log("[Signaling] Received Answer");
  try { await handleAnswer(sdp); } catch (e) { console.error("Answer handling:", e); }
});
socket.on("webrtc-restart-request", async ({ forceRelay = false } = {}) => {
  if (!peerConnection || !isMatched || !_isOfferer) return;
  console.log("[Signaling] Restart request received");
  try { await _doIceRestart(forceRelay); } catch (e) { console.error("ICE restart request:", e); }
});
socket.on("webrtc-ice-candidate", async ({ candidate }) => {
  // console.log("[Signaling] Received Candidate");
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
  nextMatchToken();
  isMatched = false;
  setChatEnabled(false);
  closePeerConnection();
  resetRemoteUi("Disconnected");
  typingDots.classList.add("hidden");
  addSystemMessage(`👋 ${reason || "Stranger left the chat."}`);
  sounds.leave();
  showToast("Stranger disconnected", "info");
});

socket.on("partner-disconnected", ({ reason }) => {
  if (!isMatched) return;
  _remoteIsPlaying = false;
  try { remoteVideo.pause(); } catch (_) {}
  statusBadge.textContent = "Reconnecting…";
  statusBadge.classList.add("searching");
  updateConnStatus("offline", "Reconnecting");
  remotePlaceholder.classList.remove("hidden");
  setChatEnabled(false);
  addSystemMessage(`↻ ${reason || "Stranger temporarily disconnected."}`);
  showToast("Stranger is reconnecting…", "info", 4000);
});

socket.on("partner-reconnected", ({ reason }) => {
  if (!isMatched) return;
  statusBadge.textContent = currentMode === "video" ? "Video Live" : "Text Live";
  statusBadge.classList.remove("searching");
  updateConnStatus(_relayActive ? "relay" : "online", _relayActive ? "Relay Mode" : "WebRTC");
  setChatEnabled(true);
  if (currentMode === "video" && peerConnection) {
    scheduleNetworkRecovery("partner-reconnected", { forceRelay: true, immediate: true });
  }
  addSystemMessage(`✓ ${reason || "Stranger reconnected."}`);
  showToast("Stranger reconnected", "success", 2500);
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

socket.on("reconnect",         () => { showToast("Reconnected! ✅", "success"); });
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
  if (isMatched && currentMode === "video" && peerConnection) {
    // Proactive ICE restart when transport comes back
    _doIceRestart().catch(() => {});
  }
});

// ── Network Switching Listeners ───────────────────────────
window.addEventListener("online", () => {
  console.log("[network] Back online — attempting recovery...");
  if (!socket.connected) socket.connect();
  if (isMatched && currentMode === "video" && peerConnection) {
    scheduleNetworkRecovery("browser-online", { forceRelay: false, immediate: true });
  }
  showToast("Internet restored ✅", "success", 2000);
});

window.addEventListener("offline", () => {
  console.warn("[network] Lost connection — preparing for recovery...");
  statusBadge.textContent = "Offline";
  updateConnStatus("offline", "Network Link Lost");
  showToast("Internet connection lost ⚠️", "danger", 3000);
});

// ── Adaptive Bitrate & Stats Engine ───────────────────────
function _startStatsMonitoring() {
  _stopStatsMonitoring();
  _lastBytesSent = 0;
  _lastStatTime = Date.now();
  _statsInterval = setInterval(monitorConnectionQuality, 2500);
}

function _stopStatsMonitoring() {
  clearInterval(_statsInterval);
  _statsInterval = null;
}

async function monitorConnectionQuality() {
  if (!peerConnection || !isMatched) return;
  try {
    const stats = await peerConnection.getStats();
    let rtt = 0;
    let packetsLost = 0;
    let bytesSent = 0;

    stats.forEach(report => {
      if (report.type === "remote-inbound-rtp") {
        rtt = report.roundTripTime || 0;
        packetsLost = report.packetsLost || 0;
      }
      if (report.type === "outbound-rtp" && report.kind === "video") {
        bytesSent = report.bytesSent || 0;
      }
    });

    // Update Signal Indicator
    let status = "online";
    let label  = "WebRTC";
    if (rtt > 0.4 || packetsLost > 50) {
      status = "offline";
      label  = "Poor Signal";
    } else if (rtt > 0.15 || packetsLost > 10) {
      status = "relay";
      label  = "Unstable";
    }
    if (_relayActive) {
      status = "relay";
      label = "Relay Mode";
    }
    updateConnStatus(status, label);

    // Adaptive Bitrate
    const now = Date.now();
    const dt = (now - _lastStatTime) / 1000;
    const bps = ((bytesSent - _lastBytesSent) * 8) / dt;
    _lastBytesSent = bytesSent;
    _lastStatTime  = now;

    const sender = peerConnection.getSenders().find(s => s.track?.kind === "video");
    if (sender && typeof sender.setParameters === "function") {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];

      let targetBps = 800000;
      if (rtt > 0.3) targetBps = 200000;
      else if (rtt > 0.15) targetBps = 450000;

      if (targetBps !== _currentMaxBitrate) {
        _currentMaxBitrate = targetBps;
        params.encodings[0].maxBitrate = targetBps;
        // Also scale resolution if bandwidth is very low
        params.encodings[0].scaleResolutionDownBy = targetBps < 300000 ? 2 : 1;
        sender.setParameters(params).catch(() => {});
        console.log(`[Adapt] Target Bitrate: ${targetBps} bps`);
      }
    }
  } catch (_) {}
}

/**
 * Simple SDP munging to prefer a specific codec.
 */
function preferCodec(sdp, mimeType) {
  const lines = sdp.split("\r\n");
  let videoMLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("m=video") === 0) {
      videoMLineIndex = i;
      break;
    }
  }
  if (videoMLineIndex === -1) return sdp;

  const payloadTypes = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("a=rtpmap:") === 0 && lines[i].indexOf(mimeType) !== -1) {
      const pt = lines[i].match(/a=rtpmap:(\d+)/)?.[1];
      if (pt) payloadTypes.push(pt);
    }
  }

  if (payloadTypes.length === 0) return sdp;

  const mLine = lines[videoMLineIndex].split(" ");
  const ptMap = new Set(payloadTypes);
  const newMLine = [mLine[0], mLine[1], mLine[2]];
  
  // Put our preferred PTs first
  payloadTypes.forEach(pt => newMLine.push(pt));
  // Put the rest
  for (let i = 3; i < mLine.length; i++) {
    if (!ptMap.has(mLine[i])) newMLine.push(mLine[i]);
  }

  lines[videoMLineIndex] = newMLine.join(" ");
  return lines.join("\r\n");
}

socket.on("connect", async () => {
  startBtn.disabled = false; // re-enable in case it was stuck
  if (socket.recovered) {
    _hideReconnectOverlay();
    if (isMatched) setChatEnabled(true);
    if (isMatched && peerConnection) {
      await refreshIceServers();
      _doIceRestart(true).catch(() => {});
    }
    return;
  }

  if (!chatScreen.classList.contains("hidden") && isMatched) {
    reconnectOverlay.classList.remove("hidden");
    return;
  }

  _hideReconnectOverlay();
});

// ── Page visibility — reconnect when phone wakes from sleep/background ──────
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    scheduleNetworkRecovery("visibilitychange", { forceRelay: true });
  }
});

window.addEventListener("online", () => {
  scheduleNetworkRecovery("browser-online", { forceRelay: true, immediate: true });
});

window.addEventListener("pageshow", () => {
  scheduleNetworkRecovery("pageshow");
});

window.addEventListener("focus", () => {
  if (document.visibilityState === "visible") {
    scheduleNetworkRecovery("window-focus");
  }
});

const networkInfo = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
if (networkInfo?.addEventListener) {
  networkInfo.addEventListener("change", () => {
    scheduleNetworkRecovery("connection-change", { forceRelay: true });
  });
}

// ── Safety net: auto-dismiss stuck reconnect overlay after 120s ──────────────
let _reconnectKillTimer = null;

socket.on("disconnect", () => {
  // Kill timer if already running
  clearTimeout(_reconnectKillTimer);
  // After 120 s of failed reconnect, give up and return to lobby
  _reconnectKillTimer = setTimeout(() => {
    if (!socket.connected) {
      _hideReconnectOverlay();
      showToast("Connection lost. Please check your network.", "danger", 8000);
      returnToLobby();
    }
  }, 120_000);
});

socket.on("connect", () => {
  clearTimeout(_reconnectKillTimer);
});


// ── Init ──────────────────────────────────────────────────
renderInterestPreview();
syncModeUi(getSelectedMode());
setChatEnabled(false);
resetRemoteUi("Ready");
bindRemotePlaybackEvents();
statusBadge.classList.remove("searching");

// Pre-warm camera in the background on page load (video is the default mode)
// By the time user fills the form + clicks Start, camera is already open → instant start
if (getSelectedMode() === "video") {
  // Small delay so page renders first, then ask for camera
  setTimeout(prewarmCamera, 800);
}
