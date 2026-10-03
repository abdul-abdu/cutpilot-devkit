# CutPilot devkit — agent guide

Shared instructions for every coding agent (Claude Code, Codex, Gemini CLI, Antigravity, Cursor, Copilot, local models). `CLAUDE.md` imports this file and `GEMINI.md` is a symlink to it, so edit **this file only**.

## What this is

The public, MIT-licensed half of CutPilot, the AI-first video editor: the plugin API, the plugin SDK and CutPilot's first-party plugins. A plugin is a folder with a `cutpilot-plugin.json` manifest and a command that starts an MCP server on stdio; CutPilot's engine starts it, calls its tools, validates the answers and applies them as undoable edits. **Plugins return data or files; they never edit the timeline.**

- Plugin authors' guide: `docs/plugin-guide.md` (what plugins can do, a walkthrough, manifest, permissions, testing, sharing).
- Publishing the SDK to npm: `docs/publishing-the-sdk.md` (waits for the owner's decision; the packages are `private` until then).
- The app that hosts plugins lives in the private `cutpilot` repo, usually checked out next to this one. Its Stage 3 plugin-host spec and the tasks that drive this repo (IDs like `P3-030`, in its phase-3-plugins folder) live there.

## Rules

- **This repo is public.** Never copy code, docs, task files or internal notes from the private app repo into it, and never import from it (`stay-in-repo` rule in `.dependency-cruiser.cjs`). When the app is involved, reference a task ID (`P3-030`) or a public concept, nothing more.
- **`packages/plugin-api` is the contract** the engine, the SDK and every published plugin build against. It imports only `zod`. A breaking change (a required field, a rename, a changed unit) bumps `CONTRACT_VERSION` in `src/manifest.ts` and orphans every published plugin until it is rebuilt, so prefer the additive shape (optional with a default, a new tool or kind next to the old one). The app repo keeps its own copy of `plugin-api` and `plugin-sdk`, synced from here: this repo is the source of truth, and a contract change is committed here first.
- **Times** are integer milliseconds in SOURCE time; positions are fractions 0..1 of the frame. Every contract field says its unit in a comment.
- **Errors teach.** A plugin fails with `PluginFailure(code, oneLineMessage, oneLineFix)`; the SDK, the CLI and `testPlugin()` print a fix for every failed check. Add an error code to `packages/plugin-api/src/errors.ts` rather than inventing one in a plugin.
- **stdout is MCP.** Nothing but the protocol goes there; plugins log with `ctx.log()` (stderr).
- **Plugins stand alone.** A plugin imports only `@cutpilot/plugin-sdk`, `@cutpilot/plugin-api` and its own npm dependencies: never another plugin, never `../`. Nothing in `packages/` imports a plugin.

## Commands

Node ≥ 22, pnpm (see `packageManager`). The workspace sets a minimum release age, so `pnpm install` refuses a dependency version published in the last day: pick an older one rather than fighting it.

| Command | What |
| --- | --- |
| `pnpm install` | install |
| `pnpm build` | `tsc -b`; needed before the SDK harness tests, `cutpilot-plugin`, `pnpm bundle` |
| `pnpm check` | typecheck + lint + **format:check** + dependency rules + tests — **must pass before you say you're done**; run `pnpm format` first or it fails on whitespace |
| `pnpm vitest run <path>` | one suite (`plugins/<name>`, `packages/plugin-sdk`) |
| `pnpm cutpilot-plugin new <id> --kind <kind> --dir <dir>` | a new plugin that passes its tests from the start (`tools`, `transcriber`, `reframe-track`, `music`, `sound`, `generator`) |
| `pnpm cutpilot-plugin validate <dir>` / `test <dir>` | the manifest, icon and command; then start it as CutPilot does and call its tools |
| `pnpm bundle plugins/<name> [--out build/<id>-<version>]` | a plugin as a folder that stands alone, for a copied install or the store |

Tests that need the network, a model, Chrome or an API key sit behind `skipIf(!process.env.<NAME>_E2E)` or a tool check, so `pnpm check` passes on CI (macOS and Ubuntu, no network, no keys); cloud providers are tested against recorded responses.

## Layout

```
packages/
  plugin-api/    manifest schema, the tool contract of each kind (KIND_TOOLS), error codes, registry format, semver. zod only.
  plugin-sdk/    definePlugin(), testPlugin(), validatePluginFolder(), scaffoldPlugin(), the cutpilot-plugin CLI;
                 examples/hello (the smallest plugin), template/ (what `new` copies), fixtures/ (plugins the tests check against)
plugins/         first-party plugins, one folder each (see plugins/README.md); built like a third party's
examples/        a plugin in Python, run with uv
scripts/         bundle-plugin.mjs
docs/            the plugin guide, publishing the SDK
.agents/skills/  skills (Agent Skills format), shared by all coding agents; .claude/skills links to them
```

## Skills

Read the matching one before starting. If your agent does not load skills automatically, open the `SKILL.md` directly.

| Skill | Use when |
| --- | --- |
| `cutpilot-plugin` | writing, changing, testing, bundling or installing a plugin in `plugins/`; the manifest, kinds, handlers, `testPlugin` |
| `cutpilot-plugin-licensing` | a plugin that uses anything not free for everyone (a metered API, a licensed library such as Remotion, a model or asset with terms): the user brings their own key or licence; what to declare, write and test |

Changing the contract itself, publishing a plugin to the store and anything about the app are done from the app repo (its skills `cutpilot-plugin-contract`, `cutpilot-plugin-publish`, `cutpilot-workspace`).

## Git

Work on `main` (there is no `dev` branch). One commit per task when it is implemented and verified (`pnpm build && pnpm format && pnpm check` green); checkpoints as you go only on a feature branch. Subject: `P3-030: <what changed>` when a task in the app repo drives it, else a plain imperative subject (`Bundle a plugin into a folder that stands alone (pnpm bundle)`); body in prose: what a user or plugin author can now do, decisions a reviewer wouldn't guess, tests. **No `Co-Authored-By:` or other AI attribution line**, even if your client adds one by default. Pushing, merging, PRs and `npm publish` only when the user asks. Don't commit `dist/`, `build/` or `node_modules/`.

Client-specific: Claude Code finds the skills through `.claude/skills` (links), and a `.claude` settings file there may carry hooks that enforce the commit and push rules, format edited files with prettier, and print the branch and status at session start; other clients follow the same rules by reading this file.
