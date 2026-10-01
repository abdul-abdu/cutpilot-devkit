// The Cloud Transcribe plugin as CutPilot starts it: an MCP server on stdio, in the plugin folder.
import { definePlugin } from '@cutpilot/plugin-sdk';
import { definition } from './plugin.js';

await definePlugin(definition).start();
