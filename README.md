# CutPilot devkit

Everything you need to build a plugin for [CutPilot](https://github.com/abdul-abdu/cutpilot), the AI-first video editor: the plugin API, the SDK, and CutPilot's own first-party plugins. MIT licensed.

A CutPilot plugin is a folder with a `cutpilot-plugin.json` manifest and a command that starts an [MCP](https://modelcontextprotocol.io) server on stdio. It can be written in any language. CutPilot's engine starts the plugin when it's needed, calls its tools, validates what comes back and applies it as an ordinary, undoable edit. Plugins return data or files. They never edit the timeline themselves.

A `generator` plugin renders clips from templates (a title card, a chapter heading, an end card). It offers `list_templates` (each template's parameters as a JSON Schema, an example, default length, the aspects it's laid out for) and `generate` (a template, its parameters, the output size, fps and length → an MP4). CutPilot asks for the clip at the edit's output size and puts it in the timeline as an insert, an undoable edit like any other; `testPlugin()` renders the first template with its example (`templates: 'all'` renders every one).

A plugin may ship an icon: `"icon": "icon.png"` in the manifest names a PNG inside the folder, square, 32 to 256 px, at most 64 KB. The store shows it in its list and on the plugin's page, the app next to the installed plugin; without one, the first letter of the name stands in. `testPlugin()` checks the file the way the store will.

## What's here

| Path | npm package | What it is |
| --- | --- | --- |
| `packages/plugin-api` | `@cutpilot/plugin-api` | The manifest schema, the tool contract of each plugin kind (`transcriber`, `analyzer`, `asset`, `generator`), error codes, the registry index format. Depends on `zod` only. |
| `packages/plugin-sdk` | `@cutpilot/plugin-sdk` | `definePlugin()` (an MCP server with the contracts wired in) and `testPlugin()` (checks a plugin folder the way CutPilot will). |
| `packages/plugin-sdk/examples/hello` | — | The smallest plugin: one extra tool. |
| `plugins/*` | `@cutpilot/plugin-<kind>-<name>` | First-party plugins, built exactly like third-party ones. See [plugins/README.md](plugins/README.md). |

Nothing is published to npm yet. Until it is, the packages are `private` and are consumed from source.

## Develop

Requirements: Node 22+, pnpm (`corepack enable`).

```sh
pnpm install
pnpm build        # tsc -b: dist/ for every package (the SDK harness tests need it)
pnpm check        # typecheck, lint, format, dependency rules, tests
pnpm bundle plugins/<name>   # a plugin as a folder that stands alone (build/<id>), for a copied install or the store
```

### Together with the CutPilot app

The private app repo uses these packages straight from a sibling checkout. Its `pnpm-workspace.yaml` includes `../cutpilot-devkit/packages/*`, so an edit here is picked up there immediately, and both sides share one copy of `zod` and the MCP SDK.

```
~/lab/
  cutpilot/          # the app (private)
  cutpilot-devkit/   # this repo
```

- Run `pnpm install` in `cutpilot` after changing dependencies here. The app's install also writes `node_modules` into this repo's packages. If you then work on the devkit alone, run `pnpm install` here again.
- If you change a contract, commit it here first, then update the app. Breaking changes to a contract bump `CONTRACT_VERSION` in `packages/plugin-api/src/manifest.ts`.

## Rules

These are enforced by `.dependency-cruiser.cjs`:

- `plugin-api` imports only `zod`.
- `plugin-sdk` imports only `plugin-api`, the MCP SDK and `node:*`.
- A plugin imports only `plugin-sdk` / `plugin-api` and its own npm dependencies: never another plugin, and nothing outside this repo.
- No package imports a plugin, since plugins run as separate processes.

## License

[MIT](LICENSE). Plugins in `plugins/` are MIT unless their folder has its own `LICENSE`.
