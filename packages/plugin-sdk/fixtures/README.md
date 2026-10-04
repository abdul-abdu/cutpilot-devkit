# Fixture plugins

Small plugins the SDK's own tests (and `nodcut-plugin validate|test`) are checked against. Each one imports the SDK by its package name, which Node resolves to this package's `dist/`, so run `pnpm build` first.

| Folder | What it is | `validate` | `test` |
| --- | --- | --- | --- |
| `ok/` | a transcriber and an extra tool, both well-behaved | passes | passes |
| `bad-manifest/` | a manifest with a bad id, the wrong contract and a missing permission | fails | fails |
| `bad-output/` | a valid manifest whose transcriber returns words out of time order | passes | fails |
| `language/` | a language pack (German, a few strings and menu labels): data only, nothing to start | passes | passes |
