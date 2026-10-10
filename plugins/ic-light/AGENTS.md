# IC-Light plugin

This public, MIT plugin uses the user's local ComfyUI server and separately installed native IC-Light nodes/models. It offers extra MCP tools, returns files, and never changes a NodCut timeline. Do not import from another plugin or the private app. Read the devkit's `AGENTS.md` and the `nodcut-plugin` and `nodcut-plugin-licensing` skills before changing it.

- `doctor` lists installed model names, required nodes and terms. `setup` records explicit acceptance for the selected server/checkpoint/UNet. Do not bundle or automatically download ComfyUI or model weights.
- Only loopback HTTP is allowed; keep redirects disabled. Never add a cloud fallback or upload footage to an external endpoint.
- The upstream native node registration is `ICLightAppply`, including its unusual spelling. Use the SD1.5 foreground `fc` model; this graph does not accept `fbc`.
- Video is experimental independent-frame processing. A fixed seed does not guarantee temporal consistency. Keep that limitation in tool descriptions and results.
- Source times are integer milliseconds. Keep the original source immutable, copy its selected audio into the output, and retain provenance. Returned files must remain available while projects link them.
- Cancellation must target only the prompt this call queued; never globally interrupt ComfyUI. Honour the tool's signal and report progress while waiting.
- Logs go to stderr; stdout is MCP. Use `PluginFailure` with an existing plugin error code and an actionable one-line fix.
- Tests use local protocol fixtures and real FFmpeg where available. They must not require model downloads or a running neural backend. Do not describe mock-backend tests as a successful Mac relighting benchmark.

From the devkit root: `pnpm build`, `pnpm vitest run plugins/ic-light`, `pnpm format`, `pnpm check`, `pnpm bundle plugins/ic-light`. Update the README when setup, behaviour or limits change.
