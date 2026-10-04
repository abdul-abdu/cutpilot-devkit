#!/usr/bin/env node
// The `nodcut-plugin` command (see cli.ts).
import { pluginCli } from './cli.js';

process.exitCode = await pluginCli(process.argv.slice(2));
