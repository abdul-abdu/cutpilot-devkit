// Starts the plugin: an MCP server on stdin/stdout, which is how CutPilot talks to it.
// CutPilot runs `node dist/index.js` in the plugin's folder (see cutpilot-plugin.json).
import { definePlugin } from '@cutpilot/plugin-sdk';
import { plugin } from './plugin.js';

await definePlugin(plugin).start();
