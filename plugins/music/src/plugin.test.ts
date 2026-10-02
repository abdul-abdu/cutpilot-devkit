/**
 * The shipped library (its facts match its files), the tools through MCP (in memory), the plugin
 * as CutPilot starts it and as `pnpm bundle` packs it (both need `pnpm build`).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { bundlePlugin } from '../../../scripts/bundle-plugin.mjs';
import { LIBRARY_DIR, loadLibrary } from './library.js';
import { definition, makeDefinition } from './plugin.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'cp-music-'));
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(def = definition) {
  const plugin = definePlugin({ ...def, manifest }, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}

type Result = Awaited<ReturnType<Client['callTool']>>;
const structured = <T>(r: Result) => {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as T;
};
const error = (r: Result) => {
  expect(r.isError).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
};

const MOODS = ['calm', 'upbeat', 'inspiring', 'corporate', 'dramatic', 'lo-fi'];

describe('the shipped library', () => {
  const lib = loadLibrary();

  test('six moods, at least one track each, 30–90 s, loopable, CC0', () => {
    expect(lib.tracks.length).toBeGreaterThanOrEqual(6);
    for (const m of MOODS)
      expect(
        lib.tracks.some((t) => t.moods.includes(m)),
        m,
      ).toBe(true);
    for (const t of lib.tracks) {
      expect(t.durationMs).toBeGreaterThanOrEqual(30_000);
      expect(t.durationMs).toBeLessThanOrEqual(90_000);
      expect(t).toMatchObject({ loopable: true, license: 'CC0-1.0' });
    }
  });

  test('every file is there and small; a few MB in all', () => {
    let total = 0;
    for (const t of lib.tracks) {
      const f = join(LIBRARY_DIR, t.file);
      expect(existsSync(f), f).toBe(true);
      total += statSync(f).size;
    }
    expect(total).toBeLessThan(10 * 1024 * 1024);
  });

  const ffprobe = (() => {
    try {
      execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  test.skipIf(!ffprobe)('the lengths in library.json are the files’ lengths', () => {
    for (const t of lib.tracks) {
      const out = execFileSync(
        'ffprobe',
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', join(LIBRARY_DIR, t.file)],
        { encoding: 'utf8' },
      );
      expect(Math.abs(Number(out) * 1000 - t.durationMs), t.id).toBeLessThan(50);
    }
  });
});

describe('tools', () => {
  test('find_music by mood and length; the file is not listed', async () => {
    const c = await connect();
    const r = structured<{ tracks: Record<string, unknown>[] }>(
      await c.callTool({ name: 'find_music', arguments: { mood: 'calm', minDurationMs: 65_000 } }),
    );
    expect(r.tracks.map((t) => t.id)).toEqual(['rainy-desk', 'still-water']);
    expect(r.tracks[0]).toMatchObject({ title: 'Rainy Desk', loopable: true, license: 'CC0-1.0' });
    expect(r.tracks[0]).not.toHaveProperty('file');
  });

  test('find_music with nothing returns every track, up to the limit', async () => {
    const c = await connect();
    const all = structured<{ tracks: unknown[] }>(await c.callTool({ name: 'find_music', arguments: {} }));
    expect(all.tracks).toHaveLength(loadLibrary().tracks.length);
    const two = structured<{ tracks: unknown[] }>(
      await c.callTool({ name: 'find_music', arguments: { limit: 2 } }),
    );
    expect(two.tracks).toHaveLength(2);
  });

  test('get_music: the absolute path, length and licence', async () => {
    const c = await connect();
    const r = structured<{ file: string; durationMs: number; license: string }>(
      await c.callTool({ name: 'get_music', arguments: { id: 'long-shadow' } }),
    );
    expect(isAbsolute(r.file)).toBe(true);
    expect(existsSync(r.file)).toBe(true);
    expect(r).toMatchObject({ license: 'CC0-1.0', durationMs: expect.any(Number) });
  });

  test('get_music of an unknown id says to use find_music', async () => {
    const c = await connect();
    const e = error(await c.callTool({ name: 'get_music', arguments: { id: 'nope' } }));
    expect(e.code).toBe('E_MUSIC_UNKNOWN_TRACK');
    expect(e.fix).toMatch(/find_music/);
  });

  test('attribution is passed on; a missing file and a broken library are clear errors', async () => {
    const dir = join(tmp, 'lib');
    mkdirSync(dir);
    writeFileSync(join(dir, 'a.m4a'), 'x');
    const entry = { title: 'A', moods: ['calm'], durationMs: 1000, loopable: true, license: 'CC-BY-4.0' };
    writeFileSync(
      join(dir, 'library.json'),
      JSON.stringify({
        tracks: [
          { ...entry, id: 'a', file: 'a.m4a', attribution: 'A by Someone (CC BY 4.0)' },
          { ...entry, id: 'gone', file: 'gone.m4a' },
        ],
      }),
    );
    const c = await connect(makeDefinition(dir));
    expect(
      structured<{ attribution: string }>(await c.callTool({ name: 'get_music', arguments: { id: 'a' } })),
    ).toMatchObject({ file: join(dir, 'a.m4a'), attribution: 'A by Someone (CC BY 4.0)' });
    expect(error(await c.callTool({ name: 'get_music', arguments: { id: 'gone' } })).code).toBe(
      'E_MUSIC_FILE_MISSING',
    );

    const bad = join(tmp, 'bad');
    mkdirSync(bad);
    writeFileSync(
      join(bad, 'library.json'),
      JSON.stringify({ tracks: [{ id: 'x', file: '../../etc/passwd' }] }),
    );
    const e = error(
      await (await connect(makeDefinition(bad))).callTool({ name: 'find_music', arguments: {} }),
    );
    expect(e.code).toBe('E_MUSIC_LIBRARY');
    expect(e.message).toMatch(/inside the library/);
  });
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as CutPilot starts it', () => {
  test('testPlugin passes: finds a track and gets its file', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers find_music', 'pass'],
      ['offers get_music', 'pass'],
      ['find_music answers per contract', 'pass'],
      ['get_music answers per contract', 'pass'],
    ]);
  });

  test('pnpm bundle carries the library, and the bundle passes too', async () => {
    const lines: string[] = [];
    const b = await bundlePlugin(DIR, join(tmp, 'bundle'), { log: (l) => lines.push(l) });
    expect(lines).toContain('copied library');
    for (const t of loadLibrary().tracks)
      expect(existsSync(join(b.dir, 'library', t.file)), t.file).toBe(true);
    expect(existsSync(join(b.dir, 'scripts'))).toBe(false);
    const r = await testPlugin(b.dir);
    expect(r.ok, formatReport(r)).toBe(true);
  });
});
