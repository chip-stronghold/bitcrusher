# BITCRUSHER

A no-build, single-page web app that records up to 5 seconds of microphone audio and crunches it into Street Fighter II / SNES-era game-audio textures. Download the result as a 16-bit WAV.

Pure HTML, CSS, and ES modules. No frameworks, no bundler, no npm.

Either tap **REC** to capture from the mic, or tap **LOAD SOUND FX** to upload an existing audio file (WAV / MP3 / M4A / OGG — anything `AudioContext.decodeAudioData` accepts). Both paths feed the same processing pipeline, so presets and sliders work the same on a recording or an uploaded sample.

Three modes are available via the top tab strip:

- **BITCRUSHER** — quantize bit depth + sample-and-hold decimation. 5-second recording cap.
- **GRANNY VO** — voice processor that pitches up, adds vibrato/wobble, thins the EQ, and softly saturates. Built for cutting old-lady character VO lines. 15-second recording cap. No bitcrushing applied.
- **HAMSTER** — cartoon rodent voice: heavy pitch shift with smaller grains for chattery character, nasal + squeak EQ boosts, fast tremolo, snappy compression. 10-second recording cap.

## Run locally

The mic API requires a secure context, so you can't just `open index.html` (mic on `file://` is blocked on most platforms). Serve over HTTP locally and visit it in a browser:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Desktop browsers allow mic access on `http://localhost`. iOS Safari requires HTTPS — use the GitHub Pages deploy or a local HTTPS proxy.

## Deploy

Push to a GitHub repo and turn on **Pages → Deploy from branch (main / root)**. The site is fully static.

## Bitcrusher presets

| Name      | Bits | Sample rate |
|-----------|------|-------------|
| Clean     | 16   | 44 100 Hz   |
| SNES      | 8    | 16 000 Hz   |
| Arcade    | 6    | 11 025 Hz   |
| Destroyed | 4    | 8 000 Hz    |

## Granny VO presets

| Name   | Pitch (semitones) | Wobble | Rate    | Age |
|--------|-------------------|--------|---------|-----|
| Sweet  | +4                | 18 %   | 4.8 Hz  | 35 %|
| Cranky | +5                | 32 %   | 5.5 Hz  | 65 %|
| Witch  | +7                | 55 %   | 6.4 Hz  | 95 %|

## Hamster presets

| Name    | Pitch (semitones) | Squeak | Chatter |
|---------|-------------------|--------|---------|
| Squeak  | +9                | 40 %   | 20 %    |
| Chatter | +12               | 65 %   | 45 %    |
| Helium  | +15               | 85 %   | 70 %    |

Sliders in either mode override the preset; selecting a preset snaps all values back. Moving a slider flips the preset menu to **Custom**.

## How it works

1. `getUserMedia` grabs raw mic audio.
2. An `AudioWorkletNode` (or `ScriptProcessorNode` fallback) captures Float32 PCM into a buffer — `MediaRecorder` is intentionally avoided because its lossy encoders smooth out the high-frequency content the crusher needs.
3. **Bitcrusher mode:** `crusher.js` runs two effects in series with no anti-aliasing — bit-depth quantization, then sample-and-hold decimation at the target rate.
4. **Granny VO mode:** `granny.js` runs a granular pitch shifter (PSOLA-lite — Hann-windowed grains read from the source at `factor` samples per output sample, hopping forward at the input rate so duration is preserved). Pitch factor is vibrato-modulated by an LFO. The shifted buffer is then run through native Web Audio nodes — highpass → peaking EQ → lowpass → soft-clip waveshaper → compressor — all rendered offline.
5. **Hamster mode:** `hamster.js` uses the same PSOLA-lite pitch shifter with smaller (~25 ms) grains so artifacts read chattery rather than smooth. The offline graph adds a nasal peaking EQ (~2 kHz) and a squeak peaking EQ (~4.5 kHz), a fast tremolo (6–11 Hz `OscillatorNode` modulating a `GainNode`), soft-clip, and snappy compression.
6. `wav-encoder.js` writes a 44-byte RIFF header and 16-bit PCM samples into a `Blob`.
7. The `Blob` becomes both the `<audio>` source and the download link.

Re-rendering happens entirely from the stored source buffer, so changing a preset never re-records (and never re-decodes).

The download filename embeds the source name and mode settings — e.g. `bitcrush-laser-zap-4b-8000hz-20260602-113802.wav` or `granny-grandma-line-cranky-20260615-142340.wav`.
