---
name: nodcut-plugin-licensing
description: Bring-your-own-licence rule for NodCut plugins — when a plugin uses anything that is not free for everyone (a metered API such as ElevenLabs or OpenAI, a library with a commercial licence such as Remotion, a model or asset library with usage terms, a CLI or font that must be bought), the user brings and pays for their own key, licence or download; NodCut never bundles, resells, proxies or hides it. Use when adding or reviewing a plugin that talks to a paid service, depends on a licensed library, downloads a model or asset with terms, or when a task mentions API keys, licence keys, pricing, quotas, credits, "free for individuals", attribution or redistribution.
---

# Plugins and paid things: the user brings their own

NodCut's plugins are MIT, but what a plugin **uses** often is not: a metered API, a library licensed per company, a model with a community licence, a sound library that wants a credit line. The rule for every plugin in this repo, first-party or not:

> **If it is not free for everyone, the user brings their own.** Their own API key, their own licence key, their own installation, their own agreement to the terms. NodCut and the plugin never provide, resell, proxy, bundle, trial or hide the paid thing, and never pretend it is included.

Why: the plugin can stay MIT and public; NodCut is not a party to the user's contract with the provider; no key or licence of ours is ever in a bundle a user can unpack; and the user sees what each feature costs and where the money goes. The code examples are `plugins/remotion` (a licensed library), `plugins/cloud-transcribe` (metered APIs) and `plugins/sound` (models with terms).

## 1. Decide what the plugin depends on

Before writing the manifest, list everything the plugin needs that it does not contain, and classify each:

| It needs… | Example | Pattern |
| --- | --- | --- |
| a service billed per use, behind an API key | ElevenLabs, OpenAI, a stock-footage API | **key** (§2) |
| a library or tool with a licence that depends on who the user is | Remotion (free up to 3 people, else a Company License), a commercial font or codec SDK | **licence** (§3) |
| a model or dataset with usage terms, downloaded at first use | Stable Audio (Community License), Supertonic (OpenRAIL-M) | **terms** (§4) |
| assets the plugin itself ships or serves | a music library, templates, sounds | **redistributable only** (§5) |
| nothing of the above | pure code, a local algorithm | free: declare no secrets, no network, say "works offline" |

"Free for us" is not "free for everyone": a licence that is free for individuals but paid for companies is a **licence** case, and the plugin cannot know which the user is. Treat a free tier, a trial, student pricing or "free while in beta" the same way: it is the user's account and the user's tier.

## 2. Pattern: a metered API (bring your own key)

- `permissions.secrets` names the key in UPPER_SNAKE (`ELEVENLABS_API_KEY`); `permissions.network` lists exactly the hosts it calls. The user enters the key in NodCut → Plugins → the plugin → Keys; the plugin reads it with `ctx.requireSecret()`, which fails with `E_PLUGIN_NEEDS_SECRET` and says where to enter it. Never read `process.env.OPENAI_API_KEY` or a dotfile: the engine passes only declared secrets, and that is the point.
- **The key goes to the provider and nowhere else.** No proxy through a NodCut server, no "we'll call it for you", no telemetry carrying the key. Say so in the README.
- **Say what leaves the computer** (`plugins/cloud-transcribe/README.md`: "Your audio leaves your computer and goes to the provider you chose, under that provider's terms") and which local alternative exists.
- **Offer a `test_key` tool** that checks the key with a request that uploads nothing and costs nothing (`plugins/cloud-transcribe/src/plugin.ts`); the app's Keys panel has a "Test key" button for it.
- **Money errors teach.** Map the provider's billing answers to their own codes with a fix the user can act on: a bad key (`E_<X>_BAD_KEY`: check it, make a new one), out of credits (`E_<X>_QUOTA`: add credits, or switch provider), rate limits (wait). Never retry a paid call in a loop; never silently fall back to another paid provider the user did not choose.
- **Spend only what was asked.** One request per call, the smallest model or quality the input needs, nothing speculative, nothing in the background. If a call can be expensive (a long file, a high-resolution render), the tool description says so, so the AI can warn the user.
- **Tests never need a key**: recorded responses in `fixtures/`, a local HTTP stub, and `testPlugin()` with `secrets` only against the stub. Real calls sit behind `skipIf(!process.env.<NAME>_E2E)`.

## 3. Pattern: a licensed library or tool (bring your own licence)

`plugins/remotion` is the model; copy its shape rather than inventing one.

- **The plugin does not contain the thing.** It is not in `dependencies`, `peerDependencies`, `optionalDependencies` or the bundle. The plugin loads it from where the user installed it (Remotion: `createRequire(<project>/package.json)`) and refuses, with a fix, when it is not there or the version is unsupported. Type imports are fine (they are erased); write out the few types you need (`plugins/remotion/src/remotion.ts`) rather than depending on the package.
- **A guard test makes that permanent**: `plugins/remotion/src/no-bundled-remotion.test.ts` fails `pnpm check` if the library gets into the dependencies, a value import, the esbuild graph or the `pnpm bundle` output. Write the same test for your library, naming its packages.
- **The licence key is a secret** (`REMOTION_LICENSE_KEY`), entered by the user, never by the AI. If the licensor has a free tier that needs no key, let the user declare it with a fixed word (`free-license`), so entering it is the act of acceptance and the plugin can tell the two kinds apart. The key is passed to the library the way the licensor asks (`licenseKey`) and nowhere else.
- **Nothing runs without it.** Every tool, including `status`-like ones that would merely read, calls the licence check first (`plugins/remotion/src/license.ts`, `licenseKey(ctx)`); the failure carries the licensor's own notice and the fix. Explain what the library reports to its vendor (Remotion sends a usage event per production render) and what it does not send.
- **A notice the AI shows the user**, one paragraph, in the licensor's words where they publish them, saying: this plugin uses your own installation of X, licensed separately by Y; NodCut does not include or license X; you are responsible for complying. It is a constant in the plugin, in the README, in the manifest's `description` if it fits, and in the registry entry's description and `changes`.
- **Record the acceptance** (when, which project, which library version, which kind of licence; never the key) under the plugin's app-data folder, and carry the notice in the first answer for each new pair, so the AI shows it again. Mark non-billable work as such when the licensor distinguishes it (previews as development renders).
- **Installation of the library is the user's act**, under their name: the plugin may run the vendor's own installer for them (`npx create-video@latest` in a folder they chose) but never vendors it, patches it or mirrors its downloads.

## 4. Pattern: models and data with terms (consent before download)

`plugins/sound` is the model.

- **Nothing is bundled.** A `doctor` tool lists each download with its size, publisher, licence name and URL (`RUNTIME_LICENSE` and the catalog in `plugins/sound/src/catalog.ts`). A `setup` tool downloads **one** job's files only with `agree: true`, which the AI may set only after showing the user the licences; without it the plugin fails with its own `E_<X>_LICENSE` and the fix says to show the terms first.
- Downloads come from the publisher's own hosts (listed in `permissions.network`), pinned by SHA-256, into a folder the user can see and a `remove` tool can empty.
- **Terms that depend on the user** (revenue caps, non-commercial clauses, "Powered by …" attribution) are stated in the README in one line each and in `doctor`'s answer; the plugin cannot decide them for the user. Attribution a licence requires goes into the contract's `attribution` field so NodCut keeps it with the project.

## 5. Pattern: assets the plugin ships or serves

A plugin may contain or serve only what its author may redistribute: public domain, CC0, a licence bought **for redistribution**, or the author's own work. Each asset carries its `license` and `attribution` in the contract output (`packages/plugin-api/src/contracts.ts`: music and sound results), so NodCut records them with the project. A library that is free to listen to but not to redistribute is a **key** or **terms** case, not an asset to bundle. Placeholders synthesized from scratch (`plugins/music`) are fine and say so.

## 6. What this looks like to the user and the store

- `permissions.secrets` and `permissions.network` tell the truth; the store shows "needs a key" and "works offline" from them. The manifest `description` (≤ 300 characters) says "with your own API key" / "bring your own licence" when that is the case, so the user knows before installing.
- The README has a section named for it ("Licence: bring your own Remotion", "Setup" with "Make an API key"), with: who the licensee is, where to get the key, where to enter it, what the key is sent to, what leaves the computer, what it costs and who bills it. Link the provider's pricing and licence pages; never quote a price, it goes stale.
- The registry entry (app repo, `nodcut-plugin-publish`) repeats it in `description` and each version's `changes`. The entry's `license` is the plugin's **code** licence (MIT), not the thing it uses.
- The plugin's `package.json` `license` is MIT; a plugin that must carry another licence has its own `LICENSE` file in its folder, as the repo README says.

## 7. Never

- A key, token, licence, account or credential of NodCut's or the author's in the plugin, its fixtures, its bundle, its tests or its history (search before committing: `grep -rn "sk-\|key-\|license" plugins/<name>` minus the names of secrets).
- "Included", "free" or "unlimited" in a description when the user pays the provider.
- A free-tier key shared among users, a proxy that spends NodCut's credits, a "trial" that is really our account.
- Calling a paid API without an explicit user action behind it (an install, an `open_project`, a tool the AI called for the user's request), or more than once for one request.
- Vendoring, mirroring or patching a library whose licence depends on who the user is.
- Deciding a licence tier for the user ("you look like a small company").
- Reading a key from the user's environment, shell profile or another tool's config instead of the declared secret.

## 8. Checklist before "done"

- [ ] Every paid or licensed dependency is in the table of §1 with its pattern, and the README has the section of §6.
- [ ] Secrets and hosts declared and nothing else; `ctx.requireSecret()` / the licence check runs first in every tool that could spend or render.
- [ ] Money errors have their own codes and fixes; `test_key` exists for an API.
- [ ] A guard test for a licensed library (§3); `doctor` + `agree` for terms (§4); `license` + `attribution` in asset answers (§5).
- [ ] `pnpm check` passes with no key, no network and no model (recorded responses, stubs, `skipIf`).
- [ ] Manifest and registry descriptions say "your own key" / "bring your own licence"; no price quoted.
- [ ] `grep` for leaked credentials in the folder; `pnpm bundle` output contains nothing of the licensed library.
