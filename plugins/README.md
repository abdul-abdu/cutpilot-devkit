# First-party plugins

CutPilot's own plugins, one folder each, built the way a third-party plugin is: a `cutpilot-plugin.json` manifest and an MCP server made with `@cutpilot/plugin-sdk`. They may import only `@cutpilot/plugin-sdk` and `@cutpilot/plugin-api` (`.dependency-cruiser.cjs` → `plugins-only-sdk`). They are published in the CutPilot plugin store like anyone else's and are not bundled with the app, so nothing is installed by default.

| Folder | npm package | Kind | Task (app repo) |
| --- | --- | --- | --- |
| `cloud-transcribe/` | `@cutpilot/plugin-stt-cloud` | transcriber | P3-030, P3-031 |
| `follow-speaker/` | `@cutpilot/plugin-analyze-follow-speaker` | analyzer: reframe-track | P3-032, P3-033 |
| `music/` | `@cutpilot/plugin-asset-music` | asset: music | P3-034 |
| `hyperframes/` | `@cutpilot/plugin-render-hyperframes` | extra tools only (research) | — |
| `html-motion/` | `@cutpilot/plugin-generator-html-motion` | generator: title cards, chapters, quotes, lists, end cards | P3-036 |

## Adding a plugin

1. Create `plugins/<name>/` with `package.json` (`"name": "@cutpilot/plugin-<kind>-<name>"`, `"license": "MIT"`), `cutpilot-plugin.json`, `tsconfig.json` (extends `../../tsconfig.base.json`, references `../../packages/plugin-sdk`), `src/`, and an `icon.png` (256 px, square; keep the `icon.svg` it was drawn from next to it, so it can be redrawn).
2. Add its `tsconfig.json` to the root `tsconfig.json` references.
3. Test it with `testPlugin()` from the SDK in `src/*.test.ts`.
4. To install it as a copy or pack it for the store, `pnpm bundle plugins/<name>` writes `build/<id>/`: the entry bundled with the SDK (esbuild), the plugin's other dependencies installed with npm at the versions the workspace resolved, no links. A workspace folder itself can only be installed with `cutpilot plugin install <folder> --link`.
