/**
 * ============================================================
 * LI-FI OWC TERMINAL — script.js
 * Optical Wireless Communication via On-Off Keying (OOK)
 * ============================================================
 */

"use strict";

// ─────────────────────────────────────────────
//  PROTOCOL CONSTANTS
// ─────────────────────────────────────────────
const BIT_RATE_MS        = 300;     // milliseconds per bit
const PREAMBLE           = "101011";
const POSTAMBLE          = "00000011"; // 8-bit ETX (End of Text) byte
const THRESHOLD_OFFSET   = 30;      // brightness units above ambient to call a "1"
const CALIB_DURATION_MS  = 2000;    // how long to measure ambient during calibration
const ROI_SIZE           = 50;      // pixels — size of the "Target Box" sample region
const GRAPH_HISTORY      = 120;     // number of brightness samples to show on chart
const EMA_ALPHA          = 0.02;    // exponential moving average coefficient for slow ambient drift

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

/** Convert a string to its ASCII binary representation.
 * Each character → 8-bit padded binary string.
 */
function textToBinary(text) {
  return text.split("").map(ch =>
    ch.charCodeAt(0).toString(2).padStart(8, "0")
  ).join("");
}

/** Convert a binary string back to ASCII text.
 * Processes 8 bits at a time with error handling.
 */
function binaryToText(binary) {
  if (!binary || binary.length === 0) return "";
  
  // Trim to a multiple of 8
  const trimmed = binary.slice(0, Math.floor(binary.length / 8) * 8);
  let result = "";
  
  for (let i = 0; i < trimmed.length; i += 8) {
    const byte = trimmed.slice(i, i + 8);
    if (byte.length !== 8) break;
    
    const charCode = parseInt(byte, 2);
    
    // Accept printable ASCII (32-126) and common control chars
    if ((charCode >= 32 && charCode <= 126) || [9, 10, 13].includes(charCode)) {
      result += String.fromCharCode(charCode);
    } else if (charCode === 0) {
      // Stop at null terminator
      break;
    } else {
      // Skip non-printable characters
      result += "";
    }
  }
  
  return result;
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

let txActive     = false;   
let torchStream  = null;    
let torchTrack   = null;    
let useTorch     = false;   

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

  const binary = textToBinary(text);

  binaryDisplay.innerHTML = binary.split("").map(b =>
    `<span class="bit-${b}">${b}</span>`
  ).join("");

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

  await initTorch();

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
  setLight(false);  
  setIndicatorState("STANDBY", false);
  setSignal("idle", "IDLE");
  log("tx-log", "Transmission complete.", "ok");

  if (torchTrack) {
    torchTrack.stop();
    torchTrack = null;
    torchStream = null;
  }
});

async function initTorch() {
  try {
    torchStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    });
    torchTrack = torchStream.getVideoTracks()[0];

    const capabilities = torchTrack.getCapabilities();
    if (capabilities.torch) {
      useTorch = true;
      log("tx-log", "Hardware torch detected ✓", "ok");
    } else {
      useTorch = false;
      log("tx-log", "Torch not supported → screen fallback", "info");
      torchTrack.stop(); 
      torchStream = null;
      torchTrack  = null;
    }
  } catch (err) {
    useTorch = false;
    log("tx-log", `Camera unavailable: ${err.message} → screen fallback`, "err");
  }
}

async function setLight(on) {
  if (useTorch && torchTrack) {
    try {
      await torchTrack.applyConstraints({ advanced: [{ torch: on }] });
    } catch (e) {}
  } else {
    screenFlash.classList.remove("hidden", "on", "off");
    screenFlash.classList.add(on ? "on" : "off");
  }
}

async function transmitFrame(frame) {
  const total = frame.length;

  for (let i = 0; i < total; i++) {
    const bit = frame[i];
    const isOn = bit === "1";

    await setLight(isOn);
    setIndicatorState(isOn ? "1 — LIGHT ON" : "0 — LIGHT OFF", isOn);

    const pct = Math.round(((i + 1) / total) * 100);
    progressFill.style.width = pct + "%";
    progressBit.textContent  = `BIT ${i + 1}/${total}`;
    progressPct.textContent  = pct + "%";

    await sleep(BIT_RATE_MS);
  }
}

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

let rxState          = "IDLE";
let rxStream         = null;    
let rxAnimFrame      = null;    
let threshold        = 128;     
let ambientBaseline  = 0;       
let rxBitBuffer      = [];      
let rxBitMetaBuffer  = [];      
let preambleWindow   = [];      
let graphData        = [];      
let brightnessHistory = [];     
let rxLoopActive     = false;   
let sampleInterval   = null;    
let messageCount     = 0;       
let readingStartTime = 0;       
let lastBitConfidence = 0;      
let lastBitValue     = "0";
let bitTickIndex     = 0;
let readingClockLocked = false;
let lastDecisionMeta = null;
let lastPostambleStatus = "—";

let dbgFrameCounter = 0;
const DEBUG_MAX_EVENTS = 220;

const MAX_PAYLOAD_BITS    = 1200;   
const READING_TIMEOUT_MS  = 60000;  
const HYSTERESIS_BAND     = 8;      
const SAMPLE_WINDOW_MS    = Math.round(BIT_RATE_MS * 0.7);
const BRIGHTNESS_HISTORY_LIMIT = 500;
const POSTAMBLE_MIN_PAYLOAD_BITS = 8;
const POSTAMBLE_MIN_CONFIDENCE = 35;
const PREAMBLE_MAX_HAMMING = 1;

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

const btnDebugClear = document.getElementById("btn-debug-clear");
const dbgEventsEl = document.getElementById("dbg-events");
const dbgRxStateEl = document.getElementById("dbg-rx-state");
const dbgBaselineEl = document.getElementById("dbg-baseline");
const dbgThresholdEl = document.getElementById("dbg-threshold");
const dbgCurrentEl = document.getElementById("dbg-current");
const dbgAvgEl = document.getElementById("dbg-avg");
const dbgStdEl = document.getElementById("dbg-std");
const dbgDistEl = document.getElementById("dbg-dist");
const dbgBitEl = document.getElementById("dbg-bit");
const dbgConfEl = document.getElementById("dbg-conf");
const dbgSamplesEl = document.getElementById("dbg-samples");
const dbgPreambleEl = document.getElementById("dbg-preamble");
const dbgBufferLenEl = document.getElementById("dbg-buffer-len");
const dbgLastByteEl = document.getElementById("dbg-last-byte");
const dbgPostambleEl = document.getElementById("dbg-postamble");
const dbgPreambleWindowEl = document.getElementById("dbg-preamble-window");
const dbgBufferTailEl = document.getElementById("dbg-buffer-tail");
const dbgLastDecisionEl = document.getElementById("dbg-last-decision");

const graphCtx = graphCanvas.getContext("2d");
const hiddenCtx = hiddenCanvas.getContext("2d", { willReadFrequently: true });

function resizeGraphCanvas() {
  const rect = graphCanvas.getBoundingClientRect();
  graphCanvas.width  = rect.width  || 400;
  graphCanvas.height = rect.height || 120;
}
window.addEventListener("resize", resizeGraphCanvas);
resizeGraphCanvas();

function updateBanner(state, text, icon) {
  rxBanner.className = "rx-status-banner " + state;
  rxBannerText.textContent = text;
  if (icon) rxBannerIcon.textContent = icon;
}

function debugTrace(message, type = "info") {
  if (!dbgEventsEl) return;
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  const now = new Date();
  const ts = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;
  entry.textContent = `[${ts}] ${message}`;
  dbgEventsEl.appendChild(entry);
  while (dbgEventsEl.children.length > DEBUG_MAX_EVENTS) {
    dbgEventsEl.removeChild(dbgEventsEl.firstChild);
  }
  dbgEventsEl.scrollTop = dbgEventsEl.scrollHeight;
}

function updateDebugPanel() {
  if (!dbgRxStateEl) return;

  const decision = lastDecisionMeta || {};
  const joinedBuffer = rxBitBuffer.join("");
  const lastByte = joinedBuffer.length >= 8 ? joinedBuffer.slice(-8) : "—";
  const tail = joinedBuffer.length > 64 ? joinedBuffer.slice(-64) : joinedBuffer || "—";

  dbgRxStateEl.textContent = rxState + (readingClockLocked ? " (LOCK)" : "");
  dbgBaselineEl.textContent = Number.isFinite(ambientBaseline) ? ambientBaseline.toFixed(1) : "—";
  dbgThresholdEl.textContent = Number.isFinite(threshold) ? threshold.toFixed(1) : "—";
  dbgCurrentEl.textContent = Number.isFinite(currentBrightness) ? currentBrightness.toFixed(1) : "—";
  dbgAvgEl.textContent = Number.isFinite(decision.avgBrightness) ? decision.avgBrightness.toFixed(1) : "—";
  dbgStdEl.textContent = Number.isFinite(decision.stdDev) ? decision.stdDev.toFixed(2) : "—";
  dbgDistEl.textContent = Number.isFinite(decision.distance) ? decision.distance.toFixed(1) : "—";
  dbgBitEl.textContent = decision.bit ?? "—";
  dbgConfEl.textContent = Number.isFinite(decision.confidence) ? `${decision.confidence}%` : "—";
  dbgSamplesEl.textContent = String(decision.sampleCount ?? 0);
  dbgPreambleEl.textContent = preambleWindow.join("") || "—";
  dbgBufferLenEl.textContent = String(rxBitBuffer.length);
  dbgLastByteEl.textContent = lastByte;
  dbgPostambleEl.textContent = lastPostambleStatus;

  dbgPreambleWindowEl.textContent = preambleWindow.join(" ") || "—";
  dbgBufferTailEl.textContent = tail;
  dbgLastDecisionEl.textContent = JSON.stringify({
    bitTickIndex,
    bit: decision.bit,
    confidence: decision.confidence,
    avgBrightness: Number.isFinite(decision.avgBrightness) ? Number(decision.avgBrightness.toFixed(2)) : null,
    stdDev: Number.isFinite(decision.stdDev) ? Number(decision.stdDev.toFixed(3)) : null,
    distance: Number.isFinite(decision.distance) ? Number(decision.distance.toFixed(2)) : null,
    sampleCount: decision.sampleCount,
  }, null, 2);
}

if (btnDebugClear) {
  btnDebugClear.addEventListener("click", () => {
    if (!dbgEventsEl) return;
    dbgEventsEl.innerHTML = '<div class="log-entry dim">Debug trace cleared.</div>';
  });
}

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
  debugTrace("RX start requested", "info");
  updateBanner("calibrating", "STARTING CAMERA...", "⟳");

  try {
    rxStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: "environment",  
        width:  { ideal: 1280 },
        height: { ideal: 720 },
        // Attempt to lock exposure and white balance
        advanced: [
          { exposureMode: "manual" },
          { whiteBalanceMode: "manual" }
        ]
      }
    });
  } catch (err) {
    log("rx-log", `Camera error: ${err.message}`, "err");
    setSignal("error", "NO CAM");
    updateBanner("error", `CAMERA ERROR: ${err.message}`, "✗");
    return;
  }

  rxVideo.srcObject = rxStream;
  await new Promise(r => rxVideo.onloadedmetadata = r);

  hiddenCanvas.width  = rxVideo.videoWidth  || 640;
  hiddenCanvas.height = rxVideo.videoHeight || 480;

  btnRxStart.classList.add("hidden");
  btnRxStop.classList.remove("hidden");
  setSignal("active", "RX LIVE");
  log("rx-log", `Camera started: ${hiddenCanvas.width}×${hiddenCanvas.height}`, "ok");

  rxBitBuffer    = [];
  rxBitMetaBuffer = [];
  preambleWindow = [];
  graphData = [];
  brightnessHistory = [];
  readingClockLocked = false;
  bitTickIndex = 0;
  lastBitValue = "0";
  lastDecisionMeta = null;
  lastPostambleStatus = "—";
  updateDebugPanel();

  startBrightnessLoop();
  await runCalibration();

  setRxState("SCANNING");
  startBitSampler(false);
  debugTrace("Bit sampler started in SCANNING mode", "ok");
}

function stopReceiver() {
  clearInterval(sampleInterval);
  cancelAnimationFrame(rxAnimFrame);
  rxLoopActive = false;

  if (rxStream) {
    rxStream.getTracks().forEach(t => t.stop());
    rxStream = null;
  }
  rxVideo.srcObject = null;
  rxState = "IDLE";
  setRxState("IDLE");
  rxBitBuffer    = [];
  rxBitMetaBuffer = [];
  preambleWindow = [];
  graphData      = [];
  brightnessHistory = [];
  readingClockLocked = false;
  lastDecisionMeta = null;
  lastPostambleStatus = "—";

  btnRxStart.classList.remove("hidden");
  btnRxStop.classList.add("hidden");
  setSignal("idle", "IDLE");
  updateBanner("idle", "RECEIVER IDLE — PRESS START", "◉");
  log("rx-log", "Receiver stopped.", "info");
  debugTrace("Receiver stopped and buffers cleared", "info");
  updateDebugPanel();
}

function extractRoiBrightness() {
  const W = hiddenCanvas.width;
  const H = hiddenCanvas.height;

  hiddenCtx.drawImage(rxVideo, 0, 0, W, H);

  const roiX = Math.floor((W - ROI_SIZE) / 2);
  const roiY = Math.floor((H - ROI_SIZE) / 2);

  const imageData = hiddenCtx.getImageData(roiX, roiY, ROI_SIZE, ROI_SIZE);
  const pixels    = imageData.data; 

  let totalLuminance = 0;
  const numPixels = ROI_SIZE * ROI_SIZE;

  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    totalLuminance += 0.299 * r + 0.587 * g + 0.114 * b;
  }

  return totalLuminance / numPixels;
}

let currentBrightness = 0;

function startBrightnessLoop() {
  rxLoopActive = true;

  function loop() {
    if (!rxLoopActive) return;

    if (rxVideo.readyState >= 2) { 
      currentBrightness = extractRoiBrightness();

      statCurrent.textContent = Math.round(currentBrightness);

      graphData.push(currentBrightness);
      if (graphData.length > GRAPH_HISTORY) graphData.shift();

      brightnessHistory.push({ t: performance.now(), v: currentBrightness });
      if (brightnessHistory.length > BRIGHTNESS_HISTORY_LIMIT) brightnessHistory.shift();

      drawGraph();

      dbgFrameCounter++;
      if (dbgFrameCounter % 6 === 0) {
        updateDebugPanel();
      }
    }

    rxAnimFrame = requestAnimationFrame(loop);
  }

  loop();
}

async function runCalibration() {
  setRxState("CALIBRATING");
  updateBanner("calibrating", "CALIBRATING — KEEP LIGHT AWAY FROM SENSOR...", "⟳");
  log("rx-log", `Calibrating for ${CALIB_DURATION_MS}ms — keep light source away...`, "info");
  debugTrace("Calibration started", "info");

  const samples = [];
  const start   = Date.now();

  while (Date.now() - start < CALIB_DURATION_MS) {
    if (rxVideo.readyState >= 2) {
      samples.push(extractRoiBrightness());
    }
    await sleep(50); 
  }

  if (samples.length === 0) {
    log("rx-log", "Calibration failed — no samples collected!", "err");
    updateBanner("error", "CALIBRATION FAILED — TRY AGAIN", "✗");
    return;
  }

  ambientBaseline = samples.reduce((a, b) => a + b, 0) / samples.length;

  const variance = samples.reduce((sum, v) => sum + (v - ambientBaseline) ** 2, 0) / samples.length;
  const noiseStdDev = Math.sqrt(variance);

  const dynamicOffset = Math.max(THRESHOLD_OFFSET, noiseStdDev * 3);
  threshold = ambientBaseline + dynamicOffset;

  statThreshold.textContent = Math.round(threshold);
  log("rx-log", `Ambient: ${Math.round(ambientBaseline)}, Noise: ±${noiseStdDev.toFixed(1)}, Threshold: ${Math.round(threshold)}`, "ok");
  debugTrace(`Calibration done: baseline=${ambientBaseline.toFixed(2)}, threshold=${threshold.toFixed(2)}, noise=${noiseStdDev.toFixed(2)}`, "ok");
  updateDebugPanel();
}

function startBitSampler(lockToPayloadClock) {
  clearInterval(sampleInterval);

  const initialDelay = lockToPayloadClock ? Math.round(BIT_RATE_MS / 2) : BIT_RATE_MS;
  if (lockToPayloadClock) {
    readingClockLocked = true;
    debugTrace(`Clock relock requested: first sample after ${initialDelay}ms`, "info");
  }

  const tick = () => {
    if (rxState === "IDLE" || rxState === "CALIBRATING" || rxState === "COMPLETE") return;

    bitTickIndex++;

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

    const decision = computeBitDecision();
    lastDecisionMeta = decision;
    lastBitConfidence = decision.confidence;
    statConfidence.textContent = lastBitConfidence + "%";

    if (rxState === "SCANNING" && decision.bit === "0") {
      ambientBaseline = EMA_ALPHA * decision.avgBrightness + (1 - EMA_ALPHA) * ambientBaseline;
      threshold       = ambientBaseline + THRESHOLD_OFFSET;
      statThreshold.textContent = Math.round(threshold);
    }

    if (bitTickIndex % 12 === 0) {
      debugTrace(`Tick ${bitTickIndex}: bit=${decision.bit} conf=${decision.confidence}% avg=${decision.avgBrightness.toFixed(1)} thr=${threshold.toFixed(1)}`, "info");
    }

    processBit(decision.bit, decision);
    updateDebugPanel();
  };

  setTimeout(() => {
    tick();
    sampleInterval = setInterval(tick, BIT_RATE_MS);
  }, initialDelay);
}

function computeBitDecision() {
  const now = performance.now();
  const windowStart = now - SAMPLE_WINDOW_MS;
  const windowSamples = brightnessHistory.filter(s => s.t >= windowStart && s.t <= now);

  const samples = windowSamples.length
    ? windowSamples.map(s => s.v)
    : graphData.slice(-5);

  const sampleCount = samples.length;
  const avgBrightness = sampleCount
    ? samples.reduce((a, b) => a + b, 0) / sampleCount
    : currentBrightness;

  const variance = sampleCount
    ? samples.reduce((sum, v) => sum + (v - avgBrightness) ** 2, 0) / sampleCount
    : 0;
  const stdDev = Math.sqrt(variance);

  const distance = avgBrightness - threshold;
  const absDistance = Math.abs(distance);

  let bit;
  if (absDistance < HYSTERESIS_BAND) {
    bit = lastBitValue;
  } else {
    bit = avgBrightness > threshold ? "1" : "0";
  }
  lastBitValue = bit;

  const confidence = Math.min(100, Math.round((absDistance / THRESHOLD_OFFSET) * 100));

  return {
    bit,
    confidence,
    avgBrightness,
    stdDev,
    distance,
    sampleCount,
  };
}

function hammingDistance(a, b) {
  if (a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) diff++;
  }
  return diff;
}

function isPreambleMatch(bits) {
  const dist = hammingDistance(bits, PREAMBLE);
  return dist <= PREAMBLE_MAX_HAMMING;
}

function forceDecodeAndStop(reason) {
  clearInterval(sampleInterval);

  const payloadBits = rxBitBuffer.join("");
  if (payloadBits.length >= 8) {
    log("rx-log", `${reason}: Decoding ${payloadBits.length} bits`, "err");
    decodePayload(payloadBits);
  } else {
    log("rx-log", `${reason}: Not enough bits to decode (${payloadBits.length})`, "err");
  }

  setRxState("COMPLETE");
  updateBanner("error", `${reason} — ${rxBitBuffer.length} BITS RECEIVED`, "⚠");
  rxBitBuffer    = [];
  rxBitMetaBuffer = [];
  preambleWindow = [];
  reticleBox.classList.remove("locked");
  debugTrace(`Force stop: ${reason}`, "err");
  updateDebugPanel();
}

function processBit(bit, meta) {
  statBitsEl.textContent = rxBitBuffer.length;

  preambleWindow.push(bit);
  if (preambleWindow.length > PREAMBLE.length) {
    preambleWindow.shift();
  }

  if (rxState === "SCANNING") {
    updateBitBufferUI([...preambleWindow], "preamble");
    updateBanner("scanning", `SCANNING FOR PREAMBLE... [${preambleWindow.join("")}]`, "◎");

    const windowStr = preambleWindow.join("");
    if (isPreambleMatch(windowStr)) {
      const hd = hammingDistance(windowStr, PREAMBLE);
      log("rx-log", `★ PREAMBLE DETECTED [${windowStr}] (target ${PREAMBLE}, HD=${hd})`, "ok");
      debugTrace(`Preamble lock: window=${windowStr} hd=${hd} conf=${meta?.confidence ?? "?"}%`, "ok");

      setRxState("READING");
      rxBitBuffer = [];
      rxBitMetaBuffer = [];
      preambleWindow = [];
      readingStartTime = Date.now();
      reticleBox.classList.add("locked");

      liveDecode.innerHTML = '<span class="cursor-blink"></span>';
      liveCharsCount.textContent = "0 chars";
      liveBitsProgress.textContent = "next char: 0/8 bits";
      decodedOutput.innerHTML = '<span class="dim">Receiving data...</span>';
      updateBanner("reading", "★ PREAMBLE FOUND — ALIGNING CLOCK...", "⬤");

      startBitSampler(true);
      updateDebugPanel();
    }
    return;
  }

  // ── STATE: READING ──
  if (rxState === "READING") {
    rxBitBuffer.push(bit);
    rxBitMetaBuffer.push(meta || { confidence: 0 });
    statBitsEl.textContent = rxBitBuffer.length;
    updateBitBufferUI(rxBitBuffer, "data");

    updateLiveDecode();

    const charsDone = Math.floor(rxBitBuffer.length / 8);
    updateBanner("reading",
      `RECEIVING DATA — ${rxBitBuffer.length} bits (${charsDone} chars decoded)`,
      "●");

    // ── POSTAMBLE DETECTION (BYTE-ALIGNED ONLY) ──
    if (rxBitBuffer.length >= POSTAMBLE.length + POSTAMBLE_MIN_PAYLOAD_BITS && rxBitBuffer.length % 8 === 0) {
      const tail = rxBitBuffer.slice(-POSTAMBLE.length).join("");
      const tailConfidence = rxBitMetaBuffer
        .slice(-POSTAMBLE.length)
        .reduce((sum, m) => sum + (m.confidence || 0), 0) / POSTAMBLE.length;

      if (tail === POSTAMBLE && tailConfidence >= POSTAMBLE_MIN_CONFIDENCE) {
        clearInterval(sampleInterval);

        const payloadBits = rxBitBuffer
          .slice(0, rxBitBuffer.length - POSTAMBLE.length)
          .join("");

        lastPostambleStatus = `MATCH ✓ (conf ${Math.round(tailConfidence)}%)`;
        log("rx-log", `★ POSTAMBLE DETECTED [${POSTAMBLE}] at bit ${rxBitBuffer.length - POSTAMBLE.length}`, "ok");
        log("rx-log", `Payload extracted: ${payloadBits.length} bits (${Math.floor(payloadBits.length / 8)} complete bytes)`, "ok");
        debugTrace(`Postamble accepted: tail=${tail} conf=${tailConfidence.toFixed(1)}%`, "ok");

        decodePayload(payloadBits);

        setRxState("COMPLETE");
        reticleBox.classList.remove("locked");
        rxBitBuffer = [];
        rxBitMetaBuffer = [];
        preambleWindow = [];

        log("rx-log", "✓ Transmission complete. Receiver auto-stopped.", "ok");
        log("rx-log", "Press START to receive another message.", "info");
        updateDebugPanel();
        return;
      }

      if (tail === POSTAMBLE && tailConfidence < POSTAMBLE_MIN_CONFIDENCE) {
        lastPostambleStatus = `WEAK MATCH ✗ (${Math.round(tailConfidence)}%)`;
        debugTrace(`Postamble rejected (low confidence): ${tail} @ ${Math.round(tailConfidence)}%`, "err");
      } else {
        lastPostambleStatus = `tail=${tail} (no match)`;
      }
    }
  }
}

function updateLiveDecode() {
  const totalBits = rxBitBuffer.length;
  const fullChars = Math.floor(totalBits / 8);
  const remainingBits = totalBits % 8;

  let decodedSoFar = "";
  for (let i = 0; i < fullChars; i++) {
    const byte = rxBitBuffer.slice(i * 8, (i + 1) * 8).join("");
    const charCode = parseInt(byte, 2);
    // Show printable ASCII including spaces (32-126) normally, use dot for others
    if (charCode >= 32 && charCode <= 126) {
      decodedSoFar += String.fromCharCode(charCode);
    } else if (charCode === 9) {
      decodedSoFar += "→"; // Tab
    } else if (charCode === 10) {
      decodedSoFar += "↵"; // Newline
    } else {
      decodedSoFar += "·"; 
    }
  }

  liveDecode.innerHTML = (decodedSoFar || "") + '<span class="cursor-blink"></span>';
  liveCharsCount.textContent = fullChars + " chars";
  liveBitsProgress.textContent = `next char: ${remainingBits}/8 bits`;
}

function decodePayload(bits) {
  // Ensure bits string is properly formed
  if (!bits || bits.length === 0) {
    log("rx-log", "✗ Decode error: Empty payload", "err");
    return;
  }

  log("rx-log", `[DEBUG] Raw received bits: ${bits}`, "info");
  log("rx-log", `[DEBUG] Length: ${bits.length} bits (${Math.floor(bits.length / 8)} complete bytes, ${bits.length % 8} remaining bits)`, "info");

  // NO padding - work with exact bits received
  let text = "";
  let charCodes = [];
  let validCharCount = 0;
  
  // Process only complete 8-bit bytes
  const completeBytes = Math.floor(bits.length / 8);
  log("rx-log", `[DEBUG] Processing ${completeBytes} complete bytes...`, "info");
  
  for (let i = 0; i < completeBytes; i++) {
    const byte = bits.slice(i * 8, (i + 1) * 8);
    const charCode = parseInt(byte, 2);
    charCodes.push({ byte, charCode, char: String.fromCharCode(charCode) });
    
    // Accept printable ASCII (including space!) and common control characters
    if ((charCode >= 32 && charCode <= 126) || charCode === 10 || charCode === 13 || charCode === 9) {
      text += String.fromCharCode(charCode);
      validCharCount++;
    } else if (charCode === 0) {
      // Stop at null terminator if present
      break;
    } else {
      // For non-printable, show what it is
      text += `[${charCode}]`;
    }
  }

  // Log each decoded byte
  const charMapStr = charCodes.map((c, idx) => 
    `[${idx}]: ${c.byte} = ${c.charCode} = '${c.char}' ${(c.charCode >= 32 && c.charCode <= 126) ? '✓' : '✗'}`
  ).join(" | ");
  log("rx-log", `[DEBUG] Byte-by-byte: ${charMapStr}`, "info");

  // Clean up text - remove any [...] markers for non-printable if they weren't useful
  text = text.replace(/\s+$/g, ""); // Only trim trailing whitespace at very end
  text = text.replace(/[\x00-\x08\x0e-\x1f\x7f]*$/g, ""); // Remove trailing control chars

  if (validCharCount === 0) {
    log("rx-log", "✗ No valid characters in standard alignment. Check received bits.", "err");
    return;
  }

  log("rx-log", `✓ Decoded (${completeBytes} bytes): "${text}" (${validCharCount} valid chars)`, "ok");

  decodedOutput.textContent = text;
  decodedOutput.classList.add("flash");
  setTimeout(() => decodedOutput.classList.remove("flash"), 2000);

  liveDecode.innerHTML = text;

  setSignal("active", "MSG RX ✓");

  updateBanner("complete", `✓ MESSAGE RECEIVED: "${text.length > 40 ? text.slice(0,40) + '…' : text}"`, "✓");

  messageCount++;
  addToMessageHistory(text);
}

function addToMessageHistory(text) {
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function setRxState(newState) {
  rxState = newState;
  rxStateBadge.className = "rx-state-badge " + newState.toLowerCase();
  rxStateBadge.textContent = newState;
  statStatEl.textContent   = newState;

  reticleBox.classList.remove("scanning", "locked");
  if (newState === "SCANNING") reticleBox.classList.add("scanning");
  if (newState === "READING")  reticleBox.classList.add("locked");

  if (newState === "SCANNING") {
    updateBanner("scanning", "SCANNING FOR PREAMBLE PATTERN [101011]...", "◎");
  } else if (newState === "IDLE") {
    updateBanner("idle", "RECEIVER IDLE — PRESS START", "◉");
  } else if (newState === "CALIBRATING") {
    updateBanner("calibrating", "CALIBRATING — MEASURING AMBIENT LIGHT...", "⟳");
  } else if (newState === "DONE") {
    updateBanner("done", "MESSAGE DECODED — PROCESSING...", "✓");
  } else if (newState === "COMPLETE") {
    btnRxStop.classList.add("hidden");
    btnRxStart.classList.remove("hidden");
    btnRxStart.textContent = "START RECEIVER";
  }

  updateDebugPanel();
}

function updateBitBufferUI(bits, mode) 
{
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

function drawGraph() {
  const W = graphCanvas.width;
  const H = graphCanvas.height;
  const data = graphData;

  graphCtx.clearRect(0, 0, W, H);

  graphCtx.fillStyle = "#0d1117";
  graphCtx.fillRect(0, 0, W, H);

  if (data.length < 2) return;

  const xStep = W / (GRAPH_HISTORY - 1);

  const threshY = H - (threshold / 255) * H;
  graphCtx.setLineDash([4, 4]);
  graphCtx.strokeStyle = "rgba(245,166,35,0.5)";
  graphCtx.lineWidth = 1;
  graphCtx.beginPath();
  graphCtx.moveTo(0, threshY);
  graphCtx.lineTo(W, threshY);
  graphCtx.stroke();
  graphCtx.setLineDash([]);

  graphCtx.fillStyle = "rgba(245,166,35,0.6)";
  graphCtx.font = "9px 'Share Tech Mono'";
  graphCtx.fillText(`T=${Math.round(threshold)}`, 4, threshY - 3);

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

  const grad = graphCtx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(57,255,20,0.25)");
  grad.addColorStop(threshold / 255, "rgba(57,255,20,0.08)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  graphCtx.fillStyle = grad;
  graphCtx.fill();

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