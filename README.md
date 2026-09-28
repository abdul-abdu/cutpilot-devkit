# CutPilot devkit

Everything you need to build a plugin for [CutPilot](https://github.com/abdul-abdu/cutpilot), the AI-first video editor: the plugin API, the SDK, and CutPilot's own first-party plugins. MIT licensed.

A CutPilot plugin is a folder with a `cutpilot-plugin.json` manifest and a command that starts an [MCP](https://modelcontextprotocol.io) server on stdio. It can be written in any language. CutPilot's engine starts the plugin when it's needed, calls its tools, validates what comes back and applies it as an ordinary, undoable edit. Plugins return data or files. They never edit the timeline themselves.

## What's here

| Path | npm package | What it is |
| --- | --- | --- |
| `packages/plugin-api` | `@cutpilot/plugin-api` | The manifest schema, the tool contract of each plugin kind (`transcriber`, `analyzer`, `asset`), error codes, the registry index format. Depends on `zod` only. |
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
