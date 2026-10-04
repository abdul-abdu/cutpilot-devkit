// The Brag plugin as NodCut starts it: an MCP server on stdio, in the plugin folder.
import { definePlugin } from '@nodcut/plugin-sdk';
import { definition } from './plugin.js';

await definePlugin(definition).start();
