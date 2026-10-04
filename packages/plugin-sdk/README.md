# @nodcut/plugin-sdk

Build plugins for [NodCut](https://github.com/nodcut/nodcut), the AI-first video editor. A plugin is a folder with a `nodcut-plugin.json` manifest and an MCP server on stdio; this SDK makes the server and checks the plugin the way NodCut will.

```sh
npx -p @nodcut/plugin-sdk nodcut-plugin new my-titles   # a working plugin to start from
cd my-titles && npm install && npm test
```

- `definePlugin({ ...handlers, tools })`: an MCP server that offers the tools of the kinds in its manifest (transcriber, reframe analyzer, music, sound, generator) plus your own read-only tools, with every input and answer checked against `@nodcut/plugin-api`. `defineTool()` types an extra tool's handler from its input; `PluginFailure(code, message, fix)` reports an error the user can act on.
- `validatePluginFolder(dir)`, `testPlugin(dir, options)` and `formatReport(report)`: the checks NodCut makes, as ✓ / ✗ lines with a fix for each failure.
- `scaffoldPlugin({ dir, id, kind })`: a new plugin folder that passes its tests from the start.
- The `nodcut-plugin` command: `new`, `validate`, `test`.
- Everything in `@nodcut/plugin-api` (the manifest schema, the contracts), and `z`, the SDK's zod.

The [plugin guide](https://github.com/nodcut/nodcut-devkit/blob/main/docs/plugin-guide.md) walks through building, testing and installing one. MIT licensed.
