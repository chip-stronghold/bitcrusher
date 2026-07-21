import { crush } from "./crusher.js";
import { makeGranny, GRANNY_PRESETS } from "./granny.js";
import { makeHamster, HAMSTER_PRESETS } from "./hamster.js";
import { encodeWAV } from "./wav-encoder.js";

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const recordBtn = $("record");
const status = $("status");
const timer = $("timer");
const hint = $("hint");
const audio = $("preview");
const downloadEl = $("download");
const resetBtn = $("reset");
const loadFxBtn = $("load-fx");
const fileInput = $("file-input");

// Mode tabs + panels
const tabCrush = $("tab-crush");
const tabGranny = $("tab-granny");
const tabHamster = $("tab-hamster");
const panelCrush = $("panel-crush");
const panelGranny = $("panel-granny");
const panelHamster = $("panel-hamster");
const marqueeTitle = $("marquee-title");
const marqueeSub = $("marquee-sub");

const MARQUEE = {
  crush:   { title: "BITCRUSHER", sub: "★ 16-BIT AUDIO CRUNCHER ★",   page: "BITCRUSHER ][" },
  granny:  { title: "GRANNY VO",  sub: "★ OLD-LADY VOICE PROCESSOR ★", page: "GRANNY VO ][" },
  hamster: { title: "HAMSTER",    sub: "★ CARTOON RODENT VOICE ★",     page: "HAMSTER ][" },
};

const TABS = { crush: tabCrush, granny: tabGranny, hamster: tabHamster };
const PANELS = { crush: panelCrush, granny: panelGranny, hamster: panelHamster };

// Bitcrusher controls
const presetSel = $("preset");
const bitsEl = $("bits");
const rateEl = $("rate");
const bitsVal = $("bits-val");
const rateVal = $("rate-val");

// Granny controls
const grannyPresetSel = $("granny-preset");
const pitchEl = $("pitch");
const wobbleEl = $("wobble");
const wobbleRateEl = $("wobble-rate");
const ageEl = $("age");
const pitchVal = $("pitch-val");
const wobbleVal = $("wobble-val");
const wobbleRateVal = $("wobble-rate-val");
const ageVal = $("age-val");

// Hamster controls
const hamsterPresetSel = $("hamster-preset");
const hPitchEl = $("h-pitch");
const hSqueakEl = $("h-squeak");
const hChatterEl = $("h-chatter");
const hPitchVal = $("h-pitch-val");
const hSqueakVal = $("h-squeak-val");
const hChatterVal = $("h-chatter-val");

// ---------------- State ----------------
const MAX_DURATION_CRUSH = 5;    // sec
const MAX_DURATION_GRANNY = 15;  // sec (room for a full VO line)
const MAX_DURATION_HAMSTER = 10; // sec (short cartoon lines)

const PRESETS = {
  clean:     { bits: 16, rate: 44100 },
  snes:      { bits: 8,  rate: 16000 },
  arcade:    { bits: 6,  rate: 11025 },
  destroyed: { bits: 4,  rate: 8000  },
};

let mode = "crush";                // "crush" | "granny" | "hamster"
let audioCtx = null;
let workletReady = false;
let recordingState = null;
let sourceBuffer = null;
let processedUrl = null;
let renderToken = 0;
let sourceLabel = "recording";

// ---------------- Init ----------------
applyCrushPreset(presetSel.value);
applyGrannyPreset(grannyPresetSel.value);
applyHamsterPreset(hamsterPresetSel.value);
[bitsEl, rateEl, pitchEl, wobbleEl, wobbleRateEl, ageEl, hPitchEl, hSqueakEl, hChatterEl].forEach(syncFill);
updateModeUI();

// ---------------- Mode switching ----------------
Object.values(TABS).forEach((tab) => {
  tab.addEventListener("click", () => {
    if (recordingState) return; // don't switch mid-record
    const next = tab.dataset.mode;
    if (next === mode) return;
    mode = next;
    updateModeUI();
    if (sourceBuffer) scheduleRender();
  });
});

function updateModeUI() {
  for (const [key, tab] of Object.entries(TABS)) tab.classList.toggle("is-active", mode === key);
  for (const [key, panel] of Object.entries(PANELS)) panel.hidden = mode !== key;
  const m = MARQUEE[mode];
  marqueeTitle.textContent = m.title;
  marqueeTitle.setAttribute("data-text", m.title);
  marqueeSub.textContent = m.sub;
  document.title = m.page;
  if (!sourceBuffer && !recordingState) {
    hint.textContent = restingHint();
    timer.textContent = currentMaxDuration().toFixed(1);
  }
}

function currentMaxDuration() {
  if (mode === "granny") return MAX_DURATION_GRANNY;
  if (mode === "hamster") return MAX_DURATION_HAMSTER;
  return MAX_DURATION_CRUSH;
}

function restingHint() {
  const cap = currentMaxDuration();
  return mode === "crush"
    ? `PRESS START TO RECORD ${cap} SEC`
    : `PRESS START TO RECORD UP TO ${cap} SEC`;
}

// ---------------- Recording ----------------
recordBtn.addEventListener("click", async () => {
  if (recordingState) {
    stopRecording();
  } else {
    try {
      await startRecording();
    } catch (err) {
      handleRecordError(err);
    }
  }
});

async function startRecording() {
  setStatus("ARMING…");
  hint.textContent = "REQUESTING MIC…";

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("getUserMedia not supported in this browser");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();

  const source = audioCtx.createMediaStreamSource(stream);
  const chunks = [];
  let captureNode;

  if (audioCtx.audioWorklet && !workletReady) {
    await registerWorklet(audioCtx);
    workletReady = true;
  }

  if (audioCtx.audioWorklet && workletReady) {
    captureNode = new AudioWorkletNode(audioCtx, "capture-processor");
    captureNode.port.onmessage = (e) => chunks.push(e.data);
    source.connect(captureNode);
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    captureNode.connect(sink).connect(audioCtx.destination);
  } else {
    captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
    captureNode.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(captureNode);
    captureNode.connect(audioCtx.destination);
  }

  const startedAt = performance.now();
  const cap = currentMaxDuration();
  recordingState = { stream, source, node: captureNode, chunks, ctx: audioCtx, startedAt, cap, raf: 0 };

  document.body.classList.add("recording");
  recordBtn.querySelector(".btn-rec-inner").textContent = "STOP";
  setStatus("REC");
  hint.textContent = "RECORDING… TAP TO STOP";

  const tick = () => {
    if (!recordingState) return;
    const elapsed = (performance.now() - recordingState.startedAt) / 1000;
    timer.textContent = Math.max(0, recordingState.cap - elapsed).toFixed(1);
    if (elapsed >= recordingState.cap) { stopRecording(); return; }
    recordingState.raf = requestAnimationFrame(tick);
  };
  recordingState.raf = requestAnimationFrame(tick);
}

async function registerWorklet(ctx) {
  const code = `
    class CaptureProcessor extends AudioWorkletProcessor {
      process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length) {
          this.port.postMessage(input[0].slice());
        }
        return true;
      }
    }
    registerProcessor("capture-processor", CaptureProcessor);
  `;
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
}

function stopRecording() {
  if (!recordingState) return;
  const { stream, source, node, chunks, ctx, raf } = recordingState;
  cancelAnimationFrame(raf);
  recordingState = null;

  try { source.disconnect(); } catch {}
  try { node.disconnect(); } catch {}
  if (node && node.port) node.port.onmessage = null;
  if (node && "onaudioprocess" in node) node.onaudioprocess = null;
  stream.getTracks().forEach((t) => t.stop());

  document.body.classList.remove("recording");
  recordBtn.querySelector(".btn-rec-inner").textContent = "REC";
  timer.textContent = currentMaxDuration().toFixed(1);

  if (!chunks.length) {
    setStatus("EMPTY");
    hint.textContent = "NO AUDIO CAPTURED — TRY AGAIN";
    return;
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const buf = ctx.createBuffer(1, total, ctx.sampleRate);
  buf.getChannelData(0).set(merged);
  sourceBuffer = buf;
  sourceLabel = "recording";

  setStatus(statusForMode());
  hint.textContent = "TAP REC TO TRY AGAIN";
  resetBtn.disabled = false;
  scheduleRender();
}

// ---------------- Upload ----------------
loadFxBtn.addEventListener("click", () => {
  if (recordingState) return;
  fileInput.value = "";
  fileInput.click();
});

fileInput.addEventListener("change", async () => {
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;
  try { await loadFxFile(file); } catch (err) { handleUploadError(err); }
});

async function loadFxFile(file) {
  setStatus("DECODE");
  hint.textContent = `DECODING ${truncate(file.name, 18).toUpperCase()}…`;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") await audioCtx.resume();
  const arrayBuf = await file.arrayBuffer();
  const decoded = await audioCtx.decodeAudioData(arrayBuf.slice(0));
  sourceBuffer = decoded;
  sourceLabel = sanitizeBasename(file.name) || "fx";
  setStatus(statusForMode());
  hint.textContent = `LOADED ${truncate(file.name, 18).toUpperCase()} — TWEAK & DOWNLOAD`;
  resetBtn.disabled = false;
  timer.textContent = decoded.duration.toFixed(1);
  scheduleRender();
}

function handleUploadError(err) {
  console.error("[bitcrusher] upload error:", err);
  setStatus("ERR");
  hint.textContent = (err && (err.name === "EncodingError" || err.name === "NotSupportedError"))
    ? "UNSUPPORTED FORMAT — TRY WAV/MP3/M4A/OGG"
    : "COULD NOT DECODE — SEE CONSOLE";
}

function handleRecordError(err) {
  console.error("[bitcrusher] record error:", err);
  setStatus("ERR");
  if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
    hint.textContent = "MIC DENIED — CHECK BROWSER PERMISSIONS";
  } else if (err && err.name === "NotFoundError") {
    hint.textContent = "NO MIC FOUND";
  } else {
    hint.textContent = "MIC ERROR — SEE CONSOLE";
  }
  recordingState = null;
  document.body.classList.remove("recording");
  recordBtn.querySelector(".btn-rec-inner").textContent = "REC";
}

// ---------------- Render pipeline ----------------
let renderTimer = 0;
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 150);
}

async function render() {
  if (!sourceBuffer) return;
  const token = ++renderToken;
  setStatus("RENDER");
  try {
    let outBuf, filename;
    if (mode === "crush") {
      const bits = +bitsEl.value;
      const rate = +rateEl.value;
      outBuf = await crush(sourceBuffer, { bits, targetSampleRate: rate });
      const prefix = sourceLabel === "recording" ? "bitcrush" : `bitcrush-${sourceLabel}`;
      filename = `${prefix}-${bits}b-${rate}hz-${timestamp()}.wav`;
    } else if (mode === "granny") {
      const semitones    = +pitchEl.value;
      const wobbleDepth  = +wobbleEl.value / 100;
      const wobbleRateHz = +wobbleRateEl.value / 10;     // slider 20..90 → 2.0..9.0 Hz
      const age          = +ageEl.value / 100;
      outBuf = await makeGranny(sourceBuffer, { semitones, wobbleDepth, wobbleRateHz, age });
      const prefix = sourceLabel === "recording" ? "granny" : `granny-${sourceLabel}`;
      const tag = grannyPresetSel.value === "custom" ? "custom" : grannyPresetSel.value;
      filename = `${prefix}-${tag}-${timestamp()}.wav`;
    } else {
      const semitones = +hPitchEl.value;
      const squeak    = +hSqueakEl.value / 100;
      const chatter   = +hChatterEl.value / 100;
      outBuf = await makeHamster(sourceBuffer, { semitones, squeak, chatter });
      const prefix = sourceLabel === "recording" ? "hamster" : `hamster-${sourceLabel}`;
      const tag = hamsterPresetSel.value === "custom" ? "custom" : hamsterPresetSel.value;
      filename = `${prefix}-${tag}-${timestamp()}.wav`;
    }
    if (token !== renderToken) return;
    const blob = encodeWAV(outBuf);
    if (processedUrl) URL.revokeObjectURL(processedUrl);
    processedUrl = URL.createObjectURL(blob);
    audio.src = processedUrl;
    downloadEl.href = processedUrl;
    downloadEl.setAttribute("download", filename);
    downloadEl.classList.remove("disabled");
    downloadEl.setAttribute("aria-disabled", "false");
    setStatus("READY");
  } catch (err) {
    console.error("[bitcrusher] render error:", err);
    setStatus("ERR");
    hint.textContent = "RENDER FAILED — SEE CONSOLE";
  }
}

// ---------------- Bitcrusher controls ----------------
presetSel.addEventListener("change", () => {
  if (presetSel.value === "custom") return;
  applyCrushPreset(presetSel.value);
  scheduleRender();
});

[bitsEl, rateEl].forEach((el) => {
  el.addEventListener("input", () => {
    syncFill(el);
    if (el === bitsEl) bitsVal.textContent = String(+el.value).padStart(2, "0");
    else rateVal.textContent = String(+el.value);
    presetSel.value = matchCrushPreset(+bitsEl.value, +rateEl.value) || "custom";
    scheduleRender();
  });
});

function applyCrushPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  bitsEl.value = String(p.bits);
  rateEl.value = String(p.rate);
  bitsVal.textContent = String(p.bits).padStart(2, "0");
  rateVal.textContent = String(p.rate);
  syncFill(bitsEl); syncFill(rateEl);
}

function matchCrushPreset(bits, rate) {
  for (const [k, p] of Object.entries(PRESETS)) {
    if (p.bits === bits && p.rate === rate) return k;
  }
  return null;
}

// ---------------- Granny controls ----------------
grannyPresetSel.addEventListener("change", () => {
  if (grannyPresetSel.value === "custom") return;
  applyGrannyPreset(grannyPresetSel.value);
  scheduleRender();
});

[pitchEl, wobbleEl, wobbleRateEl, ageEl].forEach((el) => {
  el.addEventListener("input", () => {
    syncFill(el);
    updateGrannyReadouts();
    grannyPresetSel.value = matchGrannyPreset() || "custom";
    scheduleRender();
  });
});

function applyGrannyPreset(key) {
  const p = GRANNY_PRESETS[key];
  if (!p) return;
  pitchEl.value = String(p.semitones);
  wobbleEl.value = String(Math.round(p.wobbleDepth * 100));
  wobbleRateEl.value = String(Math.round(p.wobbleRateHz * 10));
  ageEl.value = String(Math.round(p.age * 100));
  [pitchEl, wobbleEl, wobbleRateEl, ageEl].forEach(syncFill);
  updateGrannyReadouts();
}

function updateGrannyReadouts() {
  pitchVal.textContent = "+" + pitchEl.value;
  wobbleVal.textContent = wobbleEl.value + "%";
  wobbleRateVal.textContent = (+wobbleRateEl.value / 10).toFixed(1) + "HZ";
  ageVal.textContent = ageEl.value + "%";
}

function matchGrannyPreset() {
  const semitones    = +pitchEl.value;
  const wobbleDepth  = +wobbleEl.value / 100;
  const wobbleRateHz = +wobbleRateEl.value / 10;
  const age          = +ageEl.value / 100;
  for (const [k, p] of Object.entries(GRANNY_PRESETS)) {
    if (p.semitones === semitones &&
        approx(p.wobbleDepth, wobbleDepth, 0.005) &&
        approx(p.wobbleRateHz, wobbleRateHz, 0.05) &&
        approx(p.age, age, 0.005)) {
      return k;
    }
  }
  return null;
}

function approx(a, b, eps) { return Math.abs(a - b) <= eps; }

// ---------------- Hamster controls ----------------
hamsterPresetSel.addEventListener("change", () => {
  if (hamsterPresetSel.value === "custom") return;
  applyHamsterPreset(hamsterPresetSel.value);
  scheduleRender();
});

[hPitchEl, hSqueakEl, hChatterEl].forEach((el) => {
  el.addEventListener("input", () => {
    syncFill(el);
    updateHamsterReadouts();
    hamsterPresetSel.value = matchHamsterPreset() || "custom";
    scheduleRender();
  });
});

function applyHamsterPreset(key) {
  const p = HAMSTER_PRESETS[key];
  if (!p) return;
  hPitchEl.value = String(p.semitones);
  hSqueakEl.value = String(Math.round(p.squeak * 100));
  hChatterEl.value = String(Math.round(p.chatter * 100));
  [hPitchEl, hSqueakEl, hChatterEl].forEach(syncFill);
  updateHamsterReadouts();
}

function updateHamsterReadouts() {
  hPitchVal.textContent = "+" + hPitchEl.value;
  hSqueakVal.textContent = hSqueakEl.value + "%";
  hChatterVal.textContent = hChatterEl.value + "%";
}

function matchHamsterPreset() {
  const semitones = +hPitchEl.value;
  const squeak    = +hSqueakEl.value / 100;
  const chatter   = +hChatterEl.value / 100;
  for (const [k, p] of Object.entries(HAMSTER_PRESETS)) {
    if (p.semitones === semitones &&
        approx(p.squeak, squeak, 0.005) &&
        approx(p.chatter, chatter, 0.005)) return k;
  }
  return null;
}

// ---------------- Shared ----------------
function syncFill(input) {
  const min = +input.min, max = +input.max, val = +input.value;
  const pct = ((val - min) / (max - min)) * 100;
  input.style.setProperty("--fill", pct + "%");
}

resetBtn.addEventListener("click", () => {
  sourceBuffer = null;
  sourceLabel = "recording";
  if (processedUrl) { URL.revokeObjectURL(processedUrl); processedUrl = null; }
  audio.removeAttribute("src"); audio.load();
  downloadEl.removeAttribute("href");
  downloadEl.classList.add("disabled");
  downloadEl.setAttribute("aria-disabled", "true");
  resetBtn.disabled = true;
  setStatus("READY");
  hint.textContent = restingHint();
  timer.textContent = currentMaxDuration().toFixed(1);
});

function setStatus(s) { status.textContent = s; }
function statusForMode() {
  if (mode === "granny") return "AGE";
  if (mode === "hamster") return "SQUEAK";
  return "CRUNCH";
}

function sanitizeBasename(name) {
  const noExt = name.replace(/\.[^.]+$/, "");
  return noExt.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 40);
}

function truncate(s, n) { return s.length <= n ? s : s.slice(0, n - 1) + "…"; }

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
