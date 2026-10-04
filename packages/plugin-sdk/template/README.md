# Plugin templates

What `nodcut-plugin new` (`scaffoldPlugin()`) copies into a new plugin: `index.ts` (every kind) and, from the kind's folder, `plugin.ts` and `index.test.ts`, all under the new plugin's `src/`. The manifest, `package.json`, `tsconfig.json`, README, `AGENTS.md` and `.gitignore` are written by `src/scaffold.ts`.

Each template is a small plugin that works as it is (placeholder logic, marked where to put your own), so the new plugin passes `testPlugin()` before its author changes a line. `src/scaffold.test.ts` generates every kind, compiles it and runs `testPlugin()` on it.
