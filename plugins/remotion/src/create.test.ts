/**
 * Finding the user's Node for create_project when NodCut was opened from the Dock: its PATH
 * has no nvm, fnm, Volta, asdf or mise folder, so their install folders are searched.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { findNode, nodeDirs, run } from './create.js';

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

describe.skipIf(process.platform === 'win32')('run', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cp-remotion-run-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** an `npm` that prints one line, then says nothing for a while, like npm install --loglevel=error */
  const quietNpm = (seconds: number, code = 0) => {
    const f = join(dir, 'npm');
    writeFileSync(f, `#!/bin/sh\necho "added 1 package"\nsleep ${seconds}\nexit ${code}\n`);
    chmodSync(f, 0o755);
    return f;
  };
  const ctx = () => {
    const seen: { fraction: number; message: string | undefined }[] = [];
    return {
      seen,
      ctx: {
        progress: (fraction: number, message?: string) => seen.push({ fraction, message }),
        log: () => {},
        signal: new AbortController().signal,
      },
    };
  };

  test('a silent step still reports progress, so NodCut does not take it for a hung plugin', async () => {
    const { seen, ctx: c } = ctx();
    const lines = await run(quietNpm(0.7), ['install', '--no-audit'], dir, c, 0.3, 0.8, 100);
    expect(lines).toEqual(['added 1 package']);
    // before the line (a slow start): the step's name; after it: its progress and the time it ran
    const at = seen.findIndex((x) => x.message === 'added 1 package');
    expect(at).toBeGreaterThanOrEqual(0);
    for (const b of seen.slice(0, at))
      expect(b).toEqual({
        fraction: 0.3,
        message: expect.stringMatching(/^npm install is running \(\d+ s\)$/),
      });
    const beats = seen.slice(at + 1);
    expect(beats.length).toBeGreaterThanOrEqual(3);
    for (const b of beats) {
      expect(b.fraction).toBe(seen[at]!.fraction);
      expect(b.message).toMatch(/^added 1 package \(\d+ s\)$/);
    }
  });

  test('the beat stops when the step ends, and a failure names the step', async () => {
    const { seen, ctx: c } = ctx();
    await expect(run(quietNpm(0.1, 3), ['install'], dir, c, 0, 1, 50)).rejects.toMatchObject({
      code: 'E_REMOTION_CREATE_FAILED',
      message: expect.stringMatching(/^npm install failed \(exit 3\): added 1 package/),
    });
    const after = seen.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(seen.length).toBe(after);
  });
});
