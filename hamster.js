// "Hamster" cartoon voice processor.
//
// Same PSOLA-lite pitch shifter as granny, but with smaller grains (~25 ms)
// so the artifacts feel chattery instead of smooth. After the shift:
//
//   src → HP (thin) → peaking @ 2 kHz (nasal) → peaking @ 4.5 kHz (squeak)
//       → LP (cartoon warmth) → tremolo (fast LFO on gain, the "chatter")
//       → soft-clip → compressor → out
//
// Tremolo (amplitude modulation) is what gives the cartoon warble; vibrato
// (frequency modulation) is baked into the shift path if you want it, but
// hamsters read better with pure tremolo.

export async function makeHamster(sourceBuffer, opts) {
  const semitones = clamp(opts.semitones ?? 12,  6, 16);
  const squeak    = clamp(opts.squeak    ?? 0.6, 0, 1);
  const chatter   = clamp(opts.chatter   ?? 0.4, 0, 1);

  const sr = sourceBuffer.sampleRate;
  const length = sourceBuffer.length;

  const mono = mixToMono(sourceBuffer);
  const factor = Math.pow(2, semitones / 12);
  const shifted = pitchShiftFast(mono, sr, factor);

  const offline = new OfflineAudioContext(1, length, sr);
  const buf = offline.createBuffer(1, length, sr);
  buf.getChannelData(0).set(shifted);

  const src = offline.createBufferSource();
  src.buffer = buf;

  // Thin — no chest cavity on a hamster.
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 320 + squeak * 180;    // 320..500
  hp.Q.value = 0.7;

  // Nasal bump.
  const nasal = offline.createBiquadFilter();
  nasal.type = "peaking";
  nasal.frequency.value = 1900;
  nasal.Q.value = 1.2;
  nasal.gain.value = 3 + squeak * 7;          // 3..10 dB

  // Squeaky presence.
  const bright = offline.createBiquadFilter();
  bright.type = "peaking";
  bright.frequency.value = 4600;
  bright.Q.value = 1.4;
  bright.gain.value = 2 + squeak * 8;         // 2..10 dB

  // Cartoon-warm rolloff — keeps it out of the sibilant zone.
  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 8500;

  // Fast tremolo — the chatter.
  const trem = offline.createGain();
  const baseline = 1 - chatter * 0.25;
  trem.gain.value = baseline;
  const lfo = offline.createOscillator();
  lfo.frequency.value = 6 + chatter * 5;      // 6..11 Hz
  const lfoAmp = offline.createGain();
  lfoAmp.gain.value = chatter * 0.35;
  lfo.connect(lfoAmp).connect(trem.gain);
  lfo.start();

  const shaper = offline.createWaveShaper();
  shaper.curve = makeSoftClipCurve(0.35 + squeak * 0.35);
  shaper.oversample = "2x";

  // Snappy comp — cartoon voices are always ducked hard.
  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -19;
  comp.knee.value = 8;
  comp.ratio.value = 5;
  comp.attack.value = 0.003;
  comp.release.value = 0.08;

  const out = offline.createGain();
  out.gain.value = 0.85;

  src.connect(hp).connect(nasal).connect(bright).connect(lp).connect(trem).connect(shaper).connect(comp).connect(out).connect(offline.destination);
  src.start();
  return await offline.startRendering();
}

// ---------- Granular pitch shift (fixed 25 ms grain) ----------
function pitchShiftFast(input, sampleRate, factor) {
  const n = input.length;
  const out = new Float32Array(n);
  const grain = Math.max(64, Math.floor(0.025 * sampleRate));
  const hop = Math.floor(grain / 2);
  const window = new Float32Array(grain);
  for (let i = 0; i < grain; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (grain - 1)));
  }
  let outPos = 0;
  let inPos = 0;
  while (outPos + grain < n) {
    let read = inPos;
    for (let i = 0; i < grain; i++) {
      const idx = Math.floor(read);
      if (idx + 1 >= n) break;
      const frac = read - idx;
      const s = input[idx] * (1 - frac) + input[idx + 1] * frac;
      out[outPos + i] += s * window[i];
      read += factor;
    }
    outPos += hop;
    inPos += hop;
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
  squeak:  { semitones: 9,  squeak: 0.40, chatter: 0.20 },
  chatter: { semitones: 12, squeak: 0.65, chatter: 0.45 },
  helium:  { semitones: 15, squeak: 0.85, chatter: 0.70 },
};
