// "Newscast 1960" voice processor — the network newsreader / newsreel sound.
//
// What made that sound: a ribbon or dynamic mic close up (chesty proximity
// bump), a narrow broadcast band (no real lows or highs), valve preamps and
// transmitters gently saturating, a hard-working levelling amp squashing
// every syllable to the same loudness, and tape/optical wow, hiss and hum.
//
// Pipeline:
//   mono → tape wow/flutter → HP → chest bump → mid honk → LP (band limit) →
//   drive → valve saturation → leveller (slow, deep) → limiter (fast, hard) →
//   + hiss / mains hum / crackle (added post-compression, like the tape) → out
//
// `band`    0..1 — how narrow the channel is (studio 1960 → cinema newsreel → AM)
// `squash`  0..1 — how hard the levelling amp works (the "broadcast" density)
// `noise`   0..1 — hiss, hum and crackle level
// `wow`     0..1 — tape wow/flutter depth

export async function makeNewscast(sourceBuffer, opts) {
  const band   = clamp(opts.band   ?? 0.5,  0, 1);
  const squash = clamp(opts.squash ?? 0.6,  0, 1);
  const noise  = clamp(opts.noise  ?? 0.3,  0, 1);
  const wow    = clamp(opts.wow    ?? 0.25, 0, 1);

  const sr = sourceBuffer.sampleRate;
  const mono = mixToMono(sourceBuffer);
  const wobbled = wow > 0.001 ? tapeWow(mono, sr, wow) : mono;
  const length = wobbled.length;

  const offline = new OfflineAudioContext(1, length, sr);
  const buf = offline.createBuffer(1, length, sr);
  buf.getChannelData(0).set(wobbled);
  const src = offline.createBufferSource();
  src.buffer = buf;

  // Band floor: studio desks rolled off rumble, newsreels lost more.
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 90 + band * 210;          // 90..300 Hz
  hp.Q.value = 0.9;

  // Proximity bump — the authoritative chest of a close ribbon mic.
  const chest = offline.createBiquadFilter();
  chest.type = "peaking";
  chest.frequency.value = 180 + band * 120;      // 180..300 Hz
  chest.Q.value = 1.1;
  chest.gain.value = 4 - band * 2;               // 4..2 dB

  // Mid honk — horn speakers, optical tracks, AM receivers.
  const honk = offline.createBiquadFilter();
  honk.type = "peaking";
  honk.frequency.value = 1400 + band * 600;      // 1.4..2 kHz
  honk.Q.value = 0.8;
  honk.gain.value = 3 + band * 6;                // 3..9 dB

  // Band ceiling, two stacked lowpasses for a steep, "closed" top.
  const lpFreq = 7500 - band * 4300;             // 7.5k..3.2k
  const lp1 = offline.createBiquadFilter();
  lp1.type = "lowpass";
  lp1.frequency.value = lpFreq;
  lp1.Q.value = 0.9;
  const lp2 = offline.createBiquadFilter();
  lp2.type = "lowpass";
  lp2.frequency.value = lpFreq;
  lp2.Q.value = 0.6;

  // Push level into the valves.
  const drive = offline.createGain();
  drive.gain.value = 1.4 + squash * 1.2;

  // Valve saturation — asymmetric soft clip adds even harmonics (warmth).
  const valve = offline.createWaveShaper();
  valve.curve = makeValveCurve(0.3 + band * 0.4);
  valve.oversample = "4x";

  // Levelling amp — slow-ish, deep, rides the whole read.
  const leveller = offline.createDynamicsCompressor();
  leveller.threshold.value = -18 - squash * 16;  // -18..-34 dB
  leveller.knee.value = 8;
  leveller.ratio.value = 3 + squash * 9;         // 3..12
  leveller.attack.value = 0.012;
  leveller.release.value = 0.35 - squash * 0.15; // shorter release = more pump

  // Makeup + peak limiter — the transmitter's brick wall.
  const makeup = offline.createGain();
  makeup.gain.value = 1.6 + squash * 1.8;
  const limiter = offline.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.06;

  const out = offline.createGain();
  out.gain.value = 0.85;

  src.connect(hp).connect(chest).connect(honk).connect(lp1).connect(lp2)
    .connect(drive).connect(valve).connect(leveller).connect(makeup).connect(limiter)
    .connect(out).connect(offline.destination);

  // Tape / line noise bed, band-limited to match the channel.
  if (noise > 0.001) {
    const bed = offline.createBuffer(1, length, sr);
    bed.getChannelData(0).set(makeNoiseBed(length, sr, noise));
    const bedSrc = offline.createBufferSource();
    bedSrc.buffer = bed;
    const bedLp = offline.createBiquadFilter();
    bedLp.type = "lowpass";
    bedLp.frequency.value = lpFreq * 1.2;
    bedSrc.connect(bedLp).connect(offline.destination);
    bedSrc.start();
  }

  src.start();
  return await offline.startRendering();
}

// ---------- Tape wow & flutter ----------
// Slow wow (~0.7 Hz) plus faster flutter (~7 Hz), as a time-varying read
// offset. Depth in samples stays tiny — this is drift, not vibrato.
function tapeWow(input, sampleRate, depth) {
  const n = input.length;
  const out = new Float32Array(n);
  const wowAmp = depth * 0.0022 * sampleRate;     // up to ~2.2 ms
  const flutAmp = depth * 0.00025 * sampleRate;   // up to ~0.25 ms
  const wowW = (2 * Math.PI * 0.7) / sampleRate;
  const flutW = (2 * Math.PI * 7.3) / sampleRate;
  const base = wowAmp + flutAmp + 1;
  for (let i = 0; i < n; i++) {
    const pos = i - base + wowAmp * Math.sin(wowW * i) + flutAmp * Math.sin(flutW * i);
    if (pos < 0) continue;
    const idx = pos | 0;
    if (idx + 1 >= n) break;
    const frac = pos - idx;
    out[i] = input[idx] * (1 - frac) + input[idx + 1] * frac;
  }
  return out;
}

// ---------- Noise bed: hiss + mains hum + crackle ----------
function makeNoiseBed(n, sampleRate, amount) {
  const out = new Float32Array(n);
  const hiss = 0.012 * amount;
  const hum = 0.006 * amount;
  const humW = (2 * Math.PI * 50) / sampleRate;
  const crackleChance = (6 * amount) / sampleRate;   // ~6 pops/sec at full
  let pink = 0;
  for (let i = 0; i < n; i++) {
    // Softened white noise → warmer tape hiss.
    pink = pink * 0.85 + (Math.random() * 2 - 1) * 0.15;
    let s = pink * hiss * 3;
    s += hum * (Math.sin(humW * i) + 0.35 * Math.sin(3 * humW * i));
    if (Math.random() < crackleChance) s += (Math.random() * 2 - 1) * 0.08 * amount;
    out[i] = s;
  }
  return out;
}

// ---------- Valve curve ----------
// Asymmetric tanh: positive swings clip a little earlier than negative,
// which is what gives valves their even-order warmth.
function makeValveCurve(drive) {
  const n = 2048;
  const curve = new Float32Array(n);
  const d = 1 + drive * 3;
  const bias = 0.12 * drive;
  const norm = Math.tanh(d * (1 + bias));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(d * (x + bias * x * x)) / norm;
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

export const NEWSCAST_PRESETS = {
  network:  { band: 0.25, squash: 0.50, noise: 0.15, wow: 0.10 },
  newsreel: { band: 0.60, squash: 0.75, noise: 0.40, wow: 0.35 },
  wireless: { band: 0.90, squash: 0.90, noise: 0.55, wow: 0.20 },
};
