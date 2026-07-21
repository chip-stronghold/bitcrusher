// "Hamster" cartoon voice processor — the Alvin-and-the-Chipmunks way.
//
// The classic cartoon rodent voice is a tape-speed trick: play the take
// back faster, so pitch, formants, and talking speed all rise together.
// A duration-preserving pitch shifter can't do this — it keeps formants
// planted and smears grains, which reads as "robot on helium".
//
// Pipeline:
//   mono → WSOLA time-stretch (recovers duration per `speed`) →
//   varispeed resample (the chipmunk) → HP → gentle nasal/squeak EQ →
//   LP → mild soft-clip → compressor → out
//
// `speed` = how much of the natural speed-up to keep.
//   1.0 → pure varispeed: cleanest, fully sped-up (short + fast = peak hamster)
//   0.0 → stretched back to original duration (most artifacts, use sparingly)
// The stretch happens BEFORE the resample, on unshifted audio, where the
// splices are least audible. At speed=1 the stretch is skipped entirely.

export async function makeHamster(sourceBuffer, opts) {
  const semitones = clamp(opts.semitones ?? 12,  4, 16);
  const speed     = clamp(opts.speed     ?? 0.7, 0, 1);
  const squeak    = clamp(opts.squeak    ?? 0.5, 0, 1);

  const sr = sourceBuffer.sampleRate;
  const mono = mixToMono(sourceBuffer);
  const factor = Math.pow(2, semitones / 12);

  // Stretch by alpha, then resample by factor. Net duration = alpha/factor.
  // speed=1 → alpha=1 (full speed-up); speed=0 → alpha=factor (original length).
  const alpha = 1 + (factor - 1) * (1 - speed);
  const stretched = alpha > 1.01 ? timeStretchWSOLA(mono, sr, alpha) : mono;
  const shifted = varispeed(stretched, factor);

  const length = shifted.length;
  const offline = new OfflineAudioContext(1, length, sr);
  const buf = offline.createBuffer(1, length, sr);
  buf.getChannelData(0).set(shifted);

  const src = offline.createBufferSource();
  src.buffer = buf;

  // Thin the low end — small creature, no chest.
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 260 + squeak * 120;    // 260..380
  hp.Q.value = 0.7;

  // Gentle nasal bump. Big peaks here are what read as "robot".
  const nasal = offline.createBiquadFilter();
  nasal.type = "peaking";
  nasal.frequency.value = 1900;
  nasal.Q.value = 1.0;
  nasal.gain.value = 1.5 + squeak * 3.5;      // 1.5..5 dB

  // A little squeaky sparkle.
  const bright = offline.createBiquadFilter();
  bright.type = "peaking";
  bright.frequency.value = 4600;
  bright.Q.value = 1.1;
  bright.gain.value = 1 + squeak * 4;         // 1..5 dB

  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 9000;

  // Barely-there saturation for warmth — not fuzz.
  const shaper = offline.createWaveShaper();
  shaper.curve = makeSoftClipCurve(0.15 + squeak * 0.25);
  shaper.oversample = "2x";

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 10;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.1;

  const out = offline.createGain();
  out.gain.value = 0.9;

  src.connect(hp).connect(nasal).connect(bright).connect(lp).connect(shaper).connect(comp).connect(out).connect(offline.destination);
  src.start();
  return await offline.startRendering();
}

// ---------- Varispeed (tape speed-up) ----------
// Linear-interp resample. factor > 1 → higher pitch, shorter duration.
function varispeed(input, factor) {
  const outLen = Math.max(1, Math.floor((input.length - 1) / factor));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * factor;
    const idx = pos | 0;
    const frac = pos - idx;
    out[i] = input[idx] * (1 - frac) + input[idx + 1] * frac;
  }
  return out;
}

// ---------- WSOLA time-stretch ----------
// Lengthens input by alpha (>1). Splice points are chosen by cross-
// correlation against the natural continuation of the previous grain,
// so grain boundaries land where waveforms align — far less metallic
// than fixed-hop overlap-add.
function timeStretchWSOLA(input, sampleRate, alpha) {
  const n = input.length;
  const outLen = Math.floor(n * alpha);
  const out = new Float32Array(outLen);
  const grain = Math.min(Math.floor(0.06 * sampleRate), 4096); // ~60 ms
  const overlap = grain >> 1;
  const hop = grain - overlap;
  const seek = Math.floor(0.012 * sampleRate);                 // ±12 ms

  const firstLen = Math.min(grain, n);
  for (let i = 0; i < firstLen; i++) out[i] = input[i];

  let outPos = hop;
  let prevIn = 0;
  while (outPos + grain < outLen) {
    const nominal = Math.round(outPos / alpha);
    const target = Math.min(prevIn + hop, n - overlap - 1);
    const lo = Math.max(0, Math.min(nominal - seek, n - grain - 1));
    const hi = Math.max(lo, Math.min(nominal + seek, n - grain - 1));

    let best = lo, bestCorr = -Infinity;
    for (let cand = lo; cand <= hi; cand += 4) {
      let corr = 0;
      for (let i = 0; i < overlap; i += 4) {
        corr += input[target + i] * input[cand + i];
      }
      if (corr > bestCorr) { bestCorr = corr; best = cand; }
    }

    for (let i = 0; i < overlap; i++) {
      const t = i / overlap;
      out[outPos + i] = out[outPos + i] * (1 - t) + input[best + i] * t;
    }
    for (let i = overlap; i < grain; i++) out[outPos + i] = input[best + i];

    prevIn = best;
    outPos += hop;
  }
  return out;
}

function makeSoftClipCurve(drive) {
  const n = 1024;
  const curve = new Float32Array(n);
  const d = 1 + drive * 5;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * d) / Math.tanh(d);
  }
  return curve;
}

function mixToMono(buffer) {
  const n = buffer.length;
  const out = new Float32Array(n);
  const c = buffer.numberOfChannels;
  if (c === 1) {
    out.set(buffer.getChannelData(0));
  } else {
    const a = buffer.getChannelData(0);
    const b = buffer.getChannelData(1);
    for (let i = 0; i < n; i++) out[i] = (a[i] + b[i]) * 0.5;
  }
  return out;
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export const HAMSTER_PRESETS = {
  squeak:  { semitones: 8,  speed: 0.45, squeak: 0.35 },
  classic: { semitones: 12, speed: 0.70, squeak: 0.55 },
  zoomies: { semitones: 15, speed: 1.00, squeak: 0.75 },
};
