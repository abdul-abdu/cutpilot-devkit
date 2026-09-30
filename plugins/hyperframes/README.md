# HyperFrames plugin (research)

A CutPilot plugin that expresses a CutPilot edit as a [HyperFrames](https://github.com/heygen-com/hyperframes) composition (HTML + CSS + a GSAP timeline) and renders it to MP4 with headless Chrome and ffmpeg. HyperFrames is HeyGen's open-source "write HTML, render video" framework, Apache-2.0.

**Why:** CutPilot's edit is data (kept ranges of an untouched source, words, a reframe track, captions). HyperFrames is a renderer whose input is also data, in a form an LLM writes fluently. This plugin is the experiment: can the edit be handed over losslessly, and what does HyperFrames add (motion-graphics captions, title cards, anything CSS can do) that ffmpeg filter graphs make hard?

It fits no plugin kind, so it offers only extra tools; AI clients see them as `hyperframes__doctor`, `hyperframes__compose`, `hyperframes__lint` and `hyperframes__render`. No contract change was needed.

## The mapping

- **Source video** (never modified) → linked into the project as `assets/source.<ext>`; one `<video class="clip">` per kept part.
- **Kept ranges** in source ms, in play order → `data-start` (output seconds, laid end to end), `data-duration`, `data-media-start` (the trim, source seconds).
- **Reframe track** (crop centres over source time) → the footage scaled to cover the stage (like `object-fit: cover`), panned by a GSAP timeline with linear segments between keyframes, each clip's steps re-timed to the output.
- **Words** in source ms → caption lines (a few words each, broken at sentence ends, cuts and long silences) as timed `<p class="clip">`; `karaoke` lights the spoken word with `tl.set`.
- **Aspect** (`9:16`, `1:1`, …) → `data-width` / `data-height`, as large as the source allows.
- **A title** → a timed `<h1 class="clip">` faded in by the timeline.

Everything the render needs is in the project folder: `gsap.min.js` is copied in and fonts are the system's, so the plugin declares no network and a render works offline.

## Tools

- `doctor` – the CLI version, the Chrome and ffmpeg found (and what to install if not).
- `compose({ source, segments?, words?, crop?, aspect?, title?, captions?, project? })` – writes `<project>/index.html` (plus `cutpilot-edit.json`, the input it was made from). Defaults: the whole source, the source's aspect, a folder under the temp dir.
- `lint({ project })` – HyperFrames' own linter (no browser).
- `render({ project, output?, fps?, quality? })` – `hyperframes render` with progress; returns the MP4 path.

Settings: the Chrome executable (found automatically when blank), render quality (`draft`, `looks`, `delivery`), fps.

Needs on the machine: Google Chrome (or Chromium/Edge/Brave) and ffmpeg. The `hyperframes` CLI is an npm dependency of the plugin; the plugin runs it with CutPilot's Node, offline (`HYPERFRAMES_NO_UPDATE_CHECK`, no telemetry, `HYPERFRAMES_BROWSER_PATH` set to the Chrome it found).

## What we learned

- **The contract is small and fits.** Root attributes, `data-start` / `data-duration` / `data-media-start` on media, `window.__timelines[id]` as a paused GSAP timeline the renderer scrubs. Times are seconds on the output timeline; CutPilot's are integer ms in source time, so the plugin owns the segment map (`outputTime`), and words or keyframes in cut parts simply disappear.
- **The linter is worth running before a render.** It caught three things the docs don't spell out: an audible `<video>` must say `data-has-audio="true"` (otherwise `muted`); an element GSAP tweens `x`/`y` on must not also carry a CSS `transform`; timed elements should be flat (a `<section>` containing a `<p>` is a warning). The composer respects all three now.
- **Render cost.** A two-second, 608×1080 draft render of a test pattern takes about 10 s on an M1 Pro, Chrome start included. A 44 s talking-head edit at 1080×1920 draft rendered in 34 s (HEVC source; frames are extracted with ffmpeg, so Chrome never decodes the source); the frame extraction cache makes second renders faster.
- **Spawning Node from a plugin.** Under the CutPilot app, `process.execPath` is Electron running as Node (`ELECTRON_RUN_AS_NODE=1`). A child started with `process.execPath` must get that variable too, or it starts as an Electron app and hangs; `runCli` passes it through. Report progress while a long child runs: CutPilot's host counts silence, not time, against its per-call limit.
- **Not covered yet:** CutPilot's audio work (tightened pauses are just cuts here, which is fine; music beds and ducking are not mapped), transitions, and captions styled from CutPilot's own caption settings.

## Updating `hyperframes`

It publishes several times a day. This workspace's pnpm enforces a minimum release age, so `pnpm install` rejects a version published in the last day: bump the range to one that resolves to an older release (the lockfile pins it), and rerun the `HYPERFRAMES_E2E=1` test, since the linter's rules move.

## Try it

```sh
pnpm build
HYPERFRAMES_E2E=1 pnpm vitest run plugins/hyperframes   # includes a real render (needs Chrome + ffmpeg)
```

Or install the folder into CutPilot and ask an AI client: "compose this edit with HyperFrames as 9:16 with karaoke captions, then render it".

```sh
cutpilot plugin install plugins/hyperframes --link
```

`--link` matters here: this folder's `node_modules` are pnpm symlinks into the workspace, so a copied install would have no dependencies, and `cutpilot plugin pack` refuses links. For a copy, or a store package, bundle it first:

```sh
pnpm bundle plugins/hyperframes        # → build/hyperframes: the SDK bundled in, hyperframes and gsap installed with npm
cutpilot plugin install build/hyperframes
cutpilot plugin pack build/hyperframes  # → hyperframes-<version>.cutpilot-plugin (about 34 MB: hyperframes brings sharp, puppeteer-core and an esbuild binary)
```
