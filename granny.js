// "Granny VO" voice processor.
//
// Pipeline (all offline, returns AudioBuffer at the source rate):
//   mono → granular pitch shift w/ vibrato → highpass → peaking EQ →
//   lowpass → soft-clip waveshaper → compressor → out.
//
// Pitch shift is PSOLA-lite: overlap-add of Hann-windowed grains read
// from the source at `factor` samples per output sample. Hop forwards
// at the input rate so duration is preserved. Vibrato is an LFO that
// modulates the factor over time — gives the wavery quality.

export async function makeGranny(sourceBuffer, opts) {
  const semitones    = clamp(opts.semitones    ?? 5,    0,   12);
  const wobbleDepth  = clamp(opts.wobbleDepth  ?? 0.3,  0,   1);  // 0..1
  const wobbleRateHz = clamp(opts.wobbleRateHz ?? 5.2,  2,   9);
  const age          = clamp(opts.age          ?? 0.6,  0,   1);  // 0..1

  const sr = sourceBuffer.sampleRate;
  const length = sourceBuffer.length;

  const mono = mixToMono(sourceBuffer);
  const factor = Math.pow(2, semitones / 12);
  const shifted = pitchShiftWithVibrato(mono, sr, factor, wobbleDepth, wobbleRateHz);

  const offline = new OfflineAudioContext(1, length, sr);
  const buf = offline.createBuffer(1, length, sr);
  buf.getChannelData(0).set(shifted);

  const src = offline.createBufferSource();
  src.buffer = buf;

  // Cut chest tone; old voices read thinner.
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 160 + age * 140;       // 160..300 Hz
  hp.Q.value = 0.7;

  // Presence boost — papery, fronted quality.
  const peak = offline.createBiquadFilter();
  peak.type = "peaking";
  peak.frequency.value = 3200;
  peak.Q.value = 0.9;
  peak.gain.value = 3 + age * 7;              // 3..10 dB

  // Tame air, sounds less HD.
  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 8000 - age * 2000;     // 8k..6k

  const shaper = offline.createWaveShaper();
  shaper.curve = makeSoftClipCurve(age);
  shaper.oversample = "2x";

  // Hold-down compression — older voices are less dynamic.
  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -22 + age * 6;       // -22..-16
  comp.knee.value = 12;
  comp.ratio.value = 3 + age * 4;             // 3..7
  comp.attack.value = 0.004;
  comp.release.value = 0.18;

  // Trim makeup so loud setting doesn't bury the peaks.
  const out = offline.createGain();
  out.gain.value = 0.9 - age * 0.15;

  src.connect(hp).connect(peak).connect(lp).connect(shaper).connect(comp).connect(out).connect(offline.destination);
  src.start();
  return await offline.startRendering();
}

// ---------- Granular pitch shift with vibrato ----------
function pitchShiftWithVibrato(input, sampleRate, baseFactor, depth, rateHz) {
  const n = input.length;
  const out = new Float32Array(n);
  // ~50 ms grains, 50% overlap (Hann sums to ~1).
  const grain = Math.max(128, Math.floor(0.05 * sampleRate));
  const hop = Math.floor(grain / 2);
  const window = new Float32Array(grain);
  for (let i = 0; i < grain; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grain - 1)));
  }
  // Vibrato deviates pitch ±~100 cents max (~6% factor) at full depth.
  const wobbleAmt = depth * 0.06;
  const twoPiR = 2 * Math.PI * rateHz / sampleRate;

  let outPos = 0;
  let inPos = 0;
  while (outPos + grain < n) {
    const phase = twoPiR * inPos;
    const f = baseFactor * (1 + wobbleAmt * Math.sin(phase));
    let read = inPos;
    for (let i = 0; i < grain; i++) {
      const idx = Math.floor(read);
      if (idx + 1 >= n) break;
      const frac = read - idx;
      const sample = input[idx] * (1 - frac) + input[idx + 1] * frac;
      out[outPos + i] += sample * window[i];
      read += f;
    }
    outPos += hop;
    inPos += hop;
  }
  return out;
}

// ---------- Soft clip curve (waveshaper) ----------
function makeSoftClipCurve(age) {
  // tanh-style; drive ramps with age.
  const n = 1024;
  const curve = new Float32Array(n);
  const drive = 1 + age * 5;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / Math.tanh(drive);
  }
  return curve;
}

// ---------- Helpers ----------
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

export const GRANNY_PRESETS = {
  sweet:  { semitones: 4, wobbleDepth: 0.18, wobbleRateHz: 4.8, age: 0.35 },
  cranky: { semitones: 5, wobbleDepth: 0.32, wobbleRateHz: 5.5, age: 0.65 },
  witch:  { semitones: 7, wobbleDepth: 0.55, wobbleRateHz: 6.4, age: 0.95 },
};
