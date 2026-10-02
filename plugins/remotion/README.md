# Remotion

Scenes for a CutPilot edit written in React by your AI, with **your own** [Remotion](https://www.remotion.dev) project on your Mac: an ad, a kinetic-type intro, an animated chart, a lower third. The AI writes the scene, checks it, previews frames and looks at them, fixes what it sees, and then puts the scene in the edit. CutPilot adds it to the timeline as an **insert**, an undoable edit like any other. Your video is never touched.

## Licence: bring your own Remotion

> This plugin uses your own installation of Remotion, which is licensed separately by Remotion AG. CutPilot does not include or license Remotion. You are responsible for complying with Remotion’s license: it’s free for individuals and companies of up to 3 people; larger companies need a Remotion Company License — remotion.pro.

What that means in practice:

- **You are Remotion's licensee, not CutPilot.** CutPilot doesn't provide, resell or cover a Remotion licence. Read [Remotion's licence](https://www.remotion.dev/docs/license) to see which one applies to you.
- **Nothing runs until you enter your licence key** in CutPilot → Plugins → Remotion → **Keys**, as `REMOTION_LICENSE_KEY` (CutPilot keeps it in the macOS Keychain and never shows it again):
  - `free-license` if you qualify for the free licence (an individual, a company of up to 3 people, or a non-profit);
  - your Company License key from [remotion.pro](https://www.remotion.pro) otherwise.

  Only you can enter it; your AI can't. Until you do, every tool refuses and shows the notice above.
- **The key goes to Remotion and nowhere else.** The plugin passes it to Remotion's renderer as [`licenseKey`](https://www.remotion.dev/docs/licensing), which is how Remotion asks to be told. For each successful render Remotion sends a usage event to remotion.pro (the key, the IP address, whether it was a video or a still, and whether it was a production render). It sends no video, no code and no project data. Previews and checks are marked as development renders (`isProduction: false`), which Remotion doesn't bill. `render` and `add_insert` are production renders.
- **Remotion is not part of this plugin.** It has no Remotion in its dependencies and none in its bundle. It loads Remotion only from your project, with `createRequire(<project>/package.json)`, so the Remotion that runs is the one you installed. A test (`src/no-bundled-remotion.test.ts`) fails the build if Remotion ever gets into the plugin's dependencies, sources or bundle.
- **Your code stays on your Mac.** Scenes are written to, bundled from and rendered in your project folder, on your machine. Nothing is uploaded, synced or rendered anywhere else: there's no cloud or Lambda rendering.
- **CutPilot keeps a record of each acceptance.** The first time your key is used with a project, or with a new Remotion version, CutPilot records when, which project, which Remotion version and which kind of licence (never the key). The answer then carries the notice for your AI to show you. The record is kept in `~/Library/Application Support/CutPilot/plugin-remotion/acceptances.json` on macOS.

## Set up

1. **Node.js 20+** (`brew install node`), which Remotion needs to install.
2. **A Remotion project.** Either use one you have, or ask your AI to make one: *"Create a Remotion project in ~/Videos/remotion-scenes"*. It runs Remotion's own scaffolder on your Mac (`npx create-video@latest --yes --blank --no-tailwind`), then `npm i`, then adds `@remotion/renderer` and `@remotion/bundler` at the project's Remotion version.
3. In CutPilot → Plugins → Remotion: under **Keys**, enter your licence key (see above) and **Save**; under **Settings**, **Choose…** the project folder for **Remotion project folder**.
4. Ask your AI to run `remotion__status`. It should say `ok: true` and list your Remotion versions.

What the project needs:

- `remotion`, `@remotion/renderer` and `@remotion/bundler` installed, **all at the same version** (Remotion requires it).
- Remotion **4.0.409 or later** (the first version with `licenseKey`), and **4.x only**. Remotion 5 will change the APIs this plugin calls; the plugin says so and refuses rather than guessing.
- On first render, Remotion downloads its Chrome Headless Shell once (about 100 MB), with progress. The download comes from the hosts in the manifest's `network` list.

## Tools

AI clients see these as `remotion__<tool>`.

| Tool | Takes | Gives |
| --- | --- | --- |
| `status` | — | linked?, project folder, Remotion versions, licence state, scenes (size, fps, frames, length, default props), the Root patch state, the last errors |
| `guide` | — | the authoring rules: determinism, assets, props, sizes, a minimal scene |
| `create_project` | `dir` (a new folder the user chose) | a blank Remotion project, made on the user's machine; the user then links it |
| `create_scene` | `id`, `code`, `durationInFrames`, `fps`, `width`, `height`, `defaultProps?` | the file written, and `check`: TypeScript, then bundle and `selectComposition`, errors verbatim |
| `update_scene` | `id` and any of `code`, `durationInFrames`, `fps`, `width`, `height`, `defaultProps` | the same as `create_scene` |
| `delete_scene` | `id` | `ok` |
| `preview_frame` | `id`, `frame`, `props?`, `scale?` (default 0.5) | a **PNG image** for the AI to look at, plus the frame, its time and the size |
| `render` | `id`, `props?`, `codec?` (`h264`/`prores`), `proresProfile?`, `transparent?`, `frameRange?` | the path of a new file in `<project>/out/cutpilot/` (never overwritten) |

Because it is a `generator` plugin, it also offers the contract tools that CutPilot's own `list_templates` and `add_insert` call. Every scene is a template:
- `add_insert { template: "<scene id>", params: { …props }, at }` renders the scene **at the timeline's size, frame rate and length** and puts the clip in the edit.
- CutPilot copies the clip into its project. This is the same path html-motion's title cards take, and it's how a scene gets onto the timeline.

`render` is for when you want a file instead:
- an H.264 MP4 to share;
- with `transparent: true`, a **ProRes 4444 .mov with alpha** for overlays in another editor. CutPilot's inserts play *between* two moments of the source; it can't lay a clip *over* the footage yet.

The workflow the tool descriptions teach: `create_scene` → `preview_frame` at several frames, and actually look → `update_scene` to fix → `add_insert` (or `render`).

## Example

> Make a 10 s 9:16 ad with the headline "Just got safer", lime accents, bouncy icon pop-ins; preview, fix, render, put it on the timeline.

The AI calls these in order:
1. `remotion__guide` and `remotion__status`.
2. `remotion__create_scene { id: "safer-ad", durationInFrames: 300, fps: 30, width: 1080, height: 1920, defaultProps: { headline: "Just got safer", accent: "#C6FF00" }, code }`.
3. `remotion__preview_frame` at frames 0, 20, 45, 150 and 299. It looks at each one, fixes overlaps with `update_scene`, and previews again.
4. `add_insert { template: "safer-ad", at: "start" }`.

## Where things go in your project

```
<project>/
  src/
    Root.tsx                 + <CutPilotCompositions /> and its import (once, with a backup)
    cutpilot/
      <scene id>.tsx         a scene: your AI's code, then `export const cutpilotScene = {…}` (its size, fps, length, default props)
      index.tsx              owned by the plugin, rewritten on every change: registers each scene as <Composition id="cutpilot-<id>" …/>
      backups/               the Root file as it was before the patch
  out/cutpilot/              files made by `render` (out/ is in the template's .gitignore)
```

- **Scenes appear in Remotion Studio too**, as `cutpilot-<id>`, so you can open them in `npm run dev`.
- **The plugin never touches your other files or compositions.**
- **Scene ids** match `^[a-z0-9-]{1,64}$`. Because every scene is also a template id, they must also be kebab-case, start with a letter and be at most 40 characters. Anything that could leave `src/cutpilot` is refused.
- **The Root patch** happens on the first `create_scene`. It finds the entry point in this order:
  1. `Config.setEntryPoint` in `remotion.config.ts`;
  2. a `remotion studio|render|bundle <file>` script in `package.json`;
  3. Remotion's defaults (`src/index.ts`, …).

  From there it follows `registerRoot(X)` to the file that defines `X`, then adds `<CutPilotCompositions />` before the closing `</>` of the fragment that component returns, plus the import, in the file's own quote style. It makes a backup first, and the AI gets the diff to show you.
- **If the patch isn't safe, nothing is written.** That happens when there's no fragment, more than one fragment, or no `registerRoot` of a local file. The AI then gets the two lines for you to add yourself.

## How it works

- **The check after each write.**
  1. The project's own TypeScript runs with the project's own `tsconfig.json`, over the scene and `index.tsx`. Only errors in `src/cutpilot` are reported, exactly as `tsc` prints them; your other files are your business.
  2. If that passes, Remotion's bundler bundles the project and `selectComposition` loads the scene, which is what a render does.

  Bundler and runtime errors also come back verbatim, so the AI can fix its own code.
- **The bundle is cached.** It is rebuilt only when a file in `src/` or `public/` changes (by size and mtime), and it is kept in the temp folder with its fingerprint, so a restart reuses it. Previews after the first cost one Chrome frame, not a webpack run.
- **Renders.** `renderMedia` runs with the scene's composition. For `add_insert`, the composition's width, height, fps and length are those of the timeline, so a scene should lay itself out from `useVideoConfig()`. Progress is reported throughout, so long renders aren't timed out. Cancelling in CutPilot cancels Remotion's render (`makeCancelSignal`) and removes the partial file.
- **Off the main thread.** The plugin is its own process, which CutPilot starts next to its engine, so bundling and rendering never run on the app's main thread. Remotion starts Chrome and its compositor as further processes. Remotion jobs run one at a time, because each one uses every core.
- **Clips for `add_insert`** are kept in the temp folder, named by a hash of everything that affects the picture, so asking again for the same clip doesn't render it again.
- **Third-party plugins can't use it.** Plugins can't call each other, and this one renders only from the folder the user set; no tool takes a project path to render from.

## Not in this version

- No Remotion Studio or Player inside CutPilot, and no cloud or Lambda rendering.
- `remotion.config.ts` overrides (a custom webpack config, Tailwind) aren't applied: Remotion's Node APIs don't read that file. New projects are made without Tailwind for that reason.
- CutPilot can't yet place a transparent overlay over the footage; `render { transparent: true }` makes the file for use elsewhere.
- The app shows no "I understand / Cancel" dialog before first use yet. Entering the key is the act of acceptance, and the notice comes with every refusal and with the first answer for each project and Remotion version.
- It needs CutPilot 0.2.0-beta.10 or later: the first version that passes a plugin its settings and keys. Older versions list it as needing a newer CutPilot.

## Develop

```sh
pnpm build
pnpm vitest run plugins/remotion                 # unit tests and the no-bundled-Remotion check; Remotion is a stand-in
REMOTION_E2E=1 pnpm vitest run plugins/remotion/src/e2e.test.ts
                                                 # with a real Remotion: makes a project (needs npm and the internet),
                                                 # creates a scene, previews frame 0, renders 1 s of H.264 and ProRes 4444,
                                                 # checks them with ffprobe, then runs the plugin as CutPilot starts it
REMOTION_PROJECT=/path/to/scratch-project pnpm vitest run plugins/remotion/src/e2e.test.ts
                                                 # the same, against a project you already have (it writes a scene there)
cutpilot plugin install plugins/remotion --link
pnpm bundle plugins/remotion                     # → build/remotion, for a copied install or the store
```

The unit tests run against a project folder whose `node_modules` holds stand-ins for `remotion`, `@remotion/renderer` and `@remotion/bundler` (`src/test-helpers/fake-project.ts`). They record what they're asked to do, so the whole tool flow is tested without Remotion or Chrome, and they show that Remotion is loaded from the project and not from the plugin. This repo never installs Remotion; the few Remotion types the plugin uses are written out in `src/remotion.ts`.
