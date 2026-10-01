# Cloud Transcribe

Transcribe your videos in the cloud with [ElevenLabs Scribe](https://elevenlabs.io/speech-to-text) instead of whisper on your computer. Scribe gives word timestamps in about 90 languages, Uzbek and Russian among them, and marks sounds like `(laughter)` as non-speech, so the transcript edits exactly like a whisper one: cutting fillers and pauses, captions, highlights.

It is a `transcriber` plugin. Once it is installed and has a key, choose **Cloud Transcribe** as the transcriber when you open a video, or ask your AI to open it with this transcriber. You pay ElevenLabs for what you transcribe, with your own account.

## What it needs

- An ElevenLabs API key with speech-to-text access. Enter it as `ELEVENLABS_API_KEY` in CutPilot → Plugins → Cloud Transcribe. CutPilot stores it and passes it only to this plugin.
- An internet connection. The plugin talks only to `api.elevenlabs.io`.

**Your audio leaves your computer.** The plugin uploads the audio track CutPilot extracts (16 kHz mono wav, about 115 MB an hour) to ElevenLabs. CutPilot asks you before a project is first transcribed in the cloud. The video itself is never uploaded or changed.

Settings:

- **ElevenLabs model**: `scribe_v2` by default.
- **Send expected words as key terms** (on by default): names and jargon you gave the project are sent to Scribe as key terms (at most 100, 50 characters each), which helps it spell them. Turn it off if you don't want that.

ElevenLabs takes up to 10 hours of audio per file; longer audio is refused before anything is uploaded.

## Errors

Each failure says what to do next:

| Code | When |
| --- | --- |
| `E_PLUGIN_NEEDS_SECRET` | no key entered |
| `E_CLOUD_TRANSCRIBE_BAD_KEY` | ElevenLabs refused the key (wrong, revoked, or without speech-to-text access) |
| `E_CLOUD_TRANSCRIBE_QUOTA` | your ElevenLabs credits are used up |
| `E_CLOUD_TRANSCRIBE_TOO_LARGE` | the audio is longer than ElevenLabs takes |
| `E_CLOUD_TRANSCRIBE_BUSY` | ElevenLabs is limiting requests (HTTP 429) |
| `E_CLOUD_TRANSCRIBE_UNAVAILABLE` | ElevenLabs failed (HTTP 5xx) |
| `E_CLOUD_TRANSCRIBE_REJECTED` | ElevenLabs refused the request for another reason, e.g. an unknown model |
| `E_CLOUD_TRANSCRIBE_NETWORK` | `api.elevenlabs.io` can't be reached |
| `E_CLOUD_TRANSCRIBE_UNEXPECTED` | ElevenLabs answered in a form this version doesn't know |
| `E_CLOUD_TRANSCRIBE_CANCELLED` | CutPilot cancelled the call |

## How it works

`transcribe` sends the wav to `POST https://api.elevenlabs.io/v1/speech-to-text` with word timestamps and audio-event tagging on, diarization off, and the project's language (none for `auto`, so Scribe detects it). From the answer it drops the spacing tokens, turns seconds into integer milliseconds, joins punctuation that comes as its own token to its word (`Okay` `,` → `Okay,`; `¿` `Qué` → `¿Qué`) without moving the word's times, keeps audio events as non-speech words, and turns each word's log-probability into a 0–1 confidence. Scribe's ISO 639-3 language code (`eng`, `uzb`) is reported as CutPilot's ISO 639-1 (`en`, `uz`). Nothing is written to disk.

## Develop

```sh
pnpm build
pnpm vitest run plugins/cloud-transcribe   # a recorded answer: no network, no key
CUTPILOT_LIVE_ELEVENLABS_KEY=sk_… CUTPILOT_LIVE_AUDIO=/path/to/talk_en.wav \
  pnpm vitest run plugins/cloud-transcribe  # plus a live run with your key
cutpilot plugin install plugins/cloud-transcribe --link
pnpm bundle plugins/cloud-transcribe       # → build/cloud-transcribe, for a copied install or the store
```

The live run takes a 16 kHz mono wav (`ffmpeg -i talk_en.mp4 -ac 1 -ar 16000 talk_en.wav`) and `CUTPILOT_LIVE_LANGUAGE` (default `en`).
