/**
 * Finding the user's Node for create_project when CutPilot was opened from the Dock: its PATH
 * has no nvm, fnm, Volta, asdf or mise folder, so their install folders are searched.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findNode, nodeDirs } from './create.js';

describe.skipIf(process.platform === 'win32')('findNode', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cp-remotion-node-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  /** a bin folder with these programs (empty files are enough: only their presence is checked) */
  const bin = (rel: string, names = ['node', 'npm', 'npx']) => {
    const dir = join(home, rel);
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), '');
    return dir;
  };
  /** what an app opened from the Dock gets: no version manager on PATH; no fixed folders here */
  const gui = (extra: NodeJS.ProcessEnv = {}) =>
    findNode({ HOME: home, PATH: '/usr/bin:/bin', ...extra }, []);

  test('nvm: the newest installed version, by number not by name', () => {
    bin('.nvm/versions/node/v9.11.2/bin');
    bin('.nvm/versions/node/v20.10.0/bin');
    const newest = bin('.nvm/versions/node/v24.2.0/bin');
    bin('.nvm/versions/node/v24.10.1/bin', ['node']); // half an install: no npm, npx
    expect(gui()).toEqual({
      node: join(newest, 'node'),
      npm: join(newest, 'npm'),
      npx: join(newest, 'npx'),
    });
  });

  test('NVM_BIN (the version the shell chose) comes before the newest one', () => {
    const chosen = bin('.nvm/versions/node/v20.10.0/bin');
    bin('.nvm/versions/node/v24.2.0/bin');
    expect(gui({ NVM_BIN: chosen })?.node).toBe(join(chosen, 'node'));
  });

  test('a node on PATH wins over the version managers', () => {
    bin('.nvm/versions/node/v24.2.0/bin');
    const onPath = bin('custom/bin');
    expect(findNode({ HOME: home, PATH: onPath }, [])?.npx).toBe(join(onPath, 'npx'));
  });

  test('npx without node next to it is skipped, so npm never runs with another install’s node', () => {
    const lonely = bin('custom/bin', ['npm', 'npx']);
    const nvm = bin('.nvm/versions/node/v22.0.0/bin');
    expect(findNode({ HOME: home, PATH: lonely }, [])?.npx).toBe(join(nvm, 'npx'));
  });

  test.each([
    ['fnm on macOS', 'Library/Application Support/fnm/node-versions/v22.1.0/installation/bin'],
    ['fnm on Linux', '.local/share/fnm/node-versions/v22.1.0/installation/bin'],
    ['Volta', '.volta/bin'],
    ['mise', '.local/share/mise/installs/node/22.1.0/bin'],
    ['asdf', '.asdf/installs/nodejs/22.1.0/bin'],
    ['a link in ~/.local/bin', '.local/bin'],
  ])('%s', (_name, rel) => {
    const dir = bin(rel);
    expect(gui()?.node).toBe(join(dir, 'node'));
  });

  test('none installed: null (create_project then says how to install Node)', () => {
    expect(gui()).toBeNull();
  });

  test('the search order: PATH, fixed folders, NVM_BIN, then the managers', () => {
    bin('.nvm/versions/node/v20.0.0/bin');
    const dirs = nodeDirs({ HOME: home, PATH: '/a:/b', NVM_BIN: '/nvm/current' }, ['/opt/homebrew/bin']);
    expect(dirs.slice(0, 5)).toEqual([
      '/a',
      '/b',
      '/opt/homebrew/bin',
      '/nvm/current',
      join(home, '.nvm/versions/node/v20.0.0/bin'),
    ]);
  });
});
