# Brag

**You built it. Now brag.** [/brag](https://github.com/latent-spaces/brag) (by latent-spaces, MIT) is an agent skill that turns a project into a short, shareable launch video: music, motion and share copy, powered by [HyperFrames](https://hyperframes.heygen.com/). This plugin brings it to NodCut. Your AI follows brag's method: inspect what you built, plan a 15–25 s story with a hook, write the composition, look at stills, render. The plugin gives it a project folder to work in, HyperFrames' checks, stills and render, a poster frame and 228 sound effects. The video is a file, so NodCut's own tools can put it into an edit or leave it as is.

Ask your AI: "let's brag about my app", "make a launch video for this, vertical, yc-parody tone", "brag about the new export feature".

## Tools

The AI reaches them as `brag__<tool>`.

| Tool | What it does |
| --- | --- |
| `guide` | The method, start here. `workflow` (default): inspect → plan → compose → deliver, the nine questions, the creative laws, grounding, sound. `tones`: the seven presets (default, polished, yc-parody, chaotic, deadpan, cinematic, app-store). `hyperframes`: the rules `composition/index.html` must follow. `hyperframes-<page>`: HyperFrames' own docs (data-attributes, gsap, compositions, rendering, troubleshooting). |
| `start_project` | A project folder with a starter composition that passes `check`, at landscape 1920×1080, vertical 1080×1920 or square 1080×1080, 30 fps. |
| `write_file` | Writes `brag-plan.md`, `composition-brief.md`, `share-copy.txt`, `composition/index.html` or other composition files. Paths stay inside the project. Links that point out of it are refused too. |
| `add_asset` | Copies a file from this computer (logo, screenshot, footage, font, music) or a bundled sound effect into `composition/assets/`, and returns the `src` to use. |
| `list_sounds` | The bundled effects by use ("button press", "major reveal", "logo payoff", …), family or high-frequency risk, with their lengths. |
| `check` | `hyperframes check`: lint, runtime errors, missing assets, layout (overflow, text hidden under something), contrast and motion, sampled across the timeline and at transitions. Errors come first, each with HyperFrames' fix. |
| `snapshot` | Stills at the given seconds, returned as images for the AI to look at (JPEG, 960 px wide, when ffmpeg is there). |
| `render` | `brag.mp4` in the project, with progress. With `posterAt`, that frame becomes `brag.jpg` and is baked in as frame 0, so platforms show it as the thumbnail. Frame 0 is replaced, not added, so the length and audio sync stay the same. |
| `doctor` | What the machine has: the HyperFrames CLI, Chrome, ffmpeg, the projects folder. |

A project looks like this:

```
~/Movies/Brag/<name>-<YYYY-MM-DD-HHmmss>/
  brag-plan.md  composition-brief.md  share-copy.txt
  composition/index.html  composition/vendor/gsap.min.js  composition/assets/…
  snapshots/…  brag.mp4  brag.jpg
```

## What it needs

- Google Chrome (or Chromium, Edge, Brave, or one Puppeteer downloaded), or set **Chrome executable**.
- ffmpeg with ffprobe on PATH (macOS: `brew install ffmpeg`).
- No network: the plugin declares none. HyperFrames runs without telemetry or update checks, `snapshot` never sends frames to an AI service, and everything a composition uses is a file in the project.
- Settings: **Where brag projects go** (blank: `~/Movies/Brag` on a Mac, `~/Videos/Brag` elsewhere), **Chrome executable**, **Render quality** (`draft`, `looks`, `delivery`).

## How it differs from /brag

- **The AI works through the plugin.** Upstream, the agent runs HyperFrames itself and writes files in your repo. In NodCut the AI client (Claude Desktop, say) may have no shell or file access, so the plugin owns the project folder and runs HyperFrames. The method, the nine questions, the creative laws, the tones and the grounding rule come from brag's skill, condensed in `src/guide.ts`.
- **What it inspects is what your AI can reach.** That means your project's files if its client can read them, your site if it can fetch it, your footage in NodCut, and what you tell it. The plugin itself fetches nothing. A plugin's network permission names fixed hosts, so it can't capture an arbitrary site.
- **Music is not bundled.** brag ships ende.app's "Happy Beats / Business Moves" tracks, and its own notes say the licence must be verified before redistributing, so they are left out. The AI uses a file you have, music made with `generate_sound` (kind music, which needs a NodCut project), or a track from NodCut's music library. `find_music` names library tracks by id, not by file, so for those the AI renders `brag.mp4` without music and adds the track in NodCut with `set_music`. The sound effects are Kenney's, CC0 (`sounds/LICENSE.md`), with brag's per-file analysis in `sounds/index.json`.
- **HyperFrames' agent skills aren't assumed.** Upstream defers composition details to the HyperFrames skills the agent has installed. Here `guide` carries the rules a composition must follow and serves HyperFrames' own docs pages from the CLI.
- **No voiceover** (`--voice` upstream). NodCut's sound plugin makes speech, and the AI can add it as an audio clip.

## Things learned building it

- A timed element with children draws HyperFrames' `nested_structure_needs_subcomposition` warning. So scenes are untimed wrappers that the timeline shows and hides (`autoAlpha`), and only media and leaves are timed `.clip`s. The starter is built that way and checks clean.
- `check` catches what stills miss and vice versa. On a real 16 s vertical brag it found a caption hidden under the video it described (`text_occluded`, at the exact second) and effects whose slots were longer than the sounds. The stills then confirmed every scene and a mid-transition frame.
- That 16 s 1080×1920 video with an embedded clip and five effects rendered in about 55 s in a Linux container, including baking the poster.

## Develop

```sh
pnpm build
pnpm vitest run plugins/brag     # check, snapshot and render run when Chrome and ffmpeg are found (or BRAG_TEST_CHROME)
nodcut plugin install plugins/brag --link
pnpm bundle plugins/brag         # → build/brag, with sounds/
```
