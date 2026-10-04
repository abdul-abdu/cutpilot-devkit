# @nodcut/plugin-api

What a [NodCut](https://github.com/nodcut/nodcut) plugin is, as [zod](https://zod.dev) schemas shared by the NodCut engine and plugin authors: the `nodcut-plugin.json` manifest (`ManifestSchema`, `parseManifest`), the tool contract of each plugin kind (`KIND_TOOLS`), the error codes, the icon checks and the plugin registry's index format. It depends on zod only.

Most plugin authors want [`@nodcut/plugin-sdk`](https://www.npmjs.com/package/@nodcut/plugin-sdk), which includes all of this. The package's major version is the plugin contract version (`CONTRACT_VERSION`). MIT licensed.
