// Bitcrush + sample-and-hold decimation.
//
// Two effects in series, no anti-aliasing — the aliasing IS the sound.
// Renders offline at the source's native sample rate so the artifacts
// land squarely in the output buffer.

export async function crush(sourceBuffer, { bits, targetSampleRate }) {
  const sr = sourceBuffer.sampleRate;
  const length = sourceBuffer.length;

  const offline = new OfflineAudioContext(1, length, sr);

  // Mix down to mono into a fresh buffer we can mutate.
  const mono = offline.createBuffer(1, length, sr);
  const out = mono.getChannelData(0);
  const ch = sourceBuffer.numberOfChannels;
  if (ch === 1) {
    out.set(sourceBuffer.getChannelData(0));
  } else {
    const a = sourceBuffer.getChannelData(0);
    const b = sourceBuffer.getChannelData(1);
    for (let i = 0; i < length; i++) out[i] = (a[i] + b[i]) * 0.5;
  }

  // 1) Bit-depth quantization.
  const safeBits = Math.max(1, Math.min(16, bits | 0));
  const steps = Math.pow(2, safeBits - 1);
  for (let i = 0; i < length; i++) {
    const s = out[i];
    const clamped = s > 1 ? 1 : s < -1 ? -1 : s;
    out[i] = Math.round(clamped * steps) / steps;
  }

  // 2) Sample-and-hold decimation.
  const targetSr = Math.max(1000, Math.min(sr, targetSampleRate | 0));
  const hold = Math.max(1, Math.floor(sr / targetSr));
  if (hold > 1) {
    for (let i = 0; i < length; i += hold) {
      const v = out[i];
      const end = Math.min(i + hold, length);
      for (let j = i + 1; j < end; j++) out[j] = v;
    }
  }

  // Pipe the mutated buffer back through an offline context so callers
  // get a "rendered" AudioBuffer they can hand straight to encodeWAV().
  const src = offline.createBufferSource();
  src.buffer = mono;
  src.connect(offline.destination);
  src.start();
  return await offline.startRendering();
}
