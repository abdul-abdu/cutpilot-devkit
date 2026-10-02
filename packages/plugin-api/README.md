# @cutpilot/plugin-api

What a [CutPilot](https://github.com/abdul-abdu/cutpilot) plugin is, as [zod](https://zod.dev) schemas shared by the CutPilot engine and plugin authors: the `cutpilot-plugin.json` manifest (`ManifestSchema`, `parseManifest`), the tool contract of each plugin kind (`KIND_TOOLS`), the error codes, the icon checks and the plugin registry's index format. It depends on zod only.

Most plugin authors want [`@cutpilot/plugin-sdk`](https://www.npmjs.com/package/@cutpilot/plugin-sdk), which includes all of this. The package's major version is the plugin contract version (`CONTRACT_VERSION`). MIT licensed.
