# Agent notes

- This repo is **public (MIT)**. Never copy code, docs, task files or internal notes from the private `cutpilot` app repo into it, and never import from it (`stay-in-repo` rule).
- The spec for plugins lives in the app repo: `docs/09-stage3-plugin-host-spec.md`; tasks are `tasks/phase-3-plugins/` there (IDs like `P3-030`). Reference task IDs in commit messages the same way the app repo does: `P3-030: <what changed>`.
- Stack: TypeScript (strict, ESM, NodeNext), Node 22+, pnpm workspace, zod 4, the MCP TypeScript SDK, vitest, eslint, prettier, dependency-cruiser.
- Before committing: `pnpm build && pnpm check`.
- Contracts in `packages/plugin-api` are shared with the app's engine; a breaking change bumps `contract` and needs a matching change in the app repo.
