/** @nodcut/plugin-sdk (MIT): build and test NodCut plugins. */
export {
  definePlugin,
  defineTool,
  imageBlock,
  PluginDefinitionError,
  PluginFailure,
  ToolContent,
  type ExtraTool,
  type Plugin,
  type PluginContext,
  type PluginDefinition,
} from './plugin.js';
export {
  pluginEnv,
  resolveCommand,
  silentWav,
  smallCanvas,
  testPlugin,
  type TestOptions,
} from './harness.js';
export {
  commandCheck,
  findOnPath,
  formatReport,
  languageChecks,
  validatePluginFolder,
  type Check,
  type TestReport,
} from './validate.js';
export * from '@nodcut/plugin-api';
/** The SDK's own zod, for extra tools' inputs: one copy between a plugin and the SDK. */
export { z } from 'zod';
export { CLI_USAGE, pluginCli } from './cli.js';
export {
  SCAFFOLD_KINDS,
  ScaffoldError,
  scaffoldKind,
  scaffoldPlugin,
  sdkVersion,
  TEMPLATE_NODCUT_RANGE,
  TEMPLATE_DEV_DEPENDENCIES,
  type ScaffoldKind,
  type ScaffoldOptions,
  type ScaffoldResult,
} from './scaffold.js';
