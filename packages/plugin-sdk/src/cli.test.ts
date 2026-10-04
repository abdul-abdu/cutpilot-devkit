/** The fixture plugins import the built SDK, so `test` needs `pnpm build` first (as in harness.test.ts). */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { pluginCli } from './cli.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(PKG, 'fixtures');
const built = existsSync(join(PKG, 'dist/index.js'));

async function run(...argv: string[]): Promise<{ code: number; text: string }> {
  const lines: string[] = [];
  const code = await pluginCli(argv, (s) => lines.push(s));
  return { code, text: lines.join('\n') };
}

describe('nodcut-plugin validate', () => {
  test('ok: every check ✓, exit 0', async () => {
    const r = await run('validate', join(FIXTURES, 'ok'));
    expect(r).toEqual({
      code: 0,
      text: '✓ manifest — fixture-ok 1.0.0\n✓ command — node index.mjs\nfixture-ok: all checks passed',
    });
  });

  test('bad-manifest: ✗ with the fix, exit 1', async () => {
    const r = await run('validate', join(FIXTURES, 'bad-manifest'));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^✗ manifest — id: ids are kebab-case.*\n {4}fix: fix nodcut-plugin.json\n/);
  });

  test('--json prints the report', async () => {
    const r = await run('validate', join(FIXTURES, 'bad-manifest'), '--json');
    expect(r.code).toBe(1);
    expect(JSON.parse(r.text)).toMatchObject({ ok: false, checks: [{ name: 'manifest', result: 'fail' }] });
  });

  test('--strings: what a language pack lacks of a NodCut version (P3-067)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-strings-'));
    try {
      const file = join(dir, 'strings.json');
      writeFileSync(
        file,
        JSON.stringify({ nodcut: '0.3.0', messages: ['Export', 'Settings'], menu: ['File'] }),
      );
      const r = await run('validate', join(FIXTURES, 'language'), '--strings', file);
      expect(r.code).toBe(1);
      expect(r.text).toContain(
        '✗ language de covers NodCut 0.3.0 — 1 strings missing (they show in English), like "Settings"',
      );
      writeFileSync(file, '{"messages": []}');
      expect((await run('validate', join(FIXTURES, 'language'), '--strings', file)).text).toMatch(
        /^--strings .* isn't a NodCut strings.json/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('usage errors exit 2 with the usage', async () => {
    expect((await run('frobnicate')).code).toBe(2);
    expect((await run('validate', '--audio', 'x.wav')).text).toMatch(/^validate doesn't take --audio/);
    expect((await run('test', '--nope')).code).toBe(2);
    expect((await run('test', '--templates', 'some')).text).toMatch(/^--templates is first, all or none/);
    expect((await run('test', '--secret', 'NO_SUCH_VARIABLE_HERE_1')).text).toMatch(/give a value/);
    expect((await run('--help')).code).toBe(0);
  });
});

describe.skipIf(!built)('nodcut-plugin test', () => {
  test('ok: starts, offers its tools, answers per contract; exit 0', async () => {
    const r = await run('test', join(FIXTURES, 'ok'));
    expect(r.code).toBe(0);
    expect(r.text.split('\n')).toEqual([
      '✓ manifest — fixture-ok 1.0.0',
      '✓ starts and answers',
      '✓ offers transcribe',
      '✓ extra tool shout',
      '✓ transcribe answers per contract',
      'fixture-ok: all checks passed',
    ]);
  });

  test('bad-manifest: stops at the manifest, exit 1', async () => {
    const r = await run('test', join(FIXTURES, 'bad-manifest'));
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/^✗ manifest — [^\n]*\n {4}fix: [^\n]*\n[^\n]*bad-manifest: 1 check failed$/);
  });

  test('bad-output: the contract check fails with the field and a fix, exit 1', async () => {
    const r = await run('test', join(FIXTURES, 'bad-output'));
    expect(r.code).toBe(1);
    expect(r.text).toContain(
      '✗ transcribe answers per contract — E_PLUGIN_CONTRACT: transcribe returned words.1.start: words are in time order\n' +
        '    fix: the plugin must return what the transcriber contract says (see @nodcut/plugin-api)',
    );
    expect(r.text).toMatch(/fixture-bad-output: 1 check failed$/);
  });
});

describe.skipIf(!built)('the bin', () => {
  test('dist/bin.js prints the report and exits with its code', () => {
    const bin = join(PKG, 'dist/bin.js');
    const ok = spawnSync(process.execPath, [bin, 'validate', join(FIXTURES, 'ok')], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('fixture-ok: all checks passed');
    const bad = spawnSync(process.execPath, [bin, 'test', join(FIXTURES, 'bad-output')], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('✗ transcribe answers per contract');
  });
});
