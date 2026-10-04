# First-party plugins

CutPilot's own plugins, one folder each, built the way a third-party plugin is: a `cutpilot-plugin.json` manifest and an MCP server made with `@cutpilot/plugin-sdk`. They may import only `@cutpilot/plugin-sdk` and `@cutpilot/plugin-api` (`.dependency-cruiser.cjs` → `plugins-only-sdk`). They are published in the CutPilot plugin store like anyone else's and are not bundled with the app, so nothing is installed by default.

| Folder | npm package | Kind | Task (app repo) |
| --- | --- | --- | --- |
| `cloud-transcribe/` | `@cutpilot/plugin-stt-cloud` | transcriber (ElevenLabs Scribe or OpenAI whisper-1, with the user's key; `test_key`) | P3-030, P3-031 |
| `follow-speaker/` | `@cutpilot/plugin-analyze-follow-speaker` | analyzer: reframe-track (a crop that follows the main speaker; Apple Vision via a Swift helper, macOS only) | P3-032, P3-033 |
| `music/` | `@cutpilot/plugin-asset-music` | asset: music (background music by mood and length, from a library of loops inside the plugin; placeholder tracks for now) | P3-034 |
| `hyperframes/` | `@cutpilot/plugin-render-hyperframes` | extra tools only (research) | — |
| `html-motion/` | `@cutpilot/plugin-generator-html-motion` | generator: title cards, chapters, quotes, lists, end cards | P3-036 |
| `sound/` | `@cutpilot/plugin-asset-sound` | asset: sound (effects, music, speech made locally with audio.cpp) | P3-038 |
| `remotion/` | `@cutpilot/plugin-generator-remotion` | generator: React scenes rendered with the user's own Remotion project and licence (Remotion not included) | — |
| `manim/` | `@cutpilot/plugin-generator-manim` | generator: math and explainer animations (titles, function plots, bar charts, morphing text, LaTeX equations, scenes the AI writes in Python) rendered with Manim Community | — |
| `brag/` | `@cutpilot/plugin-tools-brag` | extra tools: /brag (latent-spaces, MIT) in CutPilot. The AI plans and writes a 15–25 s launch video, and the plugin checks, snapshots and renders it with HyperFrames (CC0 sound effects included) | — |

## Adding a plugin

1. Create `plugins/<name>/` with `package.json` (`"name": "@cutpilot/plugin-<kind>-<name>"`, `"license": "MIT"`), `cutpilot-plugin.json`, `tsconfig.json` (extends `../../tsconfig.base.json`, references `../../packages/plugin-sdk`), `src/`, and an `icon.png` (256 px, square; keep the `icon.svg` it was drawn from next to it, so it can be redrawn).
2. Add its `tsconfig.json` to the root `tsconfig.json` references.
3. Test it with `testPlugin()` from the SDK in `src/*.test.ts`.
4. To install it as a copy or pack it for the store, `pnpm bundle plugins/<name>` writes `build/<id>/`: the entry bundled with the SDK (esbuild), the plugin's other dependencies installed with npm at the versions the workspace resolved, and the other paths its `package.json` lists in `files` (a music library, a helper binary), no links. A workspace folder itself can only be installed with `cutpilot plugin install <folder> --link`.
