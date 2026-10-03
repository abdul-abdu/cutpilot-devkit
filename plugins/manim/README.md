# Manim

Math and explainer animations for a CutPilot edit, rendered with [Manim Community](https://github.com/ManimCommunity/manim) (MIT), the engine behind 3Blue1Brown-style videos: a title written on stroke by stroke, a function plotted with a dot tracing it, a bar chart growing, one word morphing into another, a LaTeX equation, or any scene your AI writes in Python. The plugin renders at your edit's size (9:16, 1:1, 16:9, …) and CutPilot puts the clip into the timeline as an **insert**, an undoable edit like any other. Your video is never touched.

It is a `generator` plugin. You don't call it directly: ask your AI for "plot sin x before I explain waves", "a bar chart of our revenue by year", or "an animation of a square turning into a circle". CutPilot's `list_templates` and `add_insert` tools use it.

## Templates

- **title**: a title written on, an accent underline, an optional `subtitle`. 3 s by default (1–10 s).
- **function-plot**: axes, then y = f(x) drawn left to right with a dot tracing it. `expression` in x (`sin(x) * x^2 / 10`: numbers, `+ - * / ^ %`, brackets, `sin cos tan atan sinh cosh tanh exp log sqrt abs pi e`), `xMin`/`xMax`, optional `yMin`/`yMax` (else fitted to the curve) and `label`. 5 s (2–20 s).
- **bar-chart**: one to eight `items` (`label`, `value`) growing one after another, values on top with a `unit`, an optional `title`. 5 s (2–20 s).
- **morph-text**: `from` written on, then its letters fly into place to make `to` (anagrams look best). 4 s (2–12 s).
- **equation**: a LaTeX equation (`latex`, math mode without `$`) written on, an optional `caption` and `highlight`. Needs LaTeX. 4 s (1.5–15 s).
- **custom-scene**: your AI's own Manim scene: `code` is a Python file with `from manim import *` and a `Scene` class. The `scene_guide` tool gives it the rules first. 6 s (0.5–120 s); the clip is held on its last frame to the length asked, or runs longer if the scene does (and `durationMs` says so).

Every template but custom-scene takes `background`, `color` and `accent` (`#RRGGBB`); custom-scene takes `background`. Sizes follow the frame's short side, and long titles wrap onto two or three lines, so one template works in every aspect. `list_templates` gives each one's parameters as JSON Schema, with an example.

Extra tools: `manim__doctor` (what Manim and LaTeX the machine has, and what to install) and `manim__scene_guide` (the rules for custom-scene).

## What it needs

Manim, found in this order:

1. **Manim command** in CutPilot → Plugins → Manim: a `manim` executable, or a Python that has manim (`…/bin/python3`).
2. `manim` on PATH (also `~/.local/bin`, Homebrew, `/usr/local/bin`, which a GUI app's PATH leaves out).
3. A `python3` that can `import manim`.
4. [uv](https://docs.astral.sh/uv/): `uv tool run --python ">=3.10,<3.14" --from "manim>=0.19,<1" manim`, which downloads Manim from PyPI on first use (about 150 MB into uv's cache; the first render waits for it, about a minute). When the machine has no Python 3.10–3.13, uv downloads one too (from `releases.astral.sh`): macOS's own `python3` is 3.9, where uv picks a Manim that can't start. Those downloads are the only network the plugin declares (`pypi.org`, `files.pythonhosted.org`, `releases.astral.sh`); with Manim installed it works offline.

Installing Manim (see [its guide](https://docs.manim.community/en/stable/installation.html)):

- macOS: `brew install uv pango pkg-config`, then `uv tool install manim`.
- Linux: `sudo apt install libcairo2-dev libpango1.0-dev pkg-config python3-dev`, then `uv tool install manim`. Without the pango headers, pip and uv fail building `manimpango`, and the doctor shows that error.
- Windows: `winget install astral-sh.uv`, then `uv tool install manim`.

The equation template, and `MathTex`, `Tex` or numbered axes in a custom scene, need LaTeX with `dvisvgm`: MacTeX or `brew install --cask basictex` on macOS, `sudo apt install texlive texlive-latex-extra dvisvgm` on Linux. The other templates need no LaTeX. Manim ≥ 0.19 encodes with PyAV, so no ffmpeg is needed.

Setting: **Manim command or Python with Manim** (blank: find one). A setting that points nowhere is an error, not a reason to use another Manim.

## How it works

`generate` checks the parameters against the template's schema (a function-plot expression is checked token by token here and again by Python's parser before it is evaluated with nothing but `math`), the length against its bounds, and LaTeX for the equation. It then writes a job folder under the temp directory, named by a hash of everything that affects the picture (template, parameters, size, fps, length, the plugin, the Python runtime and Manim's version), with a copy of `python/cutpilot_manim.py`, a `job.json` and, for custom-scene, `scene.py`. It runs

```sh
manim render cutpilot_manim.py CutPilotScene --resolution W,H --fps N --disable_caching …
```

there and returns `clip.mp4`. Asking for the same clip again returns that file without rendering. CutPilot copies the clip into the project, so the temp folder can be cleared at any time.

`cutpilot_manim.py` draws each template from the frame's size and the length asked, and wraps a custom scene in a subclass that reports progress after every `play` and `wait` (`CUTPILOT_PROGRESS` lines on stderr), explains a failure in one line with the line of the user's code (`CUTPILOT_ERROR NameError: … (line 7: …)`, which generate returns as `E_MANIM_SCENE_FAILED` so the AI can fix its code), and holds the last frame to the length asked.

Things Manim doesn't tell you:

- `--resolution 1080,1920` sets the pixels but leaves `config.frame_width` at 14.2 units, so a portrait render shows a 4.5-unit slice of a landscape frame. The runtime sets the frame's width from the pixels' aspect (height stays 8 units).
- Manim rounds every animation up to whole frames, so `renderer.time` drifts from the clip (1480 ms reported for a 1520 ms clip). The runtime counts the frames written instead, pads to the nearest frame of the length asked, and reports that, so `durationMs` matches the MP4.
- Manim's error output is a box-drawn traceback longer than the lines kept from the end; the runtime's own one-line error is caught as it streams.

A 3 s title at 640×360 renders in about 2 s on a Linux container once Manim is installed; a first render through uv also waits for the download.

## Develop

```sh
pnpm build
pnpm vitest run plugins/manim              # renders when Manim is installed
MANIM_E2E=1 pnpm vitest run plugins/manim  # also when only uv is (it downloads Manim)
cutpilot plugin install plugins/manim --link
pnpm bundle plugins/manim                  # → build/manim, for a copied install or the store
```

A new template is an entry in `src/templates.ts` (a zod schema with `.describe()` on each field, an example, its lengths) and a function of the same id in `TEMPLATES` in `python/cutpilot_manim.py` that lays it out from `config.frame_width`/`frame_height` and ends with `hold(scene, d, outro)`.
