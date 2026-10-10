# First-party plugins

NodCut's own plugins, one folder each, built the way a third-party plugin is: a `nodcut-plugin.json` manifest and an MCP server made with `@nodcut/plugin-sdk` (or, for a language pack, catalogues and nothing to run). They may import only `@nodcut/plugin-sdk` and `@nodcut/plugin-api` (`.dependency-cruiser.cjs` → `plugins-only-sdk`). They are published in the NodCut plugin store like anyone else's and are not bundled with the app, so nothing is installed by default.

| Folder | npm package | Kind | Task (app repo) |
| --- | --- | --- | --- |
| `cloud-transcribe/` | `@nodcut/plugin-stt-cloud` | transcriber (ElevenLabs Scribe or OpenAI whisper-1, with the user's key; `test_key`) | P3-030, P3-031 |
| `pexels/` | `@nodcut/plugin-pexels` | asset:footage (Pexels photos and videos as B-roll, with the user's key; `test_key`; stub-tested until live use is approved) | BR1-064, BR1-065 |
| `follow-speaker/` | `@nodcut/plugin-analyze-follow-speaker` | analyzer: reframe-track (a crop that follows the main speaker; Apple Vision via a Swift helper, macOS only) | P3-032, P3-033 |
| `music/` | `@nodcut/plugin-asset-music` | asset: music (background music by mood and length, from a library of loops inside the plugin; placeholder tracks for now) | P3-034 |
| `hyperframes/` | `@nodcut/plugin-render-hyperframes` | extra tools only (research) | — |
| `html-motion/` | `@nodcut/plugin-generator-html-motion` | generator: title cards, chapters, quotes, lists, end cards | P3-036 |
| `sound/` | `@nodcut/plugin-asset-sound` | asset: sound (effects, music, speech made locally with audio.cpp) | P3-038 |
| `remotion/` | `@nodcut/plugin-generator-remotion` | generator: React scenes rendered with the user's own Remotion project and licence (Remotion not included) | — |
| `manim/` | `@nodcut/plugin-generator-manim` | generator: math and explainer animations (titles, function plots, bar charts, morphing text, LaTeX equations, scenes the AI writes in Python) rendered with Manim Community | — |
| `language-ru/` | — | language: the interface and menus in Russian (data only) | P3-067 |
| `language-uz/` | — | language: the interface and menus in Uzbek, Latin script (data only) | P3-067 |
| `brag/` | `@nodcut/plugin-tools-brag` | extra tools: /brag (latent-spaces, MIT) in NodCut. The AI plans and writes a 15–25 s launch video, and the plugin checks, snapshots and renders it with HyperFrames (CC0 sound effects included) | — |
| `ic-light/` | `@nodcut/plugin-tools-ic-light` | extra tools: local IC-Light previews and experimental video relighting with the user's own ComfyUI and models | — |

## Adding a plugin

A language pack is only `nodcut-plugin.json`, its catalogues and a README: no `package.json`, `tsconfig.json` or `src/`. `language-packs.test.ts` checks every `language-*` folder against `../strings/strings.json`, so a first-party pack stays complete (the plugin guide's "Language packs" has the format). Everything else:

1. Create `plugins/<name>/` with `package.json` (`"name": "@nodcut/plugin-<kind>-<name>"`, `"license": "MIT"`), `nodcut-plugin.json`, `tsconfig.json` (extends `../../tsconfig.base.json`, references `../../packages/plugin-sdk`), `src/`, and an `icon.png` (256 px, square; keep the `icon.svg` it was drawn from next to it, so it can be redrawn).
2. Add its `tsconfig.json` to the root `tsconfig.json` references.
3. Test it with `testPlugin()` from the SDK in `src/*.test.ts`.
4. To install it as a copy or pack it for the store, `pnpm bundle plugins/<name>` writes `build/<id>/`: the entry bundled with the SDK (esbuild), the plugin's other dependencies installed with npm at the versions the workspace resolved, and the other paths its `package.json` lists in `files` (a music library, a helper binary), no links. A workspace folder itself can only be installed with `nodcut plugin install <folder> --link`.
