---
name: nodcut-plugin
description: Build, change, test, bundle or install a NodCut plugin in this devkit — a folder with a nodcut-plugin.json manifest and an MCP server made with definePlugin() from @nodcut/plugin-sdk (a transcriber, a reframe-track analyzer, a music or sound asset, a generator of clips, free-form extra tools, or a language pack). Use whenever the task mentions a plugin, plugins/<name>, the manifest, plugin kinds, PluginFailure, testPlugin, nodcut-plugin new|validate|test, pnpm bundle, or "nodcut plugin install".
---

# Write a NodCut plugin

A plugin is a folder: `nodcut-plugin.json` plus a command that starts an MCP server on stdio. NodCut starts it when needed (in its folder, with NodCut's own Node when `command` is `node`), calls its tools, checks every answer against the contract, and applies the result as an ordinary undoable edit. **A plugin returns data or files; it never edits the timeline.** It runs as a separate process, so a crash or a hang costs the user nothing but that call.

First-party plugins live in `plugins/<name>/` and are built exactly like a third-party one would be. This repo is public (MIT): nothing from the private app repo goes in; when the app is involved, name a task ID (`P3-030`) or a public concept, nothing more. The reader's guide is `docs/plugin-guide.md`; this skill is the short path for an agent working in this repo.

## 1. Pick the kind

| The plugin… | Kind | Handler(s) | Manifest needs |
| --- | --- | --- | --- |
| turns a 16 kHz wav into timed words | `transcriber` | `transcribe` | `reads: ["audio"]` |
| says where to centre the crop over time | `analyzer:reframe-track` | `reframeTrack` | `reads: ["source"]` |
| offers music tracks and their files | `asset:music` | `findMusic`, `getMusic` | — |
| makes a sound effect, music or speech from a description | `asset:sound` | `listVoices`, `generateSound` | — |
| renders clips from templates at the size asked (title cards, end cards) | `generator` | `listTemplates`, `generate` | — |
| does something the kinds don't cover | `kinds: []` | `tools: { … }` | whatever it reads |
| translates NodCut's interface | `language` | none: data only, no `command` | `languages: [{ code, name, messages, menu }]`; see the plugin guide's "Language packs" and `plugins/language-ru` |

Contracts are in `packages/plugin-api/src/contracts.ts` (`KIND_TOOLS`): read the input/output schema of your kind before writing the handler, because the SDK refuses any answer that doesn't match (`E_PLUGIN_CONTRACT`) and the engine refuses a plugin that doesn't offer its kind's tools. Extra tools reach AI clients as `<id>__<tool>` (`hyperframes__render`): snake_case, not a contract tool name, and the joined name at most 64 characters. A plugin can have kinds _and_ extra tools.

If the capability belongs in every NodCut (core logic, a new tool over the timeline), it is an app feature, not a plugin. If the plugin uses anything that is not free for everyone (a metered API, a library with a commercial licence, a model with terms), read `.agents/skills/nodcut-plugin-licensing/SKILL.md` first: the user brings their own key or licence, and the plugin declares, explains and guards that. If it needs a new kind or a new contract field, that is a contract change (`packages/plugin-api`, skill `nodcut-plugin-contract` in the app repo) first.

## 2. Start from the scaffold

```sh
pnpm build                                                           # the SDK's dist, which the CLI runs from
pnpm nodcut-plugin new <id> --kind <tools|transcriber|reframe-track|music|sound|generator> --dir plugins/<id>
```

It writes a plugin that passes `testPlugin()` before you change a line: the manifest, `src/index.ts`, `src/plugin.ts` with placeholder logic for the kind, `src/index.test.ts`, `package.json`, `tsconfig.json`, README, `.gitignore`, and an `AGENTS.md` with the rules below. The scaffold is standalone; to make it a workspace plugin:

- `package.json`: `"name": "@nodcut/plugin-<kind>-<name>"`, `"license": "MIT"`, `"@nodcut/plugin-sdk": "workspace:*"`; drop the `validate` script and the devDependencies the workspace already has (copy `plugins/hyperframes/package.json` for the shape).
- `tsconfig.json`: replace it with one that extends `../../tsconfig.base.json` (`rootDir: src`, `outDir: dist`, `references: [{ "path": "../../packages/plugin-sdk" }]`, tests excluded), as `plugins/hyperframes/tsconfig.json` does.
- Add `{ "path": "plugins/<id>" }` to the root `tsconfig.json` references and a row to `plugins/README.md`.
- `pnpm install` (the workspace sets a minimum release age, so a dependency version published in the last day is refused: pick an older one).

Files, when done:

```
plugins/<name>/
  nodcut-plugin.json     the manifest
  package.json             "@nodcut/plugin-<kind>-<name>", MIT, type module
  tsconfig.json            extends ../../tsconfig.base.json; references ../../packages/plugin-sdk
  src/index.ts             await definePlugin(definition).start()   — nothing else
  src/plugin.ts            export const definition: PluginDefinition = { … }
  src/*.test.ts            in-memory tests + testPlugin()
  README.md                what it does, its tools/settings, what the machine needs, how to try it
  icon.png + icon.svg      256 px square PNG the store and the app show (≤ 64 KB); keep the SVG it was drawn from
  AGENTS.md                the rules for an agent working on this plugin (the scaffold writes it)
```

An icon is drawn as SVG and rendered with headless Chrome (Quick Look's `qlmanage` writes a larger file and pads the frame):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --default-background-color=00000000 --window-size=256,256 --screenshot=icon.png "file://$PWD/icon.svg"
```

`@modelcontextprotocol/sdk` is a devDependency only when tests use its `Client` / `InMemoryTransport`.

### The manifest

```json
{
  "id": "follow-speaker",               // kebab-case, ≤ 40 chars; it prefixes every tool name
  "name": "Follow the speaker",
  "version": "0.1.0",                   // semver; same as package.json
  "description": "…what it does, ≤ 300 chars; AI clients and the store show this",
  "publisher": "NodCut",
  "homepage": "https://github.com/nodcut/plugins/tree/main/plugins/follow-speaker",
  "icon": "icon.png",                   // a PNG inside the folder, square, 32–256 px, ≤ 64 KB; testPlugin checks it
  "contract": 1,                        // CONTRACT_VERSION in plugin-api; the engine refuses others
  "nodcut": ">=0.2.0-beta.11",        // engine versions it works with: the first that has what the plugin needs
  "command": "node", "args": ["dist/index.js"],
  "kinds": ["analyzer:reframe-track"],
  "permissions": {
    "network": ["api.example.com"],     // host names; empty = works offline (the store says so)
    "secrets": ["EXAMPLE_API_KEY"],     // UPPER_SNAKE; the user enters them in NodCut → Plugins
    "reads": ["source"]                 // source | audio | frames; each kind's required reads are checked
  },
  "settings": [ { "key": "quality", "label": "Render quality", "type": "choice", "choices": ["draft","looks"], "default": "looks" } ]
}
```

Declare only what you use: the user approves permissions at install, and an update that asks for more asks again. `command` is relative to the folder and never leaves it; `node` means NodCut's runtime, so the user needs no Node of their own. Setting types: `string`, `number`, `boolean`, `choice`, `folder`. Validate early: `pnpm nodcut-plugin validate plugins/<name>` names each problem by its field.

## 3. Handlers

```ts
export const definition: PluginDefinition = {
  reframeTrack: async (input, ctx) => {
    const key = ctx.requireSecret('EXAMPLE_API_KEY');     // throws a PluginFailure that says where to enter it
    ctx.progress(0.1, 'sampling frames');
    …
    return { keyframes: [{ t: 0, x: 0.5, y: 0.5 }], confidence: 0.8 };
  },
  tools: {
    suggest_titles: defineTool({
      description: 'Three title ideas for the edit. Pass the words from get_words.',
      input: { words: z.array(WordSchema).describe('the transcript in source ms') },
      handler: async ({ words }, ctx) => ({ titles: […] }),
    }),
  },
};
```

What the SDK gives you in `ctx`: `settings` (typed from the manifest, defaults applied), `secret()` / `requireSecret()` (declared secrets only), `progress(0..1, message?)`, `signal` (aborted when NodCut cancels), `log()` (to stderr) and `manifest`. An extra tool returns text, an object, or a `ToolContent` of MCP content blocks (`imageBlock(png, 'image/png')` for an image the AI looks at).

Rules that come from how the host treats you:

- **Times are integer milliseconds in SOURCE time**, like everywhere in NodCut. Reframe keyframes strictly increase in `t`; `x`/`y` are the crop **centre** as fractions of the source frame. Transcribed words are in time order, `end >= start`, punctuation attached to the word.
- **Errors teach.** Throw `new PluginFailure('E_YOUR_CODE', oneLineMessage, oneLineFix)` for anything the user or their AI can act on; the fix names the setting, the tool to call, or the thing to install. Anything else becomes `E_PLUGIN_FAILED` with a generic fix, which helps nobody.
- **Never write to stdout.** It carries MCP; a stray `console.log` corrupts the session. Use `ctx.log()`.
- **Report progress during long work.** The host counts silence against the per-call limit (2 minutes by default), and a plugin that reports progress isn't timed out while it does. Honour `ctx.signal` so a cancelled call stops spending CPU.
- **Files you return are absolute paths that exist** (`get_music.file`, a rendered MP4). The engine copies what it needs; you own cleanup of your temp files.
- **Spawning a child with `process.execPath`** under the app: pass `ELECTRON_RUN_AS_NODE=1` through, or the child starts as an Electron app and hangs (see `plugins/hyperframes/src/hyperframes.ts` `runCli`).
- **Describe extra tools for the weakest model that should succeed**: what it does, what to pass (and where the AI gets it: `get_words`, `preview_data`, `list_projects`), what comes back, what to call next. `.describe()` on every field with units and an example.

Dependency rules (`.dependency-cruiser.cjs`): a plugin imports only `@nodcut/plugin-sdk` / `@nodcut/plugin-api` and its own npm packages; never another plugin, never `../`. Prefer pure npm dependencies: a plugin must carry everything it needs once installed, and a native binary or a CLI it spawns is what makes bundling and packing hard (`plugins/follow-speaker` ships a Swift helper under `files` in its package.json; `plugins/sound` downloads its runtime at first use).

## 4. Test

Two layers, both in `src/*.test.ts` (see `plugins/hyperframes/src/plugin.test.ts`):

1. **In memory** (fast, no build): `definePlugin({ ...definition, manifest }, env)` + `InMemoryTransport.createLinkedPair()` + the MCP `Client`. Test each tool's happy path, each `PluginFailure` code, and settings through `env` (`NODCUT_SETTING_BROWSER_PATH`, `NODCUT_SECRET_EXAMPLE_API_KEY`).
2. **As NodCut starts it** (needs `pnpm build`): `testPlugin(DIR)` inside `describe.skipIf(!existsSync('dist/index.js'))`. It starts the real process with NodCut's minimal environment, checks the manifest, the icon, the offered tools, and one call per contract tool (`reframe_track` only when you pass `fixtures.video`; calls needing a secret are skipped unless you pass `secrets`; `templates: 'all'` renders every generator template).

Network, a real model, Chrome, a provider API: behind `skipIf(!process.env.<NAME>_E2E)` and `skipIf(!tool found)`, so `pnpm check` passes on CI (macOS and Ubuntu, no network, no keys). Recorded responses for cloud providers (`plugins/cloud-transcribe/fixtures`).

```sh
pnpm build && pnpm vitest run plugins/<name>
pnpm format && pnpm check          # the gate; check includes format:check, so format first
```

The same checks from the command line: `pnpm nodcut-plugin test plugins/<name>` (`--secret NAME`, `--setting key=value`, `--video clip.mp4`, `--json`).

## 5. Try it in NodCut

A workspace folder's `node_modules` are pnpm symlinks, so it can only be installed **linked**. The commands are the NodCut app's `nodcut plugin …` (in a checkout of the app, `node packages/cli/dist/main.js plugin …` after its `pnpm build`):

```sh
nodcut plugin install plugins/<name> --link
nodcut plugin list        # state, problems with their fix, exported tool names
```

The CLI starts the engine if needed; the engine re-discovers plugins after every change and tells connected MCP clients (`tools/list_changed`). From an AI client, `list_plugins` shows the same, and `<id>__<tool>` is callable. A plugin that is switched off answers `E_PLUGIN_OFF`; one that crashes three times in ten minutes is turned off until reset.

For a copy install or the store, bundle first: `pnpm bundle plugins/<name>` writes `build/<id>/` (the SDK, plugin-api, zod and the MCP SDK bundled with esbuild; other dependencies installed with npm at the workspace's versions; the paths `files` lists copied; no links). Then `nodcut plugin install build/<id>` or `nodcut plugin pack build/<id>`. Putting a version in the store is done from the app repo (skill `nodcut-plugin-publish` there); it starts with a version bump here, committed first.

## 6. Finish

- README for the plugin: why it exists, the mapping/algorithm in a few lines, tools and settings, what the machine needs, "Try it", and what you learned that the docs don't say (the hyperframes README is the model).
- `plugins/README.md` row; `docs/plugin-guide.md` if authors will notice the change.
- `pnpm build && pnpm format && pnpm check` green.
- Commit on `main` as `AGENTS.md` says (`P3-030: <what changed>` when an app task drives it; no AI attribution trailer). The version stays `0.1.0` until it is published.
