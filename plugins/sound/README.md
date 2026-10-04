# Sound

Sound effects, music and voice-overs made on your own computer from a description, for the clips your AI puts into a NodCut edit (title cards, chapters, end cards) or anywhere else it needs a sound. Nothing is sent anywhere: the models run locally with [audio.cpp](https://github.com/0xShug0/audio.cpp), a small C++ runtime in the spirit of whisper.cpp.

It is an `asset:sound` plugin. You don't call it directly: ask your AI for "a door slam before the chapter card", "ten seconds of calm piano under the intro" or "say 'Welcome back' in Russian over the title". NodCut's `generate_sound` tool and `add_insert`'s `sound` use it.

| Job | Model | Licence | Download |
| --- | --- | --- | --- |
| sound effects | [Stable Audio 3 Small SFX](https://huggingface.co/stabilityai/stable-audio-3-small-sfx) | [Stability AI Community License](https://stability.ai/community-license-agreement) | 1.7 GB |
| music | [Stable Audio 3 Small Music](https://huggingface.co/stabilityai/stable-audio-3-small-music) | the same | 1.7 GB |
| speech, 31 languages, 10 voices | [Supertonic 3](https://huggingface.co/Supertone/supertonic-3) | [BigScience OpenRAIL-M](https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE) | 450 MB |
| the runtime | [audio.cpp](https://github.com/0xShug0/audio.cpp) v0.9.0 | Apache-2.0 | 25–55 MB |

Effects and music are 44.1 kHz stereo, 1–120 s (effects default to 5 s, music to 30 s). Speech is 44.1 kHz mono, as long as the words take; the languages are en, ko, ja, ar, bg, cs, da, de, el, es, et, fi, fr, hi, hr, hu, id, it, lt, lv, nl, pl, pt, ro, ru, sk, sl, sv, tr, uk and vi, the voices `F1`–`F5` and `M1`–`M5`. No open model speaks Uzbek yet. Prompts for effects and music are in English.

## Licences, in short

- **Stable Audio 3**: free, also commercially, while your yearly revenue is under US $1 million (above that, an enterprise licence from Stability AI); show "Powered by Stability AI" where the sound is used, which NodCut keeps as the sound's attribution. Its text encoder is covered by the Gemma Terms of Use.
- **Supertonic 3**: free, also commercially; OpenRAIL-M's use restrictions apply to what you make (no deception, harassment, discrimination or unlawful use).
- **audio.cpp**: Apache-2.0.

Nothing is bundled with the plugin: the first time you ask for a sound, your AI runs `sound__doctor`, shows you the sizes and licences, and only with your agreement runs `sound__setup`, which downloads the runtime and the model for that job from their publishers (GitHub releases and Hugging Face), checks each file against a pinned SHA-256, and keeps them in `~/.nodcut/sound` (or the **Data folder** setting). It sets up one job at a time (a 1.7 GB model takes about 30 minutes at 1 MB/s), reports the progress with the speed and the time left, and a download that was stopped continues from where it was. `sound__remove` deletes them again.

## What it needs

A Mac (Apple Silicon or Intel), Windows x64 or Linux x64; about 2 GB of memory while a model works. On Apple Silicon the models run on the GPU (Metal); elsewhere on the CPU (set **Compute** to `cpu` to force that on a Mac). A 4 s effect takes about 2 s on an M-series Mac and 4 s on its CPU; a sentence of speech about a second. Linux and Windows on arm64 have no audio.cpp build yet.

Settings: **Data folder**, **Compute** (`auto`, `cpu`), **CPU threads** (0: half the cores).

## How it works

`generate_sound` runs `audiocpp_cli` once per request (`--task gen --family stable_audio` for effects and music, `--task tts --family supertonic` for speech) with a seed (yours, or a random one), writes the wav into `cache/` under a name made from everything that affects the sound, and returns its path with the sample rate, channels, length, licence and credit; the same request with the same seed is answered from that file. NodCut copies the wav into the project, so the cache can be cleared at any time. Progress is reported while the model works, so long sounds don't time out.

## Try it

```sh
pnpm build && pnpm vitest run plugins/sound            # fake runtime, local download server, the harness
NODCUT_SOUND_E2E=~/.nodcut/sound pnpm vitest run plugins/sound   # real sounds, once set up
```

Install it linked into a development NodCut (`nodcut plugin install plugins/sound --link`), then from an AI client: `sound__doctor`, `sound__setup({ what: "speech", agree: true })`, and `generate_sound({ kind: "speech", text: "Hello", language: "en" })`.

## What we learned

- audio.cpp's GGUF packages are single files with the model's configs embedded, so a model is one download. Kokoro (Apache-2.0, nicer English voices) is also in audio.cpp but needs espeak-ng's data on disk, which is why speech starts with Supertonic.
- Stable Audio's output is quiet (peaks around −19 dBFS); NodCut's export normalises loudness, so it is left as is.
- Sizes and hashes come from the publishers' APIs (Hugging Face's tree listing carries each LFS file's SHA-256; GitHub's release API carries a digest), so pinning a new version needs no download.
