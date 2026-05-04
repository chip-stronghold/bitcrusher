import { crush } from "./crusher.js";
import { encodeWAV } from "./wav-encoder.js";

// ---------------- DOM ----------------
const $ = (id) => document.getElementById(id);
const recordBtn = $("record");
const status = $("status");
const timer = $("timer");
const hint = $("hint");
const presetSel = $("preset");
const bitsEl = $("bits");
const rateEl = $("rate");
const bitsVal = $("bits-val");
const rateVal = $("rate-val");
const audio = $("preview");
const downloadEl = $("download");
const resetBtn = $("reset");

// ---------------- State ----------------
const MAX_DURATION = 5;       // seconds
const PRESETS = {
  clean:     { bits: 16, rate: 44100 },
  snes:      { bits: 8,  rate: 16000 },
  arcade:    { bits: 6,  rate: 11025 },
  destroyed: { bits: 4,  rate: 8000  },
};

let audioCtx = null;
let workletReady = false;
let recordingState = null;    // { stream, source, node, chunks, ctx, raf }
let sourceBuffer = null;      // captured AudioBuffer (raw)
let crushedUrl = null;        // current object URL on the audio/download
let renderToken = 0;          // cancel stale renders

// ---------------- Init ----------------
applyPreset(presetSel.value);
syncFill(bitsEl);
syncFill(rateEl);

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

  // Lazily create the AudioContext on the user gesture (required by Safari).
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
    // Worklet must be connected to a destination to pull, but we don't want to
    // monitor (and induce feedback). Route into a muted gain → destination.
    const sink = audioCtx.createGain();
    sink.gain.value = 0;
    captureNode.connect(sink).connect(audioCtx.destination);
  } else {
    // Fallback: ScriptProcessorNode (deprecated but universally available).
    captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
    captureNode.onaudioprocess = (e) => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    source.connect(captureNode);
    captureNode.connect(audioCtx.destination); // SP requires a destination to fire
  }

  const startedAt = performance.now();
  recordingState = { stream, source, node: captureNode, chunks, ctx: audioCtx, startedAt, raf: 0 };

  document.body.classList.add("recording");
  recordBtn.querySelector(".btn-rec-inner").textContent = "STOP";
  setStatus("REC");
  hint.textContent = "RECORDING… TAP TO STOP";

  const tick = () => {
    if (!recordingState) return;
    const elapsed = (performance.now() - recordingState.startedAt) / 1000;
    const remaining = Math.max(0, MAX_DURATION - elapsed);
    timer.textContent = remaining.toFixed(1);
    if (elapsed >= MAX_DURATION) {
      stopRecording();
      return;
    }
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
          // Slice copies into a transferable buffer that survives postMessage.
          this.port.postMessage(input[0].slice());
        }
        return true;
      }
    }
    registerProcessor("capture-processor", CaptureProcessor);
  `;
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
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
  timer.textContent = MAX_DURATION.toFixed(1);

  if (!chunks.length) {
    setStatus("EMPTY");
    hint.textContent = "NO AUDIO CAPTURED — TRY AGAIN";
    return;
  }

  // Concatenate chunks into the source AudioBuffer.
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  const buf = ctx.createBuffer(1, total, ctx.sampleRate);
  buf.getChannelData(0).set(merged);
  sourceBuffer = buf;

  setStatus("CRUNCH");
  hint.textContent = "TAP REC TO TRY AGAIN";
  resetBtn.disabled = false;
  scheduleRender();
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
  const bits = +bitsEl.value;
  const rate = +rateEl.value;
  setStatus("RENDER");
  try {
    const crushed = await crush(sourceBuffer, { bits, targetSampleRate: rate });
    if (token !== renderToken) return; // a newer render superseded us
    const blob = encodeWAV(crushed);
    if (crushedUrl) URL.revokeObjectURL(crushedUrl);
    crushedUrl = URL.createObjectURL(blob);
    audio.src = crushedUrl;
    downloadEl.href = crushedUrl;
    downloadEl.setAttribute("download", `bitcrush-${timestamp()}.wav`);
    downloadEl.classList.remove("disabled");
    downloadEl.setAttribute("aria-disabled", "false");
    setStatus("READY");
  } catch (err) {
    console.error("[bitcrusher] render error:", err);
    setStatus("ERR");
    hint.textContent = "RENDER FAILED — SEE CONSOLE";
  }
}

// ---------------- Presets + sliders ----------------
presetSel.addEventListener("change", () => {
  if (presetSel.value === "custom") return;
  applyPreset(presetSel.value);
  scheduleRender();
});

[bitsEl, rateEl].forEach((el) => {
  el.addEventListener("input", () => {
    syncFill(el);
    if (el === bitsEl) bitsVal.textContent = String(+el.value).padStart(2, "0");
    else rateVal.textContent = String(+el.value);
    presetSel.value = matchPreset(+bitsEl.value, +rateEl.value) || "custom";
    scheduleRender();
  });
});

function applyPreset(key) {
  const p = PRESETS[key];
  if (!p) return;
  bitsEl.value = String(p.bits);
  rateEl.value = String(p.rate);
  bitsVal.textContent = String(p.bits).padStart(2, "0");
  rateVal.textContent = String(p.rate);
  syncFill(bitsEl);
  syncFill(rateEl);
}

function matchPreset(bits, rate) {
  for (const [k, p] of Object.entries(PRESETS)) {
    if (p.bits === bits && p.rate === rate) return k;
  }
  return null;
}

function syncFill(input) {
  const min = +input.min, max = +input.max, val = +input.value;
  const pct = ((val - min) / (max - min)) * 100;
  input.style.setProperty("--fill", pct + "%");
}

// ---------------- Reset ----------------
resetBtn.addEventListener("click", () => {
  sourceBuffer = null;
  if (crushedUrl) { URL.revokeObjectURL(crushedUrl); crushedUrl = null; }
  audio.removeAttribute("src"); audio.load();
  downloadEl.removeAttribute("href");
  downloadEl.classList.add("disabled");
  downloadEl.setAttribute("aria-disabled", "true");
  resetBtn.disabled = true;
  setStatus("READY");
  hint.textContent = "PRESS START TO RECORD 5 SEC";
  timer.textContent = MAX_DURATION.toFixed(1);
});

// ---------------- Helpers ----------------
function setStatus(s) { status.textContent = s; }

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
