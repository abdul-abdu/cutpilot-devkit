#!/usr/bin/env node
/**
 * Claude Code PostToolUse hook for Edit|Write (.claude/settings.json): prettier on the file
 * that was just written, with the nearest repo's own prettier, so `pnpm check` (which includes
 * format:check in the devkit) doesn't fail on whitespace. Files prettier doesn't handle,
 * ignored files and files outside a repo with prettier are left alone. Never fails the call.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

const input = JSON.parse(readFileSync(0, 'utf8'));
const file = String(input?.tool_input?.file_path ?? '');
const FORMATTED = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.yml',
  '.yaml',
  '.html',
]);
if (!file || !FORMATTED.has(extname(file)) || !existsSync(file)) process.exit(0);

let dir = dirname(file);
let prettier = null;
while (dir !== dirname(dir)) {
  const bin = join(dir, 'node_modules', '.bin', 'prettier');
  if (existsSync(join(dir, 'package.json')) && existsSync(bin)) {
    prettier = bin;
    break;
  }
  dir = dirname(dir);
}
if (!prettier) process.exit(0);
try {
  execFileSync(prettier, ['--write', '--log-level', 'warn', file], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
} catch {
  // a syntax error in the file: the agent sees it from typecheck; formatting is not the gate
}
