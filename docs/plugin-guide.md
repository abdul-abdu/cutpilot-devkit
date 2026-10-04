# Build a NodCut plugin

This page takes you from nothing to a plugin that NodCut runs and your AI calls, in about half an hour. You need Node.js 22 or newer and, to try the plugin in the app, NodCut itself.

- [What a plugin can do](#what-a-plugin-can-do)
- [Walkthrough: a `suggest_titles` tool](#walkthrough-a-suggest_titles-tool)
- [The manifest](#the-manifest)
- [Permissions, secrets and settings](#permissions-secrets-and-settings)
- [Writing handlers](#writing-handlers)
- [Testing](#testing)
- [Installing and sharing](#installing-and-sharing)
- [Other languages](#other-languages)
- [Troubleshooting](#troubleshooting)

## What a plugin can do

A plugin is a folder with a `nodcut-plugin.json` manifest and a command that starts an [MCP](https://modelcontextprotocol.io) server on stdin/stdout. NodCut's engine starts it the first time it's needed, calls its tools, checks what comes back and applies it as an ordinary edit, which the user can undo like any other. Plugins return data or files; they never change the timeline themselves.

A plugin offers either or both of:

**Kinds.** A kind is a capability NodCut already knows how to use. Declaring one in the manifest means offering that kind's tools, with the inputs and outputs fixed by `@nodcut/plugin-api`. Your AI doesn't call these tools directly: it uses NodCut's own tools (opening a project, reframing, adding music…) and NodCut calls your plugin.

| Kind | `--kind` for `new` | Tools | What NodCut does with it |
| --- | --- | --- | --- |
| `transcriber` | `transcriber` | `transcribe` | Speech to timed words, for cutting and captions (`open_project` with `transcriber: "<id>"`). |
| `analyzer:reframe-track` | `reframe-track` | `reframe_track` | Where a vertical (or other) crop looks over time, e.g. following the speaker. |
| `asset:music` | `music` | `find_music`, `get_music` | Background music, mixed under the speech. |
| `asset:sound` | `sound` | `list_voices`, `generate_sound` | Sound effects, music or speech made from a description. |
| `generator` | `generator` | `list_templates`, `generate` | Clips from templates (title cards, chapter headings, end cards) at the edit's size, inserted into the timeline. |

**Language packs.** A plugin of kind `language` translates NodCut's interface. It has no command and no tools: NodCut reads its files and never starts it. See [Language packs](#language-packs).

**Extra tools.** Any read-only tool you like: title ideas, chapter markers, a word count. NodCut passes them on to the AI clients connected to it as `<plugin id>__<tool name>`, and passes their results back unchanged. Names are snake_case, and `<id>__<tool>` must fit in 64 characters. A plugin with no kinds and one extra tool is the simplest kind of plugin there is.

## Walkthrough: a `suggest_titles` tool

You'll make a plugin with one tool, `suggest_titles`, that gives an AI title ideas from a video's transcript, then add an option to it, test it, and install it.

### 1. Create the plugin

```sh
npx -p @nodcut/plugin-sdk nodcut-plugin new my-titles
```

(Inside NodCut's command line, `nodcut plugin new my-titles` does the same.)

> **Until the SDK is on npm**, use a checkout of this repository instead. In the checkout run `pnpm install && pnpm build`, then, from the folder where you want the plugin:
>
> ```sh
> node ~/nodcut-devkit/packages/plugin-sdk/dist/bin.js new my-titles --sdk file:$HOME/nodcut-devkit/packages/plugin-sdk
> ```
>
> `--sdk` makes the new plugin depend on your checkout instead of the npm release. Use the path of your checkout.

This writes `my-titles/` and prints what it wrote:

```
my-titles/
  nodcut-plugin.json   the manifest: id, name, version, kinds, permissions, settings
  package.json           depends on @nodcut/plugin-sdk; build and test scripts
  tsconfig.json          standalone; compiles src/ to dist/
  src/index.ts           starts the plugin: definePlugin(plugin).start()
  src/plugin.ts          the tool itself, with placeholder logic
  src/index.test.ts      runs testPlugin() and a unit test
  AGENTS.md              the rules for a coding agent working in the folder
  README.md, .gitignore
```

`--kind` picks another starting point (`transcriber`, `reframe-track`, `music`, `sound`, `generator`); the default, `tools`, is an extra tool. Every kind starts with small placeholder logic that already passes its tests.

### 2. Build and test it

```sh
cd my-titles
npm install
npm test
```

`npm test` compiles `src/` to `dist/` and runs the tests, which include `testPlugin()`: it starts `node dist/index.js` the way NodCut does and checks the manifest and the tools it offers.

### 3. Make it yours

Open `src/plugin.ts`. `suggestTitles()` is plain TypeScript; the `plugin` object below it describes the tool to the AI. Add a `maxLength` option so the AI can ask for titles that fit a platform's limit.

Give `suggestTitles` the option and apply it to the result:

```ts
export function suggestTitles(transcript: string, count = 5, maxLength = 100): string[] {
  // …
  return ideas.filter((t) => t.length <= maxLength).slice(0, count);
}
```

Declare it in the tool's input and pass it on:

```ts
      input: {
        transcript: z.string().min(1).describe('what is said in the video, as plain text'),
        count: z.number().int().min(1).max(6).optional().describe('how many titles (default 5)'),
        maxLength: z.number().int().min(10).optional().describe('the longest a title may be, in characters'),
      },
      handler: ({ transcript, count, maxLength }) => ({
        titles: suggestTitles(transcript, count, maxLength),
      }),
```

The input is a [zod](https://zod.dev) shape. `defineTool()` types the handler's arguments from it, and the SDK checks every call against it before your handler runs. The `.describe()` texts are what the AI reads, so write them for it.

Add a test to `src/index.test.ts`:

```ts
test('maxLength keeps titles short', () => {
  expect(suggestTitles('Grinders, grinders and coffee.', 6, 20)).toEqual(['Grinders vs coffee']);
});
```

and run the tests again:

```sh
npm test
npx nodcut-plugin test .
```

```
✓ manifest — my-titles 0.1.0
✓ starts and answers
✓ extra tool suggest_titles
my-titles: all checks passed
```

### 4. Use it in NodCut

```sh
nodcut plugin install . --link
nodcut plugin list
```

`--link` installs the folder where it is, so NodCut runs whatever is in `dist/` when it starts the plugin. A plugin that is already running keeps its old code until NodCut stops it after five idle minutes; `nodcut engine stop` picks up a new build at once (the engine starts again when the app or an AI client connects). Installing approves what the manifest asks for now; if a later build asks for more (a new host, a secret), NodCut won't start it until you approve that in its Plugins screen.

Then ask your AI something like "suggest five titles for this video, at most 60 characters": it fetches the transcript and calls `my-titles__suggest_titles`.

The `nodcut` command comes with the NodCut app; everything before this step works without it.

## The manifest

`nodcut-plugin.json`, at the root of the plugin folder. `@nodcut/plugin-api` has the full schema (`ManifestSchema`), and `nodcut-plugin validate` checks it.

| Field | |
| --- | --- |
| `id` | kebab-case, at most 40 characters: `my-titles`. Never changes once published. |
| `name`, `description` | shown in NodCut's Plugins screen (at most 60 and 300 characters). |
| `version` | semver, like `0.1.0`. |
| `publisher`, `homepage` | optional. |
| `icon` | optional: a PNG in the folder, square, 32 to 256 px, at most 64 KB. |
| `contract` | the plugin contract version, `1`. NodCut refuses a plugin that speaks another. |
| `nodcut` | the NodCut versions it works with, as a semver range: `>=0.2.0-beta.10`. |
| `command`, `args` | how to start it, run in the plugin folder. `node` means NodCut's own Node.js; another bare name (`uv`, `python3`) is looked up on PATH; a path is relative to the folder and stays inside it. |
| `kinds` | the kinds it implements; empty for extra tools only. |
| `permissions` | what it may access (below). |
| `settings` | what the user can set (below). |

## Permissions, secrets and settings

NodCut shows a plugin's permissions when it's installed and the user approves them; a new version that asks for more is approved again. The engine only gives a plugin what it declared.

```json
"permissions": {
  "network": ["api.example.com"],
  "secrets": ["EXAMPLE_API_KEY"],
  "reads": ["audio"]
}
```

- **`network`**: the hosts it talks to (`api.example.com`, `*.example.com`). Empty means it works offline, and users see that.
- **`secrets`**: API keys and the like, named in capitals. The user enters them in NodCut → Plugins → your plugin (they're kept in the system keychain) and the plugin gets each one as an environment variable, `NODCUT_SECRET_<NAME>`. In a handler, `ctx.secret('EXAMPLE_API_KEY')` returns it or `undefined`, and `ctx.requireSecret('EXAMPLE_API_KEY')` returns it or fails with a message telling the user where to enter it.
- **`reads`**: which of the user's media it is handed: `source` (the original video), `audio` (a 16 kHz mono wav), `frames`. A kind's own needs are required: a transcriber must list `audio`, a reframe analyzer `source`.

Settings are what the user can change in the plugin's page in NodCut:

```json
"settings": [
  { "key": "tone", "label": "Tone of the titles", "type": "choice", "choices": ["plain", "catchy"], "default": "plain" }
]
```

Types are `string`, `number`, `boolean`, `choice` (with `choices`) and `folder` (a string holding an absolute path; NodCut offers a folder picker). The plugin gets each as `NODCUT_SETTING_<KEY IN UPPER SNAKE CASE>` (`tone` → `NODCUT_SETTING_TONE`); in a handler, `ctx.settings.tone` already holds the value, or the default.

A plugin starts with nothing else from the user's environment: just `PATH`, `HOME`, `LANG`, `TMPDIR`, and what it declared.

## Writing handlers

`definePlugin()` takes a handler for each tool of the declared kinds (`transcribe`, `reframeTrack`, `findMusic` and `getMusic`, `listTemplates` and `generate`, `listVoices` and `generateSound`) and any extra `tools`. It refuses to start when a declared kind is missing a handler, or a handler has no kind in the manifest. Each handler gets its checked input and a context:

| `ctx.` | |
| --- | --- |
| `manifest` | the parsed manifest |
| `settings`, `secret()`, `requireSecret()` | see above |
| `progress(fraction, message?)` | report progress, 0 to 1, for long calls |
| `signal` | aborted when NodCut cancels the call; pass it to `fetch` or child processes |
| `log(message)` | a line in NodCut's log for the plugin (stderr). Never write to stdout: it carries MCP. |

What a kind's handler returns is checked against its contract before it leaves the plugin; a wrong answer becomes an `E_PLUGIN_CONTRACT` error naming the field. An extra tool returns a string (text), an object (structured data, and JSON text), or a `ToolContent` of MCP content blocks, e.g. `new ToolContent([imageBlock(png, 'image/png')])` for an image the AI looks at.

To fail in a way the user or their AI can act on, throw a `PluginFailure` with a code, a one-line message and a one-line fix:

```ts
throw new PluginFailure('E_TITLES_TOO_SHORT', 'the transcript has no words', 'transcribe the video first');
```

Anything else that's thrown becomes `E_PLUGIN_FAILED`, with the stack in the log.

## Testing

Two commands come with the SDK (`npx nodcut-plugin …` in a plugin that depends on it):

```sh
npx nodcut-plugin validate .   # the manifest, its icon and its command, without starting anything
npx nodcut-plugin test .       # start it the way NodCut does and call its tools
```

Each prints one line per check, `✓` passed, `✗` failed with the fix under it, `–` skipped, and exits with 1 when a check failed. `--json` prints the report as JSON. NodCut's own `nodcut plugin validate` and `nodcut plugin test` run the same checks.

`test` starts the plugin with the same minimal environment NodCut gives it, checks that it offers its kinds' tools and that its extra tools' names will work, and calls each contract tool once with a small input:

| Kind | What `test` sends | Options |
| --- | --- | --- |
| transcriber | a second of silence, language `en` | `--audio file.wav --language uz` |
| reframe-track | your video, aspect 9:16, the first 3 s; skipped without one | `--video clip.mp4` |
| music | `find_music` with no filter, then `get_music` of the first track; the file must exist | |
| sound | `list_voices`; `generate_sound` only when asked; the file must exist | `--sound '{"kind":"sfx","prompt":"a door creaks"}'` |
| generator | `list_templates`, then the first template with its example at a small size, at most 2 s; the clip must exist at the size asked | `--templates all` or `none` |

Calls are skipped when the plugin declares secrets and they aren't given: pass `--secret NAME=value`, or `--secret NAME` to take it from your environment. `--setting key=value` sets a setting.

In code, the same checks are `validatePluginFolder(dir)` and `await testPlugin(dir, options)`, and `formatReport(report)` prints either. The generated `src/index.test.ts` runs `testPlugin()` under [vitest](https://vitest.dev); add unit tests for your own logic next to it.

## Installing and sharing

All of these are NodCut app commands (`nodcut plugin …`):

| | |
| --- | --- |
| `nodcut plugin install <folder> --link` | Install the folder where it is, for development. |
| `nodcut plugin install <folder>` | Install a copy of the folder. |
| `nodcut plugin pack [folder] [-o file]` | Pack the folder into `<id>-<version>.nodcut-plugin`, a zip with the manifest at its root. |
| `nodcut plugin install <file>.nodcut-plugin` | Install a package. In the app: Plugins → Install from file…, or drop the file on the window. |
| `nodcut plugin list` / `remove <id>` | See what's installed, and its problems; uninstall. |

A package holds the folder as it is, minus dot files and folders, source maps and earlier packages, and it can't contain links. So before packing a Node plugin, build it and keep only what it runs on:

```sh
npm run build
npm prune --omit=dev
nodcut plugin pack
```

Build against an SDK from npm (or a tarball) before packing: a `file:` SDK is a link. The MCP SDK's dependencies make `node_modules` about 30 MB; bundling `dist/index.js` with a bundler such as esbuild removes the need for it (`scripts/bundle-plugin.mjs` in this repository shows the settings the MCP SDK needs).

Users install plugins from NodCut's plugin store too; listing a plugin there is described separately.

## Other languages

Anything that speaks MCP on stdio works. [`examples/python-plugin`](../examples/python-plugin) is a plugin in Python with the official MCP Python SDK, started with `"command": "uv", "args": ["run", "--quiet", "--frozen", "server.py"]`, and it passes the same checks:

```sh
pnpm nodcut-plugin test examples/python-plugin
```

Without the TypeScript SDK, two things are yours to do: answer a kind's tools exactly as its contract in `@nodcut/plugin-api` says, and report a failure as a tool error whose structured content is `{ "error": { "code", "message", "fix" } }`.

## Language packs

A language pack translates NodCut's interface: every screen and message, and the menu bar. It is data only: a manifest and JSON files, no command, no permissions, no settings. NodCut reads it when it's installed and never starts it. [`plugins/language-ru`](../plugins/language-ru) and [`plugins/language-uz`](../plugins/language-uz) are complete ones.

```json
{
  "id": "language-de",
  "name": "Deutsch — German",
  "version": "1.0.0",
  "description": "NodCut's interface and menus in German.",
  "contract": 1,
  "nodcut": ">=0.2.0-beta.15",
  "kinds": ["language"],
  "languages": [{ "code": "de", "name": "Deutsch", "messages": "de.json", "menu": "de.menu.json" }]
}
```

- `code` is a language code (`de`, `pt-BR`, `uz-Cyrl`); `name` is the language's name in itself, shown in **Settings ▸ General ▸ Interface language**. A pack may hold up to 20 languages.
- `messages` is the window's strings, keyed by the English text: `"Export…": "Exportieren…"`. `{name}` placeholders are filled in by NodCut, so keep each one. A count is keyed by its English singular, with a form per [plural category](https://cldr.unicode.org/index/cldr-spec/plural-rules) of your language (`other` is required); its forms may leave out `{n}` ("one minute") or use it where the English key doesn't:
  ```json
  { "{n} change": { "one": "{n} Änderung", "other": "{n} Änderungen" } }
  ```
  A key may start with a context, `workspace|Review`, where one English word needs two translations; English shows the part after the bar.
- `menu` (optional) is the menu bar's labels, `"File": "Ablage"`, the standard items (`Copy`, `Quit NodCut`) included. Without it the menus stay English.
- A catalogue is at most 2 MB. A string the pack doesn't have shows in English.

[`strings/strings.json`](../strings/strings.json) lists every string the latest NodCut shows. Check a pack against it:

```sh
pnpm nodcut-plugin validate plugins/language-de --strings strings/strings.json
```

The check reads and judges the catalogues the way NodCut does (a broken file, or a form that drops a placeholder, keeps the whole pack from loading) and names what's missing. `pnpm bundle plugins/language-de` copies the files into a package folder; there is nothing to build. `nodcut-plugin new` doesn't make language packs yet: copy one of the two above.

## Troubleshooting

| What you see | What to do |
| --- | --- |
| `✗ command — dist/index.js doesn't exist` | Build the plugin: `npm run build`. |
| `✗ starts and answers` | Run the command it shows, in the plugin folder, and fix what it prints. A plugin that writes anything but MCP to stdout breaks the connection: log with `ctx.log` (stderr). |
| `✗ manifest — permissions.reads: a transcriber plugin needs "audio"…` | Add what the kind needs to `permissions.reads`. Every manifest problem is named by its field. |
| `✗ … answers per contract — E_PLUGIN_CONTRACT: …` | Your handler returned something its contract doesn't allow; the message names the field (e.g. words out of time order). |
| `this plugin can't start: kind transcriber needs a transcribe handler` (in the log) | The manifest's `kinds` and the handlers passed to `definePlugin()` disagree. |
| `– … needs EXAMPLE_API_KEY` | Pass the secret to `test`: `--secret EXAMPLE_API_KEY`. |
| `– command — uv isn't on PATH here` | Install the program, and say in your README that users need it. NodCut also looks in the usual package-manager folders (Homebrew's among them), since an app started from the Dock gets a short PATH. |
| `npm install` fails on `@nodcut/plugin-sdk` | Until the SDK is on npm, point the dependency at a checkout: `--sdk file:/path/to/nodcut-devkit/packages/plugin-sdk` when creating the plugin, or edit `package.json`. |
| The AI doesn't see your extra tool | `nodcut plugin list` shows whether the plugin is installed, switched on and approved, and its tools. Your AI client may need to reconnect to NodCut to see new tools. |
| `nodcut plugin pack`: links can't go in a plugin package | Replace the `file:` SDK with one from npm or a tarball, then `npm prune --omit=dev`. |
