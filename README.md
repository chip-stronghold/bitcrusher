# BITCRUSHER

A no-build, single-page web app that records up to 5 seconds of microphone audio and crunches it into Street Fighter II / SNES-era game-audio textures. Download the result as a 16-bit WAV.

Pure HTML, CSS, and ES modules. No frameworks, no bundler, no npm.

Either tap **REC** to capture 5 seconds from the mic, or tap **LOAD SOUND FX** to upload an existing audio file (WAV / MP3 / M4A / OGG — anything `AudioContext.decodeAudioData` accepts). Both paths feed the same crush pipeline, so presets and sliders work the same on a recording or an uploaded sample.

## Run locally

The mic API requires a secure context, so you can't just `open index.html` (mic on `file://` is blocked on most platforms). Serve over HTTP locally and visit it in a browser:

```sh
python3 -m http.server 8080
# then open http://localhost:8080
```

Desktop browsers allow mic access on `http://localhost`. iOS Safari requires HTTPS — use the GitHub Pages deploy or a local HTTPS proxy.

## Deploy

Push to a GitHub repo and turn on **Pages → Deploy from branch (main / root)**. The site is fully static.

## Presets

| Name      | Bits | Sample rate |
|-----------|------|-------------|
| Clean     | 16   | 44 100 Hz   |
| SNES      | 8    | 16 000 Hz   |
| Arcade    | 6    | 11 025 Hz   |
| Destroyed | 4    | 8 000 Hz    |

Sliders override either value; selecting a preset snaps both back. Moving a slider flips the preset menu to **Custom**.

## How it works

1. `getUserMedia` grabs raw mic audio.
2. An `AudioWorkletNode` (or `ScriptProcessorNode` fallback) captures Float32 PCM into a buffer — `MediaRecorder` is intentionally avoided because its lossy encoders smooth out the high-frequency content the crusher needs.
3. `crusher.js` runs two effects in series with no anti-aliasing: bit-depth quantization, then sample-and-hold decimation at the target rate.
4. `wav-encoder.js` writes a 44-byte RIFF header and 16-bit PCM samples into a `Blob`.
5. The `Blob` becomes both the `<audio>` source and the download link.

Re-rendering happens entirely from the stored source buffer, so changing a preset never re-records (and never re-decodes).

The download filename embeds the source name, bit depth, and target rate — e.g. `bitcrush-laser-zap-4b-8000hz-20260602-113802.wav`.
