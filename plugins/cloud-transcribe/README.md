# Cloud transcription

Transcribe a video in the cloud instead of on your computer, with your own API key: [ElevenLabs Scribe](https://elevenlabs.io/speech-to-text) (`scribe_v1` by default, about 99 languages, Uzbek among them; it also marks laughter, applause and music) or [OpenAI](https://platform.openai.com/docs/guides/speech-to-text) `whisper-1`. The transcript edits exactly like one made locally: timed words with their punctuation, which CutPilot cuts, captions and searches.

It is a `transcriber` plugin. Choose it when you open a video (or ask your AI to open it with this transcriber); CutPilot sends the 16 kHz mono wav it makes from the video, never the video itself.

**Your audio leaves your computer** and goes to the provider you chose, under that provider's terms. Use the local transcriber for anything that must stay on your computer.

## Setup

1. Make an API key: ElevenLabs at elevenlabs.io → Settings → API keys (a restricted key needs speech-to-text access), or OpenAI at platform.openai.com/api-keys.
2. In CutPilot → Plugins → Cloud transcription → Keys, enter it as `ELEVENLABS_API_KEY` or `OPENAI_API_KEY`. CutPilot passes a key to this plugin only, and only the one it declares.
3. Settings → **Provider**: `elevenlabs` (the default) or `openai`. For ElevenLabs also **ElevenLabs model** (blank: `scribe_v1`; e.g. `scribe_v2` for a newer one your account offers) and **Send the project's expected words to ElevenLabs as key terms** (off by default).
4. **Test key** (the `test_key` tool) checks the key with a small request that uploads nothing and costs nothing: ElevenLabs `GET /v1/user`, OpenAI `GET /v1/models`.

## Permissions

| | |
| --- | --- |
| Network | `api.elevenlabs.io`, `api.openai.com` |
| Secrets | `ELEVENLABS_API_KEY`, `OPENAI_API_KEY` |
| Reads | `audio` (the wav CutPilot makes from the video) |

## What it returns

- Words in source time, integer milliseconds, in order, each ending at or after its start.
- Punctuation on the word it belongs to (`Hello,` `"three"` `tips.`). ElevenLabs sends spaces and sometimes marks as separate tokens: spaces are dropped, a closing mark joins the word before, an opening one (`"`, `«`, `¿`) the word after. OpenAI's timed words have no punctuation, so it is taken from the full text and put back on each word.
- ElevenLabs' audio events (`(laughs)`, `(applause)`) as words with `event: true`, which CutPilot treats as non-speech.
- A confidence per word from ElevenLabs (`exp(logprob)`); OpenAI gives none per word.
- The language heard as ISO 639-1 (`en`, `ru`, `uz`): OpenAI reports a name (`english`), ElevenLabs a three-letter code (`eng`); both are mapped. The project's language is sent as a hint; `auto` sends none. A prompt (names, jargon) goes to OpenAI as its prompt, and to ElevenLabs as key terms when that setting is on (split at commas, semicolons and lines; at most 100, each up to 50 characters).

## Errors

Every failure has a code, a one-line message and a fix:

| Code | When | Fix |
| --- | --- | --- |
| `E_PLUGIN_NEEDS_SECRET` | the chosen provider's key isn't entered | which key to enter, where; or switch provider |
| `E_STT_BAD_KEY` | 401 / 403 | check the key, make a new one |
| `E_STT_QUOTA` | out of credits or quota (ElevenLabs answers 401 `quota_exceeded`, OpenAI 429 `insufficient_quota`) | add credits, or switch provider |
| `E_STT_RATE_LIMITED` | 429 for too many requests | wait a minute |
| `E_STT_FILE_TOO_LARGE` | over the provider's limit, checked before uploading (OpenAI 25 MB, about 13 minutes of CutPilot's audio; ElevenLabs 10 hours), or 413 | ElevenLabs, or a shorter clip |
| `E_STT_NETWORK` | no connection, DNS, a firewall | check the connection |
| `E_STT_PROVIDER` | any other HTTP error, with the provider's own message | |
| `E_STT_BAD_RESPONSE` | an answer this plugin can't read | update the plugin |

## Limits

- OpenAI: 25 MB per file. ElevenLabs: 10 hours.
- The whole file is uploaded in one request; a long video takes as long as the upload plus the provider's processing.
- Speaker labels aren't used yet.
- Key terms and models other than `scribe_v1` haven't been run against the live API yet (the tests check the request the plugin sends); that is why key terms are off and the model is `scribe_v1` unless you change them.

## Try it

```sh
pnpm build && pnpm vitest run plugins/cloud-transcribe
```

The tests play recorded responses of both providers (`fixtures/`: words with punctuation, spacing tokens, an audio event, and the error bodies each provider sends), run real HTTP against a local stub, and run `testPlugin()` on the folder (without keys the call is skipped) and, through the stub, with keys. No test reaches the internet.

A live smoke run against the real providers needs keys and opting in:

```sh
CUTPILOT_LIVE_STT=1 ELEVENLABS_API_KEY=… OPENAI_API_KEY=… pnpm vitest run plugins/cloud-transcribe
```

It speaks a sentence with `say` (macOS) or `espeak-ng` and ffmpeg, or uses the wav in `CUTPILOT_LIVE_STT_AUDIO`. `CUTPILOT_CLOUD_TRANSCRIBE_ORIGIN` sends every request to another origin; the tests use it for the stub, CutPilot never sets it.
