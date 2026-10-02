#!/usr/bin/env node
/**
 * Claude Code SessionStart hook (.claude/settings.json): what the commit rules ask every agent
 * to note before starting — the branch and the files already modified (someone else's work in
 * progress, which stays out of your commits). Printed to stdout, which Claude Code adds to
 * the session's context. The repo is found from this file's real location, so it also works
 * when this folder is reached through a symlink from a parent workspace.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (repo, ...args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};

export function report(repo) {
  const branch = git(repo, 'branch', '--show-current');
  if (branch === null) return `${basename(repo)}: not a git repository`;
  const status = git(repo, 'status', '--short') ?? '';
  const lines = status ? status.split('\n').length : 0;
  return `${basename(repo)}: branch ${branch || '(detached)'}, ${lines ? `${lines} path(s) already modified (not yours; leave them out of commits):\n${status}` : 'clean'}`;
}

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
const repo = join(here, '..', '..');
process.stdout.write(`${report(repo)}\n`);
