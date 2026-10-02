/** @cutpilot/plugin-sdk (MIT): build and test CutPilot plugins. */
export {
  definePlugin,
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
  validatePluginFolder,
  type Check,
  type TestReport,
} from './validate.js';
export * from '@cutpilot/plugin-api';
/** The SDK's own zod, for extra tools' inputs: one copy between a plugin and the SDK. */
export { z } from 'zod';
export { CLI_USAGE, pluginCli } from './cli.js';
