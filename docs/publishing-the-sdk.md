# Publishing the SDK to npm

For the owner. `@cutpilot/plugin-api` and `@cutpilot/plugin-sdk` are ready to publish, but they stay `"private": true` until the owner decides to make them public (an open question in CutPilot's plugin spec): `private` is what keeps an accidental `pnpm publish` from going out. Everything else is in place: `publishConfig.access: public`, `files`, a README and the MIT license in each package, the `cutpilot-plugin` bin, and a test (`packages/plugin-sdk/src/publish.test.ts`) that keeps the two packages in step.

The first-party plugins in `plugins/` are `private` too and are never published to npm: they go to CutPilot's plugin store as `.cutpilot-plugin` packages.

## Versioning

- **The two packages are released together, with the same version.** In the repository the SDK depends on `"@cutpilot/plugin-api": "workspace:*"`; `pnpm publish` replaces that with the exact version, so an SDK always uses the plugin-api it was tested with.
- **The major version is the plugin contract version** (`CONTRACT_VERSION` in `packages/plugin-api/src/manifest.ts`, the `contract` field of every manifest). Contract 1 is 1.x. A breaking change to a contract bumps `CONTRACT_VERSION` and the major version together (contract 2 is 2.0.0), with the matching change in the app. From 1.0.0 on, `publish.test.ts` fails if the two disagree.
- **Minor** for additions that don't break a plugin: a new kind, a new optional manifest field or setting type, a new SDK function, a new template. A plugin that relies on one says so with its manifest's `cutpilot` range.
- **Patch** for fixes and documentation.
- A breaking change to the SDK's own API waits for the next contract bump; until then the old API is kept and marked deprecated.

New plugins depend on `^<the SDK version that made them>` (`scaffoldPlugin`), so they get fixes and additions, never another contract.

The packages are 0.1.0 today. Publish the first release as **1.0.0**, since it speaks contract 1.

## Before the first publish

1. An npm account with **two-factor authentication for writes** (npmjs.com → Account → Two-Factor Authentication → "Authorization and writes").
2. The `@cutpilot` scope: create the organization `cutpilot` on npmjs.com (free for public packages) if it doesn't exist yet, with your account as owner.

## Publishing a release

From a clean checkout of `main`, with Node 22 and pnpm:

```sh
git pull && git status                   # clean, on main
pnpm install --frozen-lockfile
```

1. Set the version in both `packages/plugin-api/package.json` and `packages/plugin-sdk/package.json` (the same one; 1.0.0 the first time), and remove `"private": true` from both. Leave the plugins' `private` alone.
2. Check, and see what would go out:

   ```sh
   pnpm build && pnpm check
   pnpm -r publish --access public --dry-run
   ```

   The dry run lists exactly two packages, `@cutpilot/plugin-api` first and `@cutpilot/plugin-sdk` second (pnpm publishes a package's dependencies before it).
3. Commit the version (`git commit -am "Release SDK 1.0.0"`), and merge it to `main` the usual way.
4. Log in and publish:

   ```sh
   npm login                                  # opens the browser; confirm with 2FA
   npm whoami
   pnpm -r publish --access public --otp <code from your authenticator>
   ```

   If the code expires between the two packages, run the same command again with a new code: packages whose version is already on npm are skipped. To publish them one at a time instead, in this order:

   ```sh
   pnpm --filter @cutpilot/plugin-api publish --access public --otp <code>
   pnpm --filter @cutpilot/plugin-sdk publish --access public --otp <code>
   ```

5. Tag the release and push the tag:

   ```sh
   git tag sdk-v1.0.0 && git push origin sdk-v1.0.0
   ```

6. Check it on a machine (or in a folder) that has never seen this repository:

   ```sh
   cd "$(mktemp -d)"
   npx -p @cutpilot/plugin-sdk cutpilot-plugin new my-titles
   cd my-titles && npm install && npm test
   ```

   `npm test` builds the new plugin and runs `testPlugin()` on it; it should report one test file passed. This is the check CutPilot's go/no-go asks for: an outsider makes a plugin from the published SDK alone.

7. After the first release, change "Nothing is published to npm yet" in the README, and the "until the SDK is on npm" notes in `docs/plugin-guide.md`, to say where the packages are.

`private` can stay off after the first release: `pnpm -r publish` only publishes a version that isn't on npm yet, and only with your login and a 2FA code.

## If something goes wrong

- `E402 Payment Required` or `You must sign up for private packages`: the `--access public` flag (or `publishConfig`) is missing, or the scope belongs to someone else.
- `E403` on `@cutpilot/...`: your account isn't an owner or member of the `cutpilot` organization.
- `EOTP`: the code is missing or expired; pass a fresh `--otp`.
- A broken release can be withdrawn within 72 hours with `npm unpublish @cutpilot/plugin-sdk@<version>`, but that version number can never be used again; usually it's better to publish a fixed patch and `npm deprecate @cutpilot/plugin-sdk@<version> "<why>"`.
