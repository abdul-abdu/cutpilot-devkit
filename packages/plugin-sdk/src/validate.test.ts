import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, test } from 'vitest';
import { commandCheck, findOnPath, formatReport, validatePluginFolder, type TestReport } from './validate.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cp-validate-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const results = (r: TestReport) => Object.fromEntries(r.checks.map((c) => [c.name, c.result]));

function folder(name: string, manifest: Record<string, unknown> | string, files: string[] = []): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const base = {
    id: name,
    name,
    version: '1.0.0',
    description: 'test',
    contract: 1,
    cutpilot: '*',
    command: 'node',
    args: ['index.mjs'],
  };
  writeFileSync(
    join(dir, 'cutpilot-plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify({ ...base, ...manifest }),
  );
  for (const f of files) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), '');
  }
  return dir;
}

describe('validatePluginFolder', () => {
  test('the ok fixture passes: manifest and command', () => {
    const r = validatePluginFolder(join(FIXTURES, 'ok'));
    expect(r.ok).toBe(true);
    expect(r.plugin).toBe('fixture-ok');
    expect(r.manifest?.kinds).toEqual(['transcriber']);
    expect(r.checks).toEqual([
      { name: 'manifest', result: 'pass', detail: 'fixture-ok 1.0.0' },
      { name: 'command', result: 'pass', detail: 'node index.mjs' },
    ]);
    expect(formatReport(r)).toBe(
      '✓ manifest — fixture-ok 1.0.0\n✓ command — node index.mjs\nfixture-ok: all checks passed',
    );
  });

  test('the bad-manifest fixture fails with every problem named and a fix', () => {
    const r = validatePluginFolder(join(FIXTURES, 'bad-manifest'));
    expect(r.ok).toBe(false);
    expect(r.manifest).toBeUndefined();
    expect(r.checks).toHaveLength(1);
    const c = r.checks[0]!;
    expect(c).toMatchObject({ name: 'manifest', result: 'fail', fix: 'fix cutpilot-plugin.json' });
    expect(c.detail).toContain('id: ids are kebab-case');
    expect(c.detail).toContain('contract: this CutPilot speaks plugin contract 1');
    expect(formatReport(r)).toMatch(
      /^✗ manifest — .*\n {4}fix: fix cutpilot-plugin.json\n.*: 1 check failed$/,
    );
  });

  test("the bad-output fixture's manifest is fine: what it returns is testPlugin's business", () => {
    expect(validatePluginFolder(join(FIXTURES, 'bad-output')).ok).toBe(true);
  });

  test('a missing manifest, and one that is not JSON', () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    expect(validatePluginFolder(empty)).toMatchObject({
      plugin: empty,
      ok: false,
      checks: [{ name: 'manifest', result: 'fail', fix: `add cutpilot-plugin.json to ${empty}` }],
    });
    const broken = folder('broken', '{ "id": ');
    expect(validatePluginFolder(broken).checks[0]).toMatchObject({
      result: 'fail',
      fix: 'make cutpilot-plugin.json valid JSON',
    });
  });

  test('an unbuilt TypeScript plugin: the entry file is missing, and the fix says to build', () => {
    const dir = folder('unbuilt', { args: ['dist/index.js'] }, ['package.json']);
    const r = validatePluginFolder(dir);
    expect(results(r)).toEqual({ manifest: 'pass', command: 'fail' });
    expect(r.checks[1]).toMatchObject({
      detail: "dist/index.js doesn't exist",
      fix: expect.stringMatching(/^build the plugin \(npm run build\)/),
    });
  });

  test('the icon is checked by its bytes', () => {
    const dir = folder('iconic', { icon: 'icon.png' }, ['index.mjs', 'icon.png']);
    expect(validatePluginFolder(dir).checks[1]).toMatchObject({
      name: 'icon',
      result: 'fail',
      detail: 'the icon is not a PNG',
    });
  });

  test('commands: node needs a file in the folder; a bare name is looked up on PATH', () => {
    const dir = folder('cmds', {}, ['server.py', 'bin/run']);
    expect(commandCheck(dir, { command: 'node', args: [] })).toMatchObject({ result: 'fail' });
    expect(commandCheck(dir, { command: 'node', args: ['../x.js'] })).toMatchObject({
      result: 'fail',
      detail: '../x.js is outside the plugin folder',
    });
    expect(commandCheck(dir, { command: 'bin/run', args: [] })).toMatchObject({ result: 'pass' });
    expect(commandCheck(dir, { command: 'bin/nope', args: [] })).toMatchObject({ result: 'fail' });
    expect(commandCheck(dir, { command: 'no-such-tool-here', args: ['run', 'server.py'] })).toMatchObject({
      result: 'skip',
      detail: "no-such-tool-here isn't on PATH here",
    });
    expect(commandCheck(dir, { command: 'no-such-tool-here', args: ['run', 'missing.py'] })).toMatchObject({
      result: 'fail',
      detail: "missing.py doesn't exist",
    });
    const sh = findOnPath('sh');
    if (sh)
      expect(commandCheck(dir, { command: 'sh', args: ['-c', 'true'] })).toMatchObject({ result: 'pass' });
  });
});
