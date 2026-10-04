// Starts the plugin: an MCP server on stdin/stdout, which is how NodCut talks to it.
// NodCut runs `node dist/index.js` in the plugin's folder (see nodcut-plugin.json).
import { definePlugin } from '@nodcut/plugin-sdk';
import { plugin } from './plugin.js';

await definePlugin(plugin).start();
