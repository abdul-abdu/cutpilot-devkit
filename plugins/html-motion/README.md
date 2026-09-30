# HTML Motion

Motion-graphics clips for a CutPilot edit: title cards, chapter headings, quotes, bullet lists and end cards. Each template is a small HTML page with a GSAP timeline. The plugin renders it at your edit's size (9:16, 1:1, 16:9, …) with [HyperFrames](https://github.com/heygen-com/hyperframes) and a local Chrome, and CutPilot puts the clip into the timeline as an **insert**, an undoable edit like any other. Your video is never touched.

It is a `generator` plugin. You don't call it directly: ask your AI for "a title card before the intro", "chapter headings before each part", or "an end card with my handle". CutPilot's `list_templates` and `add_insert` tools use it.

## Templates

- **title-card**: a big title, an optional small label above it (`eyebrow`) and a subtitle. 3 s by default (1–10 s).
- **chapter**: a big number or short label (`number`, e.g. "02") and the chapter title, left-aligned. 2.5 s (1–8 s).
- **quote**: a quotation revealed word by word, and who said it (`author`). 5 s (2–15 s).
- **bullets**: a heading and one to five points that come in one after another. 5 s (2–15 s).
- **end-card**: a headline, a call to action on a pulsing button (`cta`), and a handle or link. 4 s (1.5–10 s).

Every template also takes `background`, `color` and `accent` (`#RRGGBB`). Text sizes follow the frame's short side and shrink for longer text, so the same template works in every aspect. `list_templates` gives each one's parameters as JSON Schema, with an example.

## What it needs

- Google Chrome (or Chromium, Edge, Brave). If none is installed it also finds a Chrome that Puppeteer downloaded (`npx puppeteer browsers install chrome-headless-shell`), or the one named by `PUPPETEER_EXECUTABLE_PATH`. You can also set **Chrome executable** in CutPilot → Plugins → HTML Motion.
- ffmpeg with ffprobe on PATH (macOS: `brew install ffmpeg`).

It works offline: the plugin declares no network and gets no access to your videos. GSAP is copied next to each page, fonts are your system's, and HyperFrames runs without telemetry or update checks. Ask your AI to run `html-motion__doctor` if a render fails; it says what is missing.

Settings: **Chrome executable** (blank: find one) and **Render quality** (`draft`, `looks`, `delivery`).

## How it works

`generate` checks the parameters against the template's schema and the length against its bounds, then writes a HyperFrames project (`index.html`, `vendor/gsap.min.js`) into a folder under the temp directory named by a hash of everything that affects the picture: template, parameters, size, fps, length, quality, and the plugin and HyperFrames versions. It renders `clip.mp4` there, checks it with ffprobe, and returns its path. Asking for the same clip again returns that file without rendering. CutPilot copies the clip into the project, so the temp folder can be cleared at any time.

HyperFrames renders whole frames per second, so fps is rounded (29.97 → 30); CutPilot resamples inserts to the edit's frame rate when it renders.

A 3 s title card at 1080×1920 renders in about 8 s on a Linux container with the headless shell, most of which is Chrome starting.

## Develop

```sh
pnpm build
pnpm vitest run plugins/html-motion   # renders every template (needs Chrome + ffmpeg)
cutpilot plugin install plugins/html-motion --link
pnpm bundle plugins/html-motion       # → build/html-motion, for a copied install or the store
```

A new template is one entry in `src/templates.ts`: a zod schema for its parameters (with `.describe()` on each, since that is what the AI reads), an example, its lengths, and a `layout()` that returns the card's HTML, CSS and GSAP calls. The tests run HyperFrames' linter on every template at 9:16 and 16:9 and render each one.
