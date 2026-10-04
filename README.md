# NodCut devkit

Everything you need to build a plugin for [NodCut](https://github.com/abdul-abdu/nodcut), the AI-first video editor: the plugin API, the SDK, and NodCut's own first-party plugins. MIT licensed.

A NodCut plugin is a folder with a `nodcut-plugin.json` manifest and a command that starts an [MCP](https://modelcontextprotocol.io) server on stdio. It can be written in any language. NodCut's engine starts the plugin when it's needed, calls its tools, validates what comes back and applies it as an ordinary, undoable edit. Plugins return data or files. They never edit the timeline themselves.

A `generator` plugin renders clips from templates (a title card, a chapter heading, an end card). It offers `list_templates` (each template's parameters as a JSON Schema, an example, default length, the aspects it's laid out for) and `generate` (a template, its parameters, the output size, fps and length → an MP4). NodCut asks for the clip at the edit's output size and puts it in the timeline as an insert, an undoable edit like any other; `testPlugin()` renders the first template with its example (`templates: 'all'` renders every one).

A plugin may ship an icon: `"icon": "icon.png"` in the manifest names a PNG inside the folder, square, 32 to 256 px, at most 64 KB. The store shows it in its list and on the plugin's page, the app next to the installed plugin; without one, the first letter of the name stands in. `testPlugin()` checks the file the way the store will.

**To build a plugin, start with the [plugin guide](docs/plugin-guide.md)**: the kinds and extra tools, a walkthrough, permissions and settings, testing, installing and sharing.

## What's here

| Path | npm package | What it is |
| --- | --- | --- |
| `packages/plugin-api` | `@nodcut/plugin-api` | The manifest schema, the tool contract of each plugin kind (`transcriber`, `analyzer`, `asset:music`, `asset:sound`, `generator`), the `language` kind's catalogue format, error codes, the registry index format. Depends on `zod` only. |
| `packages/plugin-sdk` | `@nodcut/plugin-sdk` | `definePlugin()` (an MCP server with the contracts wired in), `validatePluginFolder()` (the manifest, icon and command, without starting anything), `testPlugin()` (checks a plugin folder the way NodCut will), `scaffoldPlugin()` (a new plugin folder of any kind that passes its tests from the start), and the `nodcut-plugin` command (`new`, `validate`, `test`) that prints each check with a fix for each failure. An extra tool returns text, an object, or a `ToolContent` of MCP content blocks (e.g. `imageBlock(png, 'image/png')` for an image the AI looks at). |
| `packages/plugin-sdk/examples/hello` | — | The smallest plugin: one extra tool. |
| `packages/plugin-sdk/template` | — | What `nodcut-plugin new` copies: a `definePlugin()` with placeholder logic and a test, per kind. |
| `packages/plugin-sdk/fixtures` | — | Plugins the SDK's tests check against: one that passes, a bad manifest, a contract-breaking answer. |
| `examples/python-plugin` | — | A plugin in Python (the official MCP Python SDK, run with `uv`): one extra tool, `word_stats`. Plugins can be written in any language. |
| `plugins/*` | `@nodcut/plugin-<kind>-<name>` | First-party plugins, built exactly like third-party ones: cloud transcription (ElevenLabs, OpenAI), follow the speaker (Apple Vision), music, html-motion, sound, remotion, manim, brag, hyperframes, and the Russian and Uzbek language packs. See [plugins/README.md](plugins/README.md). |
| `strings/strings.json` | — | Every string NodCut shows, for language packs (`nodcut-plugin validate --strings`). Written from the app's code. |

Nothing is published to npm yet. Until it is, the packages are `private` and are consumed from source (a new plugin can point at this checkout: `nodcut-plugin new <id> --sdk file:<path to packages/plugin-sdk>`). Publishing waits for the owner's decision; [docs/publishing-the-sdk.md](docs/publishing-the-sdk.md) has the steps and the versioning policy.

## Develop

Requirements: Node 22+, pnpm (`corepack enable`).

```sh
pnpm install
pnpm build        # tsc -b: dist/ for every package (the SDK harness tests need it)
pnpm check        # typecheck, lint, format, dependency rules, tests
pnpm bundle plugins/<name>   # a plugin as a folder that stands alone (build/<id>), with the files its package.json lists, for a copied install or the store
pnpm nodcut-plugin new <id> --kind <kind> --dir <dir>   # a new plugin (tools, transcriber, reframe-track, music, sound, generator)
pnpm nodcut-plugin validate <dir>   # check a plugin folder's manifest, icon and command
pnpm nodcut-plugin test <dir>       # start it the way NodCut does and call its tools (after pnpm build)
```

Coding agents: `AGENTS.md` is the guide, and `.agents/skills/nodcut-plugin` the procedure for plugin work (Agent Skills format; `.claude/skills` links to it for Claude Code).

### Together with the NodCut app

The private app repo is usually checked out next to this one and keeps its own copy of `packages/plugin-api` and `packages/plugin-sdk`, synced from here: this repo is the source of truth, and a test in the app fails when the copies differ (only the `version` field of each `package.json` may, since the app versions every package together). Until the SDK is on npm, that is how the engine builds against the contract.

```
nodcut-repo/
  nodcut/          # the app (private)
  nodcut-devkit/   # this repo
```

- If you change a contract, commit it here first, then sync and update the app. Breaking changes to a contract bump `CONTRACT_VERSION` in `packages/plugin-api/src/manifest.ts`.
- The app's registry entries point at `../nodcut-devkit/build/<id>-<version>` for the store, and its agent evals use `plugins/music` from here, so keep the two folders siblings with these names.

## Rules

These are enforced by `.dependency-cruiser.cjs`:

- `plugin-api` imports only `zod`.
- `plugin-sdk` imports only `plugin-api`, the MCP SDK and `node:*`.
- A plugin imports only `plugin-sdk` / `plugin-api` and its own npm dependencies: never another plugin, and nothing outside this repo.
- No package imports a plugin, since plugins run as separate processes.

## License

[MIT](LICENSE). Plugins in `plugins/` are MIT unless their folder has its own `LICENSE`.
