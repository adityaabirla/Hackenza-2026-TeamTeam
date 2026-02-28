/**
 * ============================================================
 *  LI-FI OWC TERMINAL — script.js
 *  Optical Wireless Communication via On-Off Keying (OOK)
 * ============================================================
 *
 *  PROTOCOL SUMMARY
 *  ─────────────────
 *  Bit rate  : 300ms per bit  (~3.3 bits/sec — slow for reliability)
 *  Preamble  : "101011"       (6-bit start-of-frame marker)
 *  Postamble : "000000"       (6-bit end-of-frame marker)
 *  Encoding  : OOK
 *              Logic 1  →  Light ON  (torch or white screen)
 *              Logic 0  →  Light OFF (torch off or black screen)
 *
 *  RECEIVER STATE MACHINE
 *  ───────────────────────
 *  IDLE  →  CALIBRATING  →  SCANNING  →  READING  →  DONE
 *                                  ↑___________________________↓  (loops)
 *
 *  THRESHOLDING
 *  ─────────────
 *  During calibration we measure ambient brightness B_ambient.
 *  Threshold T = B_ambient + THRESHOLD_OFFSET (default 30).
 *  A sample > T  → bit 1
 *  A sample ≤ T  → bit 0
 *  The threshold auto-adjusts via an exponential moving average
 *  of the ambient floor to handle slow lighting changes.
 *
 *  SYNCHRONISATION (Preamble detection)
 *  ──────────────────────────────────────
 *  The receiver continuously samples at BIT_RATE_MS intervals.
 *  It maintains a rolling "preamble buffer" of the last 6 bits.
 *  When the buffer matches PREAMBLE, it transitions to READING.
 *  This means the receiver doesn't need to be time-locked with
 *  the sender — it self-synchronises on the start-of-frame.
 *
 * ============================================================
 */

"use strict";

// ─────────────────────────────────────────────
//  PROTOCOL CONSTANTS
// ─────────────────────────────────────────────
const BIT_RATE_MS        = 300;     // milliseconds per bit
const PREAMBLE           = "101011";
const POSTAMBLE          = "000000";
const THRESHOLD_OFFSET   = 30;      // brightness units above ambient to call a "1"
const CALIB_DURATION_MS  = 2000;    // how long to measure ambient during calibration
const ROI_SIZE           = 50;      // pixels — size of the "Target Box" sample region
const GRAPH_HISTORY      = 120;     // number of brightness samples to show on chart
const EMA_ALPHA          = 0.02;    // exponential moving average coefficient for slow ambient drift
const SPACE_CHAR         = "~";     // substitute for space during OOK (avoids long zero runs)
const BRIGHTNESS_BUFFER_SIZE = 7;   // median filter window (odd number for clean median)
const EDGE_CONFIRM_COUNT = 3;       // consecutive bright samples needed to confirm a real edge
const BITS_PER_CHAR      = 24;      // 3 copies × 8 bits (triple redundancy for error correction)
const PREAMBLE_TOLERANCE = 1;       // Hamming distance tolerance for preamble matching
const MAX_SCAN_BITS      = 30;      // Max bits to sample in scanning before resetting edge detection

// ─────────────────────────────────────────────
//  BOOT ANIMATION
// ─────────────────────────────────────────────
const BOOT_MESSAGES = [
  "CHECKING HARDWARE...",
  "LOADING OOK PROTOCOL...",
  "CALIBRATING THRESHOLDS...",
  "INITIALISING CAMERA STACK...",
  "READY.",
];

(function bootSequence() {
  const bar    = document.getElementById("boot-bar");
  const status = document.getElementById("boot-status");
  let i = 0;
  const interval = setInterval(() => {
    const pct = ((i + 1) / BOOT_MESSAGES.length) * 100;
    bar.style.width = pct + "%";
    status.textContent = BOOT_MESSAGES[i];
    i++;
    if (i >= BOOT_MESSAGES.length) {
      clearInterval(interval);
      setTimeout(() => {
        document.getElementById("boot-screen").classList.add("hidden");
        document.getElementById("app").classList.remove("hidden");
      }, 400);
    }
  }, 280);
})();

// ─────────────────────────────────────────────
//  MODE SWITCHING
// ─────────────────────────────────────────────
document.querySelectorAll(".mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.mode;

    // Update button active state
    document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");

    // Show correct panel
    document.getElementById("panel-sender").classList.toggle("active",   mode === "sender");
    document.getElementById("panel-receiver").classList.toggle("active", mode === "receiver");
    document.getElementById("panel-sender").classList.toggle("hidden",   mode !== "sender");
    document.getElementById("panel-receiver").classList.toggle("hidden", mode !== "receiver");

    // Stop any active receiver when switching
    if (mode === "sender" && rxState !== "IDLE") {
      stopReceiver();
    }
  });
});

// ─────────────────────────────────────────────
//  UTILITY HELPERS
// ─────────────────────────────────────────────

/** Promise-based sleep for async/await timing loops */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * MEDIAN FILTER — rejects camera glitch spikes.
 * Maintains a rolling buffer of raw brightness values and returns the median.
 * Single-frame camera API hiccups (shakes, exposure jumps) are rejected.
 */
let brightnessBuffer = [];
function medianFilter(raw) {
  brightnessBuffer.push(raw);
  if (brightnessBuffer.length > BRIGHTNESS_BUFFER_SIZE) brightnessBuffer.shift();
  const sorted = [...brightnessBuffer].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Compute Hamming distance between two equal-length bit strings */
function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) d++;
  }
  return d;
}

/** Convert a string to its ASCII binary representation.
 *  Each character → 24-bit binary string (8-bit block × 3 copies for triple redundancy).
 */
function textToBinary(text) {
  return text.split("").map(ch => {
    const b = ch.charCodeAt(0).toString(2).padStart(8, "0");
    return b + b + b; // triple redundancy (3 copies per character)
  }).join("");
}

/** Convert a binary string back to ASCII text.
 *  Processes 24 bits at a time (3 × 8-bit copies — triple redundancy).
 *  Majority voting: if 2+ copies agree → use that. All 3 differ → use copy B.
 */
function binaryToText(binary) {
  const trimmed = binary.slice(0, Math.floor(binary.length / BITS_PER_CHAR) * BITS_PER_CHAR);
  let result = "";
  let hasUncorrectable = false;
  let correctedCount = 0;
  let conflictDetails = [];

  for (let i = 0; i < trimmed.length; i += BITS_PER_CHAR) {
    const b1 = trimmed.slice(i, i + 8);
    const b2 = trimmed.slice(i + 8, i + 16);
    const b3 = trimmed.slice(i + 16, i + 24);
    const charIdx = i / BITS_PER_CHAR + 1;

    let chosen;
    if (b1 === b2 && b2 === b3) {
      // Perfect — all 3 copies match
      chosen = b1;
    } else if (b1 === b2) {
      chosen = b1;
      correctedCount++;
      conflictDetails.push(`Char ${charIdx}: Copy C differs (${b3}), corrected to ${b1}`);
    } else if (b1 === b3) {
      chosen = b1;
      correctedCount++;
      conflictDetails.push(`Char ${charIdx}: Copy B differs (${b2}), corrected to ${b1}`);
    } else if (b2 === b3) {
      chosen = b2;
      correctedCount++;
      conflictDetails.push(`Char ${charIdx}: Copy A differs (${b1}), corrected to ${b2}`);
    } else {
      // All three different — use copy B (middle) as fallback
      chosen = b2;
      hasUncorrectable = true;
      conflictDetails.push(`Char ${charIdx}: ALL 3 DIFFER (${b1}/${b2}/${b3}), using B`);
    }

    result += String.fromCharCode(parseInt(chosen, 2));
  }

  return {
    error: hasUncorrectable,
    corrected: correctedCount,
    message: result,
    details: conflictDetails
  };
}

/** Append a timestamped entry to a log element */
function log(elementId, message, type = "") {
  const container = document.getElementById(elementId);
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  entry.textContent = `[${ts}] ${message}`;
  container.appendChild(entry);
  container.scrollTop = container.scrollHeight;
}

/** Update the header signal indicator */
function setSignal(state, label) {
  const dot  = document.getElementById("signal-dot");
  const lbl  = document.getElementById("signal-label");
  dot.className  = "signal-dot " + state;
  lbl.textContent = label;
}

// ─────────────────────────────────────────────
//  ████████  SENDER MODULE  ████████
// ─────────────────────────────────────────────

let txActive     = false;   // Is a transmission in progress?
let torchStream  = null;    // MediaStream for torch control
let torchTrack   = null;    // MediaStreamTrack with torch support
let useTorch     = false;   // true = hardware torch, false = screen flash fallback

// DOM refs
const senderInput     = document.getElementById("sender-input");
const charCountEl     = document.getElementById("char-count");
const binaryDisplay   = document.getElementById("binary-display");
const frameData       = document.getElementById("frame-data");
const btnConvert      = document.getElementById("btn-convert");
const btnTransmit     = document.getElementById("btn-transmit");
const indicatorWrap   = document.getElementById("flashlight-indicator");
const indicatorState  = document.getElementById("indicator-state");
const progressWrap    = document.getElementById("progress-wrap");
const progressFill    = document.getElementById("progress-fill");
const progressBit     = document.getElementById("progress-bit");
const progressPct     = document.getElementById("progress-pct");
const screenFlash     = document.getElementById("screen-flash");

// Live char counter
senderInput.addEventListener("input", () => {
  charCountEl.textContent = senderInput.value.length;
});

// ── ENCODE BUTTON ──
btnConvert.addEventListener("click", () => {
  const text = senderInput.value.trim();
  if (!text) return;

  // Replace spaces with ~ to avoid long zero-runs in OOK channel
  // Space (ASCII 32 = 00100000) has 6 consecutive zeros matching POSTAMBLE!
  // Tilde (ASCII 126 = 01111110) has mostly 1s — ideal for optical sync
  const wireText = text.replace(/ /g, SPACE_CHAR);
  if (wireText !== text) {
    log("tx-log", `Spaces → ~: "${text}" → "${wireText}"`, "info");
  }

  const binary = textToBinary(wireText);

  // Render each character and its 16 bits for debugging
  let dbgHTML = "";
  for (let i = 0; i < wireText.length; i++) {
    const char = wireText[i];
    const origChar = text[i] || '';
    const bin1 = binary.substr(i * BITS_PER_CHAR, 8);
    const bin2 = binary.substr(i * BITS_PER_CHAR + 8, 8);
    const bin3 = binary.substr(i * BITS_PER_CHAR + 16, 8);
    const displayChar = origChar === ' ' ? 'SPACE→~' : char;
    dbgHTML += `<div style="margin-bottom: 4px; font-size: 11px;"><code>${bin1} ${bin2} ${bin3}</code> <span style="color:var(--text-dim);">→</span> <strong style="color:var(--cyan);">${displayChar}</strong> <span style="color:var(--green);font-size:9px">(3×)</span></div>`;
  }
  binaryDisplay.innerHTML = dbgHTML;

  frameData.textContent = binary;
  frameData.classList.remove("dim");

  btnTransmit.disabled = false;
  log("tx-log", `Encoded "${text}" → ${binary.length} bits`, "info");
});

// ── TRANSMIT BUTTON ──
btnTransmit.addEventListener("click", async () => {
  if (txActive) return;

  const binary = frameData.textContent;
  if (!binary || binary === "—") {
    log("tx-log", "Nothing to transmit. Encode a message first.", "err");
    return;
  }

  // Request camera access to get torch capability
  await initTorch();

  // Build the full frame: Preamble + Data + Postamble
  const fullFrame = PREAMBLE + binary + POSTAMBLE;
  log("tx-log", `Frame: ${fullFrame.length} bits total`, "info");
  log("tx-log", "Transmitting...", "tx");

  txActive = true;
  btnTransmit.disabled = true;
  btnConvert.disabled  = true;
  progressWrap.classList.remove("hidden");
  setSignal("busy", "TRANSMITTING");

  await transmitFrame(fullFrame);

  txActive = false;
  btnTransmit.disabled = false;
  btnConvert.disabled  = false;
  setLight(false);  // Ensure light is off after transmission
  setIndicatorState("STANDBY", false);
  setSignal("idle", "IDLE");
  log("tx-log", "Transmission complete.", "ok");

  // Release torch track if we used it
  if (torchTrack) {
    torchTrack.stop();
    torchTrack = null;
    torchStream = null;
  }
});

/**
 * REQUEST TORCH / CAMERA
 * Tries to acquire the hardware torch via the Torch API.
 * On failure (especially iOS Safari which doesn't support torch),
 * falls back to screen modulation.
 */
async function initTorch() {
  try {
    torchStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    torchTrack = torchStream.getVideoTracks()[0];

    // Check if torch capability exists
    const capabilities = torchTrack.getCapabilities();
    if (capabilities.torch) {
      useTorch = true;
      log("tx-log", "Hardware torch detected ✓", "ok");
    } else {
      // Torch API not supported — use screen flash fallback
      useTorch = false;
      log("tx-log", "Torch not supported → screen fallback", "info");
      torchTrack.stop(); // Don't need the stream
      torchStream = null;
      torchTrack  = null;
    }
  } catch (err) {
    // Camera denied or not available — screen only
    useTorch = false;
    log("tx-log", `Camera unavailable: ${err.message} → screen fallback`, "err");
  }
}

/**
 * SET LIGHT STATE
 * Either toggles the hardware torch or the full-screen flash overlay.
 *
 * @param {boolean} on - true = light on, false = light off
 */
async function setLight(on) {
  if (useTorch && torchTrack) {
    try {
      await torchTrack.applyConstraints({ advanced: [{ torch: on }] });
    } catch (e) {
      // Torch constraint failed mid-transmission; silently fall through
    }
  } else {
    // SCREEN MODULATION FALLBACK
    // When torch isn't available, flash the entire screen white/black.
    // The receiver camera reads brightness changes through the screen.
    screenFlash.classList.remove("hidden", "on", "off");
    screenFlash.classList.add(on ? "on" : "off");
  }
}

/**
 * TRANSMISSION LOOP
 * Iterates over each bit in the frame at BIT_RATE_MS interval.
 * Uses async/await to create a non-blocking "precise" timer.
 *
 * Note on timing precision:
 *   setTimeout isn't perfectly precise. For audio/video sync you'd use
 *   AudioContext.currentTime. At 300ms/bit the drift is negligible.
 *
 * @param {string} frame - full bit string including preamble/postamble
 */
async function transmitFrame(frame) {
  const total = frame.length;

  for (let i = 0; i < total; i++) {
    const bit = frame[i];
    const isOn = bit === "1";

    // Drive the light
    await setLight(isOn);

    // Update visual indicator
    setIndicatorState(isOn ? "1 — LIGHT ON" : "0 — LIGHT OFF", isOn);

    // Update progress bar
    const pct = Math.round(((i + 1) / total) * 100);
    progressFill.style.width = pct + "%";
    progressBit.textContent  = `BIT ${i + 1}/${total}`;
    progressPct.textContent  = pct + "%";

    // Wait one bit period before the next bit
    await sleep(BIT_RATE_MS);
  }
}

/** Update the visual flashlight indicator on the sender UI */
function setIndicatorState(label, isOn) {
  indicatorWrap.classList.toggle("indicator-on", isOn);
  indicatorState.textContent = label;
  indicatorState.style.color = isOn
    ? "var(--amber)"
    : "var(--text-dim)";
}

// ─────────────────────────────────────────────
//  ████████  RECEIVER MODULE  ████████
// ─────────────────────────────────────────────

/**
 * RECEIVER STATE MACHINE (IMPROVED)
 * ─────────────────────────────────────────────
 * States:
 *   IDLE        → Nothing happening. Camera not started.
 *   CALIBRATING → 2-second ambient measurement before listening.
 *   SCANNING    → Actively sampling, looking for PREAMBLE "101011".
 *   READING     → Preamble found; recording payload bits + live decode.
 *   DONE        → Postamble "000000" received; message decoded.
 *   COMPLETE    → Final state after postamble; auto-stopped.
 *
 * ROBUSTNESS IMPROVEMENTS:
 *   - Multi-sample majority voting: 5 sub-samples per bit period
 *   - Adaptive threshold with hysteresis band
 *   - Live character-by-character decoding during READING
 *   - Timeout guard to prevent stuck READING state
 *   - Consecutive-zero guard for postamble (must match exactly)
 *   - Message history accumulation
 *   - Clear auto-stop on postamble detection
 */
let rxState          = "IDLE";
let rxStream         = null;    // MediaStream from back camera
let rxAnimFrame      = null;    // requestAnimationFrame handle for 60fps loop
let threshold        = 128;     // Dynamic threshold (brightness value)
let ambientBaseline  = 0;       // Measured ambient brightness
let rxBitBuffer      = [];      // Accumulated decoded bits
let preambleWindow   = [];      // Rolling 6-bit window for preamble detection
let graphData        = [];      // Brightness history for the live chart
let messageCount     = 0;       // Messages received this session
let rxLoopActive     = false;   // Flag to control sampling loop
let lastSampleTime   = 0;       // Timestamp of last bit sample

let sampleTimeout    = null;
let samplerLoopActive = false;
let readingStartTime = 0;       // Timestamp when READING state started
let lastBitConfidence = 0;      // Confidence of last bit decision (0-100)
let edgeConfirmCounter = 0;     // Counter for confirmed consecutive bright readings
let debugBitLog = [];           // Full debug log of every bit with metadata
let rawBrightnessHistory = [];  // Unfiltered brightness values for debug
let bitPeriodSamples = [];      // Recent brightness readings for multi-sample voting
let scanBitsSinceEdge = 0;      // Bits sampled since last edge detection
let fallingEdgeTimer = 0;       // Timer for falling edge detection timeout

// Robustness constants
const MULTI_SAMPLE_COUNT  = 5;      // Sub-samples per bit period for majority voting
const MULTI_SAMPLE_DELAY  = 40;     // ms between sub-samples (5 × 40ms = 200ms in 300ms window)
const MAX_PAYLOAD_BITS    = 3600;   // Max payload before forced timeout (150 chars × 24)
const READING_TIMEOUT_MS  = 60000;  // 60s max reading time before forced stop
const HYSTERESIS_BAND     = 8;      // Brightness units for hysteresis (prevents flicker at threshold)

// DOM refs
const rxVideo       = document.getElementById("receiver-video");
const hiddenCanvas  = document.getElementById("hidden-canvas");
const graphCanvas   = document.getElementById("graph-canvas");
const btnRxStart    = document.getElementById("btn-rx-start");
const btnRxStop     = document.getElementById("btn-rx-stop");
const btnCalibrate  = document.getElementById("btn-calibrate");
const reticleBox    = document.getElementById("reticle-box");
const rxStateBadge  = document.getElementById("rx-state-badge");
const statThreshold = document.getElementById("stat-threshold");
const statCurrent   = document.getElementById("stat-current");
const statStatEl    = document.getElementById("stat-state");
const statBitsEl    = document.getElementById("stat-bits");
const statConfidence = document.getElementById("stat-confidence");
const bitBufferEl   = document.getElementById("bit-buffer");
const decodedOutput = document.getElementById("decoded-output");
const liveDecode    = document.getElementById("live-decode");
const liveCharsCount = document.getElementById("live-chars-count");
const liveBitsProgress = document.getElementById("live-bits-progress");
const rxBanner      = document.getElementById("rx-status-banner");
const rxBannerIcon  = document.getElementById("rx-banner-icon");
const rxBannerText  = document.getElementById("rx-banner-text");
const messageHistory = document.getElementById("message-history");

const graphCtx = graphCanvas.getContext("2d");
const hiddenCtx = hiddenCanvas.getContext("2d", { willReadFrequently: true });

// Resize graph canvas to match CSS size
function resizeGraphCanvas() {
  const rect = graphCanvas.getBoundingClientRect();
  graphCanvas.width  = rect.width  || 400;
  graphCanvas.height = rect.height || 120;
}
window.addEventListener("resize", resizeGraphCanvas);
resizeGraphCanvas();

// ── BANNER UPDATER ──
function updateBanner(state, text, icon) {
  rxBanner.className = "rx-status-banner " + state;
  rxBannerText.textContent = text;
  if (icon) rxBannerIcon.textContent = icon;
}

// ── START RECEIVER ──
btnRxStart.addEventListener("click", async () => {
  if (rxState !== "IDLE" && rxState !== "COMPLETE") return;
  await startReceiver();
});

btnRxStop.addEventListener("click", stopReceiver);

btnCalibrate.addEventListener("click", () => {
  if (rxState === "SCANNING" || rxState === "READING") {
    runCalibration();
  } else {
    log("rx-log", "Start the receiver first, then calibrate.", "err");
  }
});

async function startReceiver() {
  log("rx-log", "Requesting camera access...", "info");
  updateBanner("calibrating", "STARTING CAMERA...", "⟳");

  try {
    rxStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",
        width:  { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 60, min: 30 }
      }
    });

    // Lock camera exposure/WB/focus to prevent auto-adjustments causing glitches
    try {
      const vTrack = rxStream.getVideoTracks()[0];
      const caps = vTrack.getCapabilities ? vTrack.getCapabilities() : {};
      const adv = {};
      if (caps.exposureMode)     adv.exposureMode     = "manual";
      if (caps.whiteBalanceMode) adv.whiteBalanceMode  = "manual";
      if (caps.focusMode)        adv.focusMode         = "manual";
      if (Object.keys(adv).length > 0) {
        await vTrack.applyConstraints({ advanced: [adv] });
        log("rx-log", "Camera locked: manual exposure/WB/focus ✓", "ok");
      }
    } catch (lockErr) {
      log("rx-log", "Camera lock unavailable — auto mode (may cause glitches)", "info");
    }
  } catch (err) {
    log("rx-log", `Camera error: ${err.message}`, "err");
    setSignal("error", "NO CAM");
    updateBanner("error", `CAMERA ERROR: ${err.message}`, "✗");
    return;
  }

  rxVideo.srcObject = rxStream;
  await new Promise(r => rxVideo.onloadedmetadata = r);

  // Size the hidden canvas to match video resolution
  hiddenCanvas.width  = rxVideo.videoWidth  || 640;
  hiddenCanvas.height = rxVideo.videoHeight || 480;

  btnRxStart.classList.add("hidden");
  btnRxStop.classList.remove("hidden");
  setSignal("active", "RX LIVE");
  log("rx-log", `Camera started: ${hiddenCanvas.width}×${hiddenCanvas.height}`, "ok");

  // Reset all state for new session
  rxBitBuffer         = [];
  preambleWindow      = [];
  brightnessBuffer    = [];
  debugBitLog         = [];
  rawBrightnessHistory = [];
  edgeConfirmCounter  = 0;
  bitPeriodSamples    = [];
  scanBitsSinceEdge   = 0;
  fallingEdgeTimer    = 0;

  // Start 60fps brightness sampling loop (for graph & calibration)
  startBrightnessLoop();

  // Run calibration immediately
  await runCalibration();

  // Then switch to scanning
  setRxState("SCANNING");
  startBitSampler();
}

function stopReceiver() {
  if (sampleTimeout) clearTimeout(sampleTimeout);
  samplerLoopActive = false;
  cancelAnimationFrame(rxAnimFrame);
  rxLoopActive = false;

  if (rxStream) {
    rxStream.getTracks().forEach(t => t.stop());
    rxStream = null;
  }
  rxVideo.srcObject = null;
  rxState = "IDLE";
  setRxState("IDLE");
  rxBitBuffer         = [];
  preambleWindow      = [];
  graphData           = [];
  brightnessBuffer    = [];
  debugBitLog         = [];
  rawBrightnessHistory = [];
  edgeConfirmCounter  = 0;
  bitPeriodSamples    = [];
  scanBitsSinceEdge   = 0;
  fallingEdgeTimer    = 0;

  btnRxStart.classList.remove("hidden");
  btnRxStop.classList.add("hidden");
  setSignal("idle", "IDLE");
  updateBanner("idle", "RECEIVER IDLE — PRESS START", "◉");
  log("rx-log", "Receiver stopped.", "info");
}

// ─────────────────────────────────────────────
//  IMAGE PROCESSING — BRIGHTNESS EXTRACTION
// ─────────────────────────────────────────────

/**
 * EXTRACT ROI BRIGHTNESS
 *
 * The "Region of Interest" (ROI) is the centre 50×50 pixel region
 * of the video frame — the area inside the green Target Box.
 *
 * Steps:
 *  1. Draw the current video frame to an off-screen <canvas>.
 *  2. Call getImageData() on just the ROI (not the full frame —
 *     this is much faster at 60fps).
 *  3. Compute the average luminance of all pixels in the ROI.
 *
 * Luminance formula:
 *   Y = 0.299·R + 0.587·G + 0.114·B  (ITU-R BT.601)
 *   This matches human perception better than a simple R+G+B/3 average.
 *
 * @returns {number} Average brightness [0–255]
 */
function extractRoiBrightness() {
  const W = hiddenCanvas.width;
  const H = hiddenCanvas.height;

  // Draw current video frame to hidden canvas
  hiddenCtx.drawImage(rxVideo, 0, 0, W, H);

  // Compute ROI bounds — exactly the centre 50×50 region
  const roiX = Math.floor((W - ROI_SIZE) / 2);
  const roiY = Math.floor((H - ROI_SIZE) / 2);

  // Extract pixel data for just the ROI
  const imageData = hiddenCtx.getImageData(roiX, roiY, ROI_SIZE, ROI_SIZE);
  const pixels    = imageData.data; // Uint8ClampedArray: [R,G,B,A, R,G,B,A, ...]

  let totalLuminance = 0;
  const numPixels = ROI_SIZE * ROI_SIZE;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    // Perceptual luminance — more accurate than simple average
    totalLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
  }

  return totalLuminance / numPixels;
}

// ─────────────────────────────────────────────
//  60 FPS BRIGHTNESS LOOP (Graph + UI updates)
// ─────────────────────────────────────────────

/**
 * This runs at the display frame rate (~60fps) and does TWO things:
 * 1. Updates the live brightness graph
 * 2. Feeds fresh brightness values to the bit sampler
 *
 * NOTE: The bit sampler (setInterval at BIT_RATE_MS) is separate —
 * it reads `currentBrightness` which this loop keeps updated.
 */
let currentBrightness = 0;

function startBrightnessLoop() {
  rxLoopActive = true;

  function loop() {
    if (!rxLoopActive) return;

    if (rxVideo.readyState >= 2) { // HAVE_CURRENT_DATA
      const rawBrightness = extractRoiBrightness();
      currentBrightness = medianFilter(rawBrightness);

      // Update UI stats
      statCurrent.textContent = Math.round(currentBrightness);

      // Accumulate samples for multi-sample voting in bit sampler
      bitPeriodSamples.push(currentBrightness);
      if (bitPeriodSamples.length > 30) bitPeriodSamples.shift();

      // Add to graph history
      graphData.push(currentBrightness);
      if (graphData.length > GRAPH_HISTORY) graphData.shift();

      // Redraw chart
      drawGraph();
    }

    rxAnimFrame = requestAnimationFrame(loop);
  }

  loop();
}

// ─────────────────────────────────────────────
//  CALIBRATION
// ─────────────────────────────────────────────

/**
 * CALIBRATION STEP (IMPROVED)
 *
 * Measures ambient light, computes threshold with noise floor analysis.
 * Also computes the standard deviation of ambient noise to set a
 * smarter HYSTERESIS_BAND.
 */
async function runCalibration() {
  setRxState("CALIBRATING");
  updateBanner("calibrating", "CALIBRATING — KEEP LIGHT AWAY FROM SENSOR...", "⟳");
  log("rx-log", `Calibrating for ${CALIB_DURATION_MS}ms — keep light source away...`, "info");

  const samples = [];
  const start   = Date.now();

  // Sample brightness rapidly during calibration window
  while (Date.now() - start < CALIB_DURATION_MS) {
    if (rxVideo.readyState >= 2) {
      samples.push(extractRoiBrightness());
    }
    await sleep(50); // 20 samples/sec during calibration
  }

  if (samples.length === 0) {
    log("rx-log", "Calibration failed — no samples collected!", "err");
    updateBanner("error", "CALIBRATION FAILED — TRY AGAIN", "✗");
    return;
  }

  // Calculate ambient average
  ambientBaseline = samples.reduce((a, b) => a + b, 0) / samples.length;

  // Calculate noise floor (std deviation) for smarter thresholding
  const variance = samples.reduce((sum, v) => sum + (v - ambientBaseline) ** 2, 0) / samples.length;
  const noiseStdDev = Math.sqrt(variance);

  // Threshold = ambient + max(THRESHOLD_OFFSET, 3×noise_stddev)
  // This ensures threshold is always well above noise floor
  const dynamicOffset = Math.max(THRESHOLD_OFFSET, noiseStdDev * 3);
  threshold = ambientBaseline + dynamicOffset;

  statThreshold.textContent = Math.round(threshold);
  log("rx-log", `Ambient: ${Math.round(ambientBaseline)}, Noise: ±${noiseStdDev.toFixed(1)}, Threshold: ${Math.round(threshold)}`, "ok");
}

// ─────────────────────────────────────────────
//  BIT SAMPLER — STATE MACHINE CORE
// ─────────────────────────────────────────────

/**
 * BIT SAMPLER (OVERHAULED — Falling-edge sync + Multi-sample voting)
 *
 * KEY IMPROVEMENTS:
 *   1. FALLING EDGE SYNC: After detecting a rising edge, we wait for
 *      brightness to DROP below threshold. This precisely identifies the
 *      1→0 transition boundary, giving us an accurate clock reference.
 *      We then center-sample 0.5×BIT_RATE later.
 *   2. MULTI-SAMPLE VOTING: Instead of reading currentBrightness once,
 *      we look at all brightness samples from the 60fps loop collected
 *      during the bit period and majority-vote.
 *   3. HAMMING-TOLERANT PREAMBLE: Allow 1 bit error in preamble matching
 *      (see processBit). This dramatically reduces missed preambles.
 *   4. GRACEFUL SCANNING: On preamble mismatch, keep sampling instead of
 *      immediately resetting to edge polling.
 */

let lastBitValue = "0";  // Track last decided bit for hysteresis

function startBitSampler() {
  samplerLoopActive = true;
  edgeConfirmCounter = 0;
  scanBitsSinceEdge = 0;
  bitPeriodSamples = [];
  if (sampleTimeout) clearTimeout(sampleTimeout);
  pollForEdge();
}

function pollForEdge() {
  if (!samplerLoopActive) return;
  if (rxState === "IDLE" || rxState === "CALIBRATING" || rxState === "COMPLETE") {
     sampleTimeout = setTimeout(pollForEdge, 50);
     return;
  }

  if (rxState === "SCANNING") {
    const isAbove = currentBrightness > threshold + HYSTERESIS_BAND;

    if (isAbove) {
       edgeConfirmCounter++;
       if (edgeConfirmCounter >= EDGE_CONFIRM_COUNT) {
         // CONFIRMED rising edge — sustained bright signal
         edgeConfirmCounter = 0;
         log("rx-log", "Rising edge confirmed. Syncing to bit clock...", "info");
         fallingEdgeTimer = 0;
         waitForFallingEdge();
         return;
       }
       sampleTimeout = setTimeout(pollForEdge, 10);
       return;
    } else {
       edgeConfirmCounter = 0;
       // Slowly drift ambient baseline
       ambientBaseline = EMA_ALPHA * currentBrightness + (1 - EMA_ALPHA) * ambientBaseline;
       threshold       = ambientBaseline + THRESHOLD_OFFSET;
       statThreshold.textContent = Math.round(threshold);
       sampleTimeout = setTimeout(pollForEdge, 10);
       return;
    }
  } else if (rxState === "READING") {
      sampleTimeout = setTimeout(readBitWithVoting, BIT_RATE_MS);
  }
}

/**
 * FALLING EDGE SYNC
 * After detecting a rising edge (first "1" of preamble), wait for
 * brightness to drop below threshold. This precisely identifies the
 * 1→0 transition boundary for accurate clock synchronisation.
 * Then center-sample 0.5×BIT_RATE later for the next bit.
 */
function waitForFallingEdge() {
  if (!samplerLoopActive) return;
  fallingEdgeTimer += 10;

  if (currentBrightness < threshold - HYSTERESIS_BAND) {
    // Found falling edge — we're at the 1→0 boundary
    fallingEdgeTimer = 0;
    preambleWindow = ["1"];
    scanBitsSinceEdge = 1;
    addDebugBit("1", currentBrightness, threshold, 100, "SYNC");
    bitPeriodSamples = []; // Clear for fresh bit-period sampling
    // Wait 0.5 × BIT_RATE to land in center of the "0" bit
    sampleTimeout = setTimeout(readBitWithVoting, Math.floor(BIT_RATE_MS * 0.5));
    return;
  }

  // Timeout: if brightness doesn't drop after 3 bit periods, reset
  if (fallingEdgeTimer >= BIT_RATE_MS * 3) {
    fallingEdgeTimer = 0;
    log("rx-log", "Falling edge timeout — light stayed on. Resetting scan...", "info");
    edgeConfirmCounter = 0;
    pollForEdge();
    return;
  }

  sampleTimeout = setTimeout(waitForFallingEdge, 10);
}

/**
 * READ BIT WITH VOTING
 * Uses multi-sample majority voting from the 60fps brightness loop.
 * Instead of reading a single currentBrightness value, it looks at
 * all brightness samples collected during the bit period and votes.
 * This is dramatically more robust against noise, camera glitches,
 * and sampling at bit-transition edges.
 */
function readBitWithVoting() {
  if (!samplerLoopActive) return;
  if (rxState === "COMPLETE" || rxState === "IDLE" || rxState === "CALIBRATING") {
    pollForEdge();
    return;
  }

  // Multi-sample voting: use recent brightness readings from 60fps loop
  const samplesToUse = Math.min(bitPeriodSamples.length, 12);
  let bit, confidence;

  if (samplesToUse >= 3) {
    const recent = bitPeriodSamples.slice(-samplesToUse);
    const aboveCount = recent.filter(v => v > threshold).length;
    bit = aboveCount > samplesToUse / 2 ? "1" : "0";
    confidence = Math.round(Math.max(aboveCount, samplesToUse - aboveCount) / samplesToUse * 100);
  } else {
    // Not enough samples — fall back to single reading with hysteresis
    const dist = currentBrightness - threshold;
    bit = Math.abs(dist) < HYSTERESIS_BAND ? lastBitValue : (dist > 0 ? "1" : "0");
    confidence = Math.min(100, Math.round(Math.abs(dist) / THRESHOLD_OFFSET * 100));
  }

  lastBitValue = bit;
  lastBitConfidence = confidence;
  statConfidence.textContent = confidence + "%";
  bitPeriodSamples = []; // Clear for next bit period

  addDebugBit(bit, currentBrightness, threshold, confidence, rxState);
  processBit(bit);

  // Scanning guard: reset to edge polling after too many bits without preamble
  if (rxState === "SCANNING") {
    scanBitsSinceEdge++;
    if (scanBitsSinceEdge > MAX_SCAN_BITS) {
      log("rx-log", `No preamble after ${MAX_SCAN_BITS} bits. Resetting edge scan...`, "info");
      preambleWindow = [];
      scanBitsSinceEdge = 0;
      edgeConfirmCounter = 0;
      pollForEdge();
      return;
    }
  }

  // Reading guards
  if (rxState === "READING") {
    const elapsed = Date.now() - readingStartTime;
    if (elapsed > READING_TIMEOUT_MS) {
      log("rx-log", "TIMEOUT: Reading exceeded 60s limit. Forcing decode.", "err");
      forceDecodeAndStop("TIMEOUT — PARTIAL DECODE");
      return;
    }
    if (rxBitBuffer.length >= MAX_PAYLOAD_BITS) {
      log("rx-log", `MAX BITS: ${MAX_PAYLOAD_BITS} bits received. Forcing decode.`, "err");
      forceDecodeAndStop("MAX BITS — PARTIAL DECODE");
      return;
    }
  }

  if (rxState === "COMPLETE" || rxState === "IDLE") {
    pollForEdge();
    return;
  }

  sampleTimeout = setTimeout(readBitWithVoting, BIT_RATE_MS);
}

/**
 * FORCE DECODE AND STOP
 * Called when timeout/max-bits is exceeded during READING.
 * Attempts to decode whatever we have.
 */
function forceDecodeAndStop(reason) {
  if (sampleTimeout) clearTimeout(sampleTimeout);
  samplerLoopActive = false;

  const payloadBits = rxBitBuffer.join("");
  if (payloadBits.length >= BITS_PER_CHAR) {
    log("rx-log", `${reason}: Decoding ${payloadBits.length} bits`, "err");
    decodePayload(payloadBits);
    renderDebugLog();
  } else {
    log("rx-log", `${reason}: Not enough bits to decode (${payloadBits.length})`, "err");
  }

  setRxState("COMPLETE");
  updateBanner("error", `${reason} — ${rxBitBuffer.length} BITS RECEIVED`, "⚠");
  rxBitBuffer    = [];
  preambleWindow = [];
  reticleBox.classList.remove("locked");
}

/**
 * PROCESS BIT — State Machine (IMPROVED)
 *
 * - SCANNING: Rolling preamble detection with visual feedback
 * - READING: Payload accumulation with live char-by-char decoding,
 *            postamble detection with auto-stop
 *
 * @param {string} bit - "0" or "1"
 */
function processBit(bit) {
  statBitsEl.textContent = rxBitBuffer.length;

  // Maintain rolling preamble window (last N bits)
  preambleWindow.push(bit);
  if (preambleWindow.length > PREAMBLE.length) {
    preambleWindow.shift();
  }

  // ── STATE: SCANNING ──
  if (rxState === "SCANNING") {
    updateBitBufferUI([...preambleWindow], "preamble");
    updateBanner("scanning", `SCANNING FOR PREAMBLE... [${preambleWindow.join("")}]`, "◎");

    const windowStr = preambleWindow.join("");
    const hd = hammingDistance(windowStr, PREAMBLE);
    if (hd <= PREAMBLE_TOLERANCE) {
      // ✓ Preamble detected (Hamming distance ≤ tolerance)! Transition to READING state.
      log("rx-log", `★ PREAMBLE DETECTED [${windowStr}] (HD=${hd}) — Now reading data...`, "ok");
      setRxState("READING");
      rxBitBuffer    = [];  // Clear buffer — ready to collect payload
      preambleWindow = [];  // Reset preamble window
      readingStartTime = Date.now(); // Start timeout clock
      reticleBox.classList.add("locked");

      // Reset live decode
      liveDecode.innerHTML = '<span class="cursor-blink"></span>';
      liveCharsCount.textContent = "0 chars";
      liveBitsProgress.textContent = `next char: 0/${BITS_PER_CHAR} bits`;
      decodedOutput.innerHTML = '<span class="dim">Receiving data...</span>';
      updateBanner("reading", "★ PREAMBLE FOUND — RECEIVING DATA...", "⬤");
    }
    return;
  }

  // ── STATE: READING ──
  if (rxState === "READING") {
    rxBitBuffer.push(bit);
    statBitsEl.textContent = rxBitBuffer.length;
    updateBitBufferUI(rxBitBuffer, "data");

    // ── Live character-by-character decoding ──
    updateLiveDecode();

    // Update banner with progress
    const charsDone = Math.floor(rxBitBuffer.length / BITS_PER_CHAR);
    const bitsIntoChar = rxBitBuffer.length % BITS_PER_CHAR;
    updateBanner("reading",
      `RECEIVING DATA — ${rxBitBuffer.length} bits (${charsDone} chars decoded)`,
      "⬤");

    // ── Check last 6 bits for postamble ──
    // Only check if doing so leaves a payload that is an exact multiple of BITS_PER_CHAR bits!
    if (rxBitBuffer.length >= POSTAMBLE.length && ((rxBitBuffer.length - POSTAMBLE.length) % BITS_PER_CHAR === 0)) {
      const tail = rxBitBuffer.slice(-POSTAMBLE.length).join("");

      if (tail === POSTAMBLE) {
        // ✓ Postamble detected! Strip it and decode the payload.
        if (sampleTimeout) clearTimeout(sampleTimeout); // STOP sampling immediately
        samplerLoopActive = false;

        const payloadBits = rxBitBuffer
          .slice(0, rxBitBuffer.length - POSTAMBLE.length)
          .join("");

        log("rx-log", `★ POSTAMBLE DETECTED [${POSTAMBLE}] — Payload: ${payloadBits.length} bits`, "ok");
        decodePayload(payloadBits);
        renderDebugLog();

        // ── AUTO-STOP: Go to COMPLETE state ──
        setRxState("COMPLETE");
        reticleBox.classList.remove("locked");

        // Reset buffers
        rxBitBuffer    = [];
        preambleWindow = [];

        log("rx-log", "✓ Transmission complete. Receiver auto-stopped.", "ok");
        log("rx-log", "Press START to receive another message.", "info");
      }
    }
    return;
  }
}

/**
 * LIVE DECODE (TRIPLE REDUNDANCY)
 * Shows characters as they are decoded in real-time, BITS_PER_CHAR (24) bits at a time.
 * Each character is sent as 3×8 bits. We majority-vote the three copies.
 */
function updateLiveDecode() {
  const totalBits = rxBitBuffer.length;
  const fullChars = Math.floor(totalBits / BITS_PER_CHAR);
  const remainingBits = totalBits % BITS_PER_CHAR;

  let dbgHTML = "";
  for (let i = 0; i < fullChars; i++) {
    const offset = i * BITS_PER_CHAR;
    const b1 = rxBitBuffer.slice(offset, offset + 8).join("");
    const b2 = rxBitBuffer.slice(offset + 8, offset + 16).join("");
    const b3 = rxBitBuffer.slice(offset + 16, offset + 24).join("");

    let char = "?";
    let status = "✓";
    let statusColor = "var(--green)";

    if (b1 === b2 && b2 === b3) {
      // All three agree — perfect
      const code = parseInt(b1, 2);
      char = (code >= 32 && code <= 126) ? String.fromCharCode(code) : "·";
      status = "✓";
      statusColor = "var(--green)";
    } else if (b1 === b2 || b1 === b3) {
      // b1 wins majority
      const code = parseInt(b1, 2);
      char = (code >= 32 && code <= 126) ? String.fromCharCode(code) : "·";
      status = "⚠ corrected";
      statusColor = "var(--amber)";
    } else if (b2 === b3) {
      // b2/b3 majority
      const code = parseInt(b2, 2);
      char = (code >= 32 && code <= 126) ? String.fromCharCode(code) : "·";
      status = "⚠ corrected";
      statusColor = "var(--amber)";
    } else {
      // All different — use b2 (middle copy)
      const code = parseInt(b2, 2);
      char = (code >= 32 && code <= 126) ? String.fromCharCode(code) : "·";
      status = "✗ all differ";
      statusColor = "var(--red)";
    }

    const displayChar = char === '~' ? 'SPACE(~)' : (char === ' ' ? 'SPACE' : char);
    dbgHTML += `<div style="font-size:11px; margin-bottom: 2px;">` +
      `<code><span style="color:var(--amber);">${b1}</span> ` +
      `<span style="color:var(--amber-dim);">${b2}</span> ` +
      `<span style="color:var(--text-dim);">${b3}</span></code> ` +
      `<span style="color:${statusColor}; font-size:10px;">${status}</span> ` +
      `<span style="color:var(--text-dim);">→</span> ` +
      `<strong style="color:var(--cyan);">${displayChar}</strong></div>`;
  }

  if (remainingBits > 0) {
    const rem = rxBitBuffer.slice(fullChars * BITS_PER_CHAR).join("");
    dbgHTML += `<div style="font-size:11px; margin-bottom: 2px; color: var(--text-dim);"><code>${rem}...</code> (${remainingBits}/${BITS_PER_CHAR})</div>`;
  }

  liveDecode.innerHTML = (dbgHTML || "") + '<span class="cursor-blink"></span>';
  liveCharsCount.textContent = fullChars + " chars";
  liveBitsProgress.textContent = `next char: ${remainingBits}/${BITS_PER_CHAR} bits`;
}

/**
 * DECODE PAYLOAD (TRIPLE REDUNDANCY)
 * Convert the received binary payload back to ASCII text.
 * binaryToText now returns { error, corrected, message, details }.
 *
 * @param {string} bits - binary string of the payload (no preamble/postamble)
 */
function decodePayload(bits) {
  const decoded = binaryToText(bits);
  
  // Restore spaces from wire encoding (~ was used as space substitute during TX)
  const rawText = decoded.message;
  const text = rawText.replace(/~/g, ' ');
  
  if (decoded.error) {
    const corrMsg = decoded.corrected > 0 ? ` (${decoded.corrected} corrected via voting)` : "";
    log("rx-log", `⚠ Decoded with ${decoded.details.length} conflict(s)${corrMsg}: "${text}"`, "err");
    decoded.details.forEach(detail => log("rx-log", `  - ${detail}`, "err"));
    if (rawText !== text) log("rx-log", `Wire: "${rawText}" → "${text}" (~ → space)`, "info");
    
    // Show recovered text with conflict warning (best-effort decode)
    decodedOutput.innerHTML = `<div>${escapeHtml(text)}</div><div style="color:var(--amber); font-size:11px; margin-top:6px;">⚠ ${decoded.details.length} conflict(s), ${decoded.corrected} corrected via triple voting</div>`;
    decodedOutput.classList.add("flash");
    setTimeout(() => decodedOutput.classList.remove("flash"), 2000);
    
    setSignal("busy", "RX WARN");
    updateBanner("done", `⚠ RECEIVED WITH ERRORS: "${text.length > 30 ? text.slice(0,30) + '…' : text}"`, "⚠");
    
    messageCount++;
    addToMessageHistory(text + " ⚠");
    renderDebugLog();
    return;
  }
  
  if (rawText !== text) log("rx-log", `Wire: "${rawText}" → "${text}" (~ → space)`, "info");
  const corrMsg = decoded.corrected > 0 ? ` — ${decoded.corrected} char(s) corrected via triple voting` : "";
  log("rx-log", `✓ Decoded: "${text}" (${bits.length} bits → ${text.length} chars)${corrMsg}`, "ok");

  // Update main decoded output
  decodedOutput.textContent = text;
  decodedOutput.classList.add("flash");
  setTimeout(() => decodedOutput.classList.remove("flash"), 2000);

  // Update live decode (final)
  liveDecode.innerHTML = escapeHtml(text);

  // Update signal
  setSignal("active", "MSG RX ✓");

  // Update banner to COMPLETE
  updateBanner("complete", `✓ MESSAGE RECEIVED: "${text.length > 40 ? text.slice(0,40) + '…' : text}"`, "✓");

  // ── Add to message history ──
  messageCount++;
  addToMessageHistory(text);
}

/**
 * ADD TO MESSAGE HISTORY
 * Appends a received message to the scrollable history panel.
 */
function addToMessageHistory(text) {
  // Clear the "no messages" placeholder on first message
  if (messageCount === 1) {
    messageHistory.innerHTML = "";
  }

  const entry = document.createElement("div");
  entry.className = "msg-history-entry";

  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;

  entry.innerHTML = `
    <span class="msg-num">#${messageCount}</span>
    <span class="msg-text">${escapeHtml(text)}</span>
    <span class="msg-time">${ts}</span>
  `;

  messageHistory.appendChild(entry);
  messageHistory.scrollTop = messageHistory.scrollHeight;
}

/** Escape HTML entities for safe display */
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ─────────────────────────────────────────────
//  UI UPDATE HELPERS — RECEIVER
// ─────────────────────────────────────────────

/** Transition the receiver state machine and update all related UI */
function setRxState(newState) {
  rxState = newState;
  rxStateBadge.className = "rx-state-badge " + newState.toLowerCase();
  rxStateBadge.textContent = newState;
  statStatEl.textContent   = newState;

  reticleBox.classList.remove("scanning", "locked");
  if (newState === "SCANNING") reticleBox.classList.add("scanning");
  if (newState === "READING")  reticleBox.classList.add("locked");

  // Update banner for states that don't have custom banner updates
  if (newState === "SCANNING") {
    updateBanner("scanning", "SCANNING FOR PREAMBLE PATTERN [101011]...", "◎");
  } else if (newState === "IDLE") {
    updateBanner("idle", "RECEIVER IDLE — PRESS START", "◉");
  } else if (newState === "CALIBRATING") {
    updateBanner("calibrating", "CALIBRATING — MEASURING AMBIENT LIGHT...", "⟳");
  } else if (newState === "DONE") {
    updateBanner("done", "MESSAGE DECODED — PROCESSING...", "✓");
  } else if (newState === "COMPLETE") {
    // Banner is set by decodePayload / forceDecodeAndStop
    // Update button states: hide STOP, show START
    btnRxStop.classList.add("hidden");
    btnRxStart.classList.remove("hidden");
    btnRxStart.textContent = "START RECEIVER";
  }
}

/** Render the bit buffer with coloured 0/1 spans */
function updateBitBufferUI(bits, mode) {
  if (!bits.length) {
    bitBufferEl.innerHTML = '<span class="dim">—</span>';
    return;
  }
  bitBufferEl.innerHTML = bits.map((b, i) => {
    let cls = b === "1" ? "b1" : "b0";
    if (mode === "preamble") cls = "preamble-bit";
    return `<span class="${cls}">${b}</span>`;
  }).join("");
}

// ─────────────────────────────────────────────
//  LIVE BRIGHTNESS GRAPH
// ─────────────────────────────────────────────

/**
 * DRAW GRAPH
 *
 * Renders a scrolling line chart of brightness samples.
 * Also draws:
 *  - A horizontal amber dashed line for the current threshold
 *  - Colour-coded signal region fill (green when above threshold)
 *
 * This gives the user an immediate visual readout of whether
 * the light flashes are registering and whether the threshold
 * is well-positioned between noise floor and signal peak.
 */
function drawGraph() {
  const W = graphCanvas.width;
  const H = graphCanvas.height;
  const data = graphData;

  graphCtx.clearRect(0, 0, W, H);

  // Background
  graphCtx.fillStyle = "#0d1117";
  graphCtx.fillRect(0, 0, W, H);

  if (data.length < 2) return;

  const xStep = W / (GRAPH_HISTORY - 1);

  // ── Threshold line ──
  const threshY = H - (threshold / 255) * H;
  graphCtx.setLineDash([4, 4]);
  graphCtx.strokeStyle = "rgba(245,166,35,0.5)";
  graphCtx.lineWidth = 1;
  graphCtx.beginPath();
  graphCtx.moveTo(0, threshY);
  graphCtx.lineTo(W, threshY);
  graphCtx.stroke();
  graphCtx.setLineDash([]);

  // Threshold label
  graphCtx.fillStyle = "rgba(245,166,35,0.6)";
  graphCtx.font = "9px 'Share Tech Mono'";
  graphCtx.fillText(`T=${Math.round(threshold)}`, 4, threshY - 3);

  // ── Signal fill (area under curve, colour-coded) ──
  graphCtx.beginPath();
  graphCtx.moveTo(0, H);
  for (let i = 0; i < data.length; i++) {
    const x = i * xStep;
    const y = H - (data[i] / 255) * H;
    if (i === 0) graphCtx.lineTo(x, y);
    else graphCtx.lineTo(x, y);
  }
  graphCtx.lineTo((data.length - 1) * xStep, H);
  graphCtx.closePath();

  // Green above threshold, dim below
  const grad = graphCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(57,255,20,0.25)");
  grad.addColorStop(threshold / 255, "rgba(57,255,20,0.08)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  graphCtx.fillStyle = grad;
  graphCtx.fill();

  // ── Signal line ──
  graphCtx.beginPath();
  graphCtx.lineWidth = 1.5;
  graphCtx.strokeStyle = "rgba(57,255,20,0.9)";
  for (let i = 0; i < data.length; i++) {
    const x = i * xStep;
    const y = H - (data[i] / 255) * H;
    if (i === 0) graphCtx.moveTo(x, y);
    else graphCtx.lineTo(x, y);
  }
  graphCtx.stroke();

  // ── Current value dot ──
  const lastVal = data[data.length - 1];
  const dotX = (data.length - 1) * xStep;
  const dotY = H - (lastVal / 255) * H;
  graphCtx.beginPath();
  graphCtx.arc(dotX, dotY, 3, 0, Math.PI * 2);
  graphCtx.fillStyle = lastVal > threshold ? "var(--green)" : "rgba(57,255,20,0.4)";
  graphCtx.shadowColor = "rgba(57,255,20,0.8)";
  graphCtx.shadowBlur  = lastVal > threshold ? 8 : 0;
  graphCtx.fill();
  graphCtx.shadowBlur = 0;
}

// ─────────────────────────────────────────────
//  DEBUG BITSTREAM LOG
// ─────────────────────────────────────────────

/** Record a bit decision with full metadata for the debug panel */
function addDebugBit(bit, brightness, thresh, confidence, state) {
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}.${String(now.getMilliseconds()).padStart(3,"0")}`;
  debugBitLog.push({ ts, bit, brightness: Math.round(brightness), threshold: Math.round(thresh), confidence, state });
}

/** Render the debug bitstream panel with full analysis */
function renderDebugLog() {
  const container = document.getElementById("debug-log-content");
  if (!container) return;

  if (debugBitLog.length === 0) {
    container.innerHTML = '<div class="dim">No bits received yet.</div>';
    return;
  }

  let html = '<div class="debug-section-title">RAW BITSTREAM (' + debugBitLog.length + ' bits)</div>';
  html += '<div class="debug-bitstream">';
  debugBitLog.forEach(e => {
    html += `<span class="debug-bit ${e.bit === '1' ? 'db1' : 'db0'}" title="B:${e.brightness} T:${e.threshold} C:${e.confidence}%">${e.bit}</span>`;
  });
  html += '</div>';

  // Character breakdown — BITS_PER_CHAR (24-bit) blocks from READING-state bits only
  // Each character = 3 × 8-bit copies: COPY A, COPY B, COPY C
  const payloadBits = debugBitLog.filter(e => e.state === "READING").map(e => e.bit);
  if (payloadBits.length >= 8) {
    html += '<div class="debug-section-title" style="margin-top:12px">CHARACTER BREAKDOWN (3×8-bit triple redundancy)</div>';
    html += '<div class="debug-chars">';
    const charCount = Math.floor(payloadBits.length / BITS_PER_CHAR);
    for (let c = 0; c < charCount; c++) {
      const offset = c * BITS_PER_CHAR;
      const copyA = payloadBits.slice(offset, offset + 8).join("");
      const copyB = payloadBits.slice(offset + 8, offset + 16).join("");
      const copyC = payloadBits.slice(offset + 16, offset + 24).join("");

      let votedByte, voteLabel, voteClass;
      if (copyA === copyB && copyB === copyC) {
        votedByte = copyA; voteLabel = "PERFECT"; voteClass = "vote-ok";
      } else if (copyA === copyB || copyA === copyC) {
        votedByte = copyA; voteLabel = "CORRECTED"; voteClass = "vote-fix";
      } else if (copyB === copyC) {
        votedByte = copyB; voteLabel = "CORRECTED"; voteClass = "vote-fix";
      } else {
        votedByte = copyB; voteLabel = "ALL DIFFER"; voteClass = "vote-err";
      }

      const charCode = parseInt(votedByte, 2);
      let ch = "\u00B7";
      if (charCode >= 32 && charCode <= 126) ch = String.fromCharCode(charCode);
      const displayCh = (ch === "~") ? "~ (SPACE)" : ch;
      const charNum = c + 1;

      html += `<div class="debug-char-entry" style="margin-bottom:6px; border-left:2px solid var(--border); padding-left:6px;">` +
        `<div><span class="debug-block-num">CHAR #${charNum}</span> → ` +
        `<strong class="debug-char" style="font-size:14px;">${escapeHtml(displayCh)}</strong> ` +
        `<span class="debug-charcode">(0x${charCode.toString(16).toUpperCase().padStart(2,"0")})</span> ` +
        `<span class="${voteClass}" style="font-size:10px; padding:1px 4px; border-radius:3px;">${voteLabel}</span></div>` +
        `<div style="font-size:10px; margin-top:2px;">` +
        `<span style="color:var(--amber);">A: ${copyA}</span>  ` +
        `<span style="color:var(--amber-dim);">B: ${copyB}</span>  ` +
        `<span style="color:var(--text-dim);">C: ${copyC}</span></div>` +
        `</div>`;
    }

    // Show remaining partial bits
    const remaining = payloadBits.length - charCount * BITS_PER_CHAR;
    if (remaining > 0) {
      const rem = payloadBits.slice(charCount * BITS_PER_CHAR).join("");
      html += `<div class="debug-char-entry"><code class="debug-bits-partial">${rem}... (${remaining}/${BITS_PER_CHAR})</code></div>`;
    }
    html += '</div>';
  }

  // Detailed per-bit log table
  html += '<div class="debug-section-title" style="margin-top:12px">DETAILED BIT LOG</div>';
  html += '<div class="debug-table">';
  html += '<div class="debug-row header"><span>TIME</span><span>BIT</span><span>BRIGHT</span><span>THRESH</span><span>CONF</span><span>STATE</span></div>';
  debugBitLog.forEach(e => {
    html += `<div class="debug-row"><span>${e.ts}</span><span class="${e.bit === '1' ? 'db1' : 'db0'}">${e.bit}</span><span>${e.brightness}</span><span>${e.threshold}</span><span>${e.confidence}%</span><span>${e.state}</span></div>`;
  });
  html += '</div>';

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
}

// Debug panel toggle
document.getElementById("btn-debug-toggle")?.addEventListener("click", () => {
  const section = document.getElementById("debug-log-section");
  const btn = document.getElementById("btn-debug-toggle");
  if (!section || !btn) return;
  if (section.classList.contains("hidden")) {
    section.classList.remove("hidden");
    btn.textContent = "HIDE";
    renderDebugLog();
  } else {
    section.classList.add("hidden");
    btn.textContent = "SHOW";
  }
});
