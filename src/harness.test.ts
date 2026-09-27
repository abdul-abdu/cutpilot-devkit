/** testPlugin() starts real plugin processes, so it needs the built SDK (`pnpm build`, or `tsc -b` in `pnpm check`). */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { formatReport, testPlugin, type TestReport } from './harness.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PKG, 'dist/index.js');
const built = existsSync(DIST);
const root = mkdtempSync(join(tmpdir(), 'cp-sdk-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A plugin folder: manifest + index.mjs whose body gets `definePlugin`, `PluginFailure` and `z`. */
function plugin(name: string, manifest: Record<string, unknown>, body: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cutpilot-plugin.json'),
    JSON.stringify({
      id: name,
      name,
      version: '1.0.0',
      description: 'test',
      contract: 1,
      cutpilot: '*',
      command: 'node',
      args: ['index.mjs'],
      ...manifest,
    }),
  );
  writeFileSync(
    join(dir, 'index.mjs'),
    `import { definePlugin, PluginFailure } from ${JSON.stringify(pathToFileURL(DIST).href)};\n${body}\n`,
  );
  return dir;
}

const results = (r: TestReport) => Object.fromEntries(r.checks.map((c) => [c.name, c.result]));

describe.skipIf(!built)('testPlugin', () => {
  test('the hello example passes', async () => {
    const r = await testPlugin(join(PKG, 'examples/hello'));
    expect(r.ok).toBe(true);
    expect(results(r)).toEqual({
      manifest: 'pass',
      'starts and answers': 'pass',
      'extra tool greet': 'pass',
    });
    expect(formatReport(r)).toContain('hello: all checks passed');
  });

  test('a transcriber is called with a wav and its answer checked', async () => {
    const dir = plugin(
      'good-transcriber',
      { kinds: ['transcriber'], permissions: { reads: ['audio'] } },
      `import { existsSync } from 'node:fs';
await definePlugin({ transcribe: ({ audio, language }) => ({ language, words: existsSync(audio) ? [{ text: 'ok', start: 0, end: 100 }] : [] }) }).start();`,
    );
    const r = await testPlugin(dir);
    expect(results(r)).toMatchObject({
      'offers transcribe': 'pass',
      'transcribe answers per contract': 'pass',
    });
    expect(r.ok).toBe(true);
  });

  test('a wrong answer fails with the field named and a fix', async () => {
    const dir = plugin(
      'bad-transcriber',
      { kinds: ['transcriber'], permissions: { reads: ['audio'] } },
      `await definePlugin({ transcribe: () => ({ language: 'en', words: [{ text: 'x', start: 900, end: 100 }] }) }).start();`,
    );
    const r = await testPlugin(dir);
    expect(r.ok).toBe(false);
    const c = r.checks.find((x) => x.name === 'transcribe answers per contract')!;
    expect(c.detail).toBe(
      'E_PLUGIN_CONTRACT: transcribe returned words.0.end: a word ends at or after its start',
    );
    expect(c.fix).toMatch(/transcriber contract/);
    expect(formatReport(r)).toMatch(/✗ transcribe answers per contract — .*\n {4}fix: /);
  });

  test('calls that need a secret are skipped without it, and run with it', async () => {
    const dir = plugin(
      'keyed',
      { kinds: ['transcriber'], permissions: { reads: ['audio'], secrets: ['API_KEY'] } },
      `await definePlugin({ transcribe: (_i, ctx) => { if (ctx.requireSecret('API_KEY') !== 'k') throw new PluginFailure('E_BAD_KEY', 'refused', 'new key'); return { language: 'en', words: [] }; } }).start();`,
    );
    expect(results(await testPlugin(dir))['transcribe answers per contract']).toBe('skip');
    expect(
      results(await testPlugin(dir, { secrets: { API_KEY: 'k' } }))['transcribe answers per contract'],
    ).toBe('pass');
    const wrong = await testPlugin(dir, { secrets: { API_KEY: 'x' } });
    expect(wrong.checks.find((c) => c.name === 'transcribe answers per contract')).toMatchObject({
      result: 'fail',
      detail: 'E_BAD_KEY: refused',
      fix: 'new key',
    });
  });

  test('music: find, then get the first track, and the file must exist', async () => {
    const dir = plugin(
      'tunes',
      { kinds: ['asset:music'] },
      `const track = { id: 't1', title: 'T', moods: ['calm'], durationMs: 1000, loopable: true, license: 'CC0' };
await definePlugin({ findMusic: () => ({ tracks: [track] }), getMusic: () => ({ file: '/nonexistent/t1.m4a', durationMs: 1000, license: 'CC0' }) }).start();`,
    );
    const r = await testPlugin(dir);
    expect(results(r)).toMatchObject({
      'find_music answers per contract': 'pass',
      'get_music answers per contract': 'pass',
      'get_music file exists': 'fail',
    });
  });

  test('a reframe analyzer is skipped without a video', async () => {
    const dir = plugin(
      'reframer',
      { kinds: ['analyzer:reframe-track'], permissions: { reads: ['source'] } },
      `await definePlugin({ reframeTrack: () => ({ keyframes: [{ t: 0, x: 0.5, y: 0.5 }] }) }).start();`,
    );
    expect(results(await testPlugin(dir))['reframe_track answers per contract']).toBe('skip');
  });

  test('a plugin that does not start, and a broken manifest, are reported with fixes', async () => {
    const crash = plugin('crasher', {}, `console.error('missing dependency: sharp'); process.exit(3);`);
    const r = await testPlugin(crash);
    const start = r.checks.find((c) => c.name === 'starts and answers')!;
    expect(start.result).toBe('fail');
    expect(start.detail).toContain('missing dependency: sharp');
    expect(start.fix).toMatch(/^run "node index.mjs" in /);

    const bad = plugin('bad-manifest', { contract: 2 }, '');
    const m = await testPlugin(bad);
    expect(m.checks).toEqual([
      expect.objectContaining({
        name: 'manifest',
        result: 'fail',
        detail: 'contract: this CutPilot speaks plugin contract 1',
      }),
    ]);
  });
});
