# Music

Background music for a NodCut edit, picked by mood and length from a small library that ships inside the plugin. Nothing is downloaded and nothing leaves your computer.

It is an `asset:music` plugin. You don't call it directly: ask your AI for "calm music under this, quiet while I talk" and NodCut's `find_music` and `set_music` use it. NodCut copies the track into the project, loops it to the length of the edit when the track allows it, ducks it under speech, and keeps its licence and credit line with the project.

## The library

| Track | Moods | Tempo | Length |
| --- | --- | --- | --- |
| Still Water | calm | 72 bpm | 53 s |
| Bright Side | upbeat | 118 bpm | 49 s |
| First Light | inspiring, upbeat | 96 bpm | 60 s |
| Clear Plan | corporate, upbeat | 110 bpm | 61 s |
| Long Shadow | dramatic | 70 bpm | 55 s |
| Rainy Desk | lo-fi, calm | 80 bpm | 72 s |

All six loop without a seam, are AAC at 128 kb/s (about 6 MB together), and are released as **CC0-1.0**: no credit needed, use them anywhere.

**These are placeholders.** They are synthesized from scratch by [`scripts/make-library.mjs`](scripts/make-library.mjs) (sine partials with envelopes for pads, plucks, bells, electric piano and bass; noise for hats and snares; a swept sine for the kick) so the plugin works end to end before a real library is chosen. They are listenable, not good. The real library, licensed for redistribution, replaces them later; the format stays the same.

To make them again (the same notes every time; needs ffmpeg):

```sh
node plugins/music/scripts/make-library.mjs            # all tracks and library.json
node plugins/music/scripts/make-library.mjs --only rainy-desk
```

## `library.json`

```json
{
  "tracks": [
    {
      "id": "rainy-desk",
      "title": "Rainy Desk",
      "moods": ["lo-fi", "calm"],
      "bpm": 80,
      "durationMs": 72000,
      "loopable": true,
      "license": "CC0-1.0",
      "attribution": "only when the licence asks for a credit line",
      "file": "rainy-desk.m4a"
    }
  ]
}
```

`file` is relative to `library/`. The first mood is the track's main one. `loopable` means the end runs into the start without an audible seam, so NodCut may repeat the track to cover a longer edit.

## How it picks

- `mood` keeps the tracks tagged with it. Spelling doesn't matter (`lo-fi`, `lofi`, `Lo Fi`), and common words are understood: happy → upbeat, epic → dramatic, chill → lo-fi and calm, business → corporate, uplifting → inspiring, relaxing → calm. A track whose main mood it is comes before one that only also has it.
- `query` keeps the tracks whose title or moods share a word with it; more shared words rank higher.
- `minDurationMs` (the length of the edit): tracks that cover it on their own come first (the shortest of them, which needs the least trimming), then loopable ones (the longest, which repeats least), then the rest.
- `limit`: 10 by default.

`get_music` returns the absolute path of the file, its length, licence and credit line. An unknown id is an error that tells the AI to use an id from `find_music`.

## Permissions and settings

None: no network, no secrets, no files of yours. No settings.

## Try it

```sh
pnpm build && pnpm vitest run plugins/music    # the picker, the tools, testPlugin, the bundle
pnpm bundle plugins/music                      # build/music, with library/ copied in
```

`pnpm bundle` copies the paths listed in the plugin's `package.json` `files`, so the library goes into the package.
