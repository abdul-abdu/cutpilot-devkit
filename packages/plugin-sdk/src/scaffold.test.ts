/**
 * Every kind of new plugin builds and passes testPlugin() as generated. The generated folders
 * resolve the SDK, @types/node and vitest through one node_modules of links next to them (what
 * `npm install` with a `file:` SDK makes), so nothing is downloaded. Needs the built SDK.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pluginCli } from './cli.js';
import { formatReport, findOnPath, validatePluginFolder } from './validate.js';
import { testPlugin, type TestOptions } from './harness.js';
import {
  SCAFFOLD_KINDS,
  ScaffoldError,
  scaffoldPlugin,
  sdkVersion,
  TEMPLATE_DEV_DEPENDENCIES,
  type ScaffoldKind,
} from './scaffold.js';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const ROOT = join(PKG, '../..');
const built = existsSync(join(PKG, 'dist/index.js'));
const KINDS = Object.keys(SCAFFOLD_KINDS) as ScaffoldKind[];

const tmp = mkdtempSync(join(tmpdir(), 'cp-scaffold-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const json = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

describe('scaffoldPlugin', () => {
  test('writes the manifest, package, tsconfig, sources, test, README and .gitignore', () => {
    const r = scaffoldPlugin({ dir: join(tmp, 'files', 'my-titles'), id: 'my-titles' });
    expect(r).toMatchObject({ id: 'my-titles', name: 'My Titles', kind: 'tools' });
    expect(r.files.sort()).toEqual(
      [
        '.gitignore',
        'README.md',
        'cutpilot-plugin.json',
        'package.json',
        'src/index.test.ts',
        'src/index.ts',
        'src/plugin.ts',
        'tsconfig.json',
      ].sort(),
    );
    const pkg = json(join(r.dir, 'package.json'));
    expect(pkg).toMatchObject({
      name: 'my-titles',
      type: 'module',
      dependencies: { '@cutpilot/plugin-sdk': `^${sdkVersion()}` },
    });
    expect(json(join(r.dir, 'tsconfig.json')).extends).toBeUndefined();
    expect(readFileSync(join(r.dir, 'README.md'), 'utf8')).toContain('cutpilot plugin install . --link');
  });

  test("each kind's manifest is valid and asks for what its kind reads", () => {
    for (const kind of KINDS) {
      const r = scaffoldPlugin({ dir: join(tmp, 'manifests', kind), id: `m-${kind}`, kind });
      const v = validatePluginFolder(r.dir);
      // the manifest is fine; the command fails until the plugin is built
      expect(v.checks.map((c) => [c.name, c.result])).toEqual([
        ['manifest', 'pass'],
        ['command', 'fail'],
      ]);
      expect(v.checks[1]!.fix).toMatch(/npm run build/);
      const want = SCAFFOLD_KINDS[kind];
      expect(v.manifest!.kinds).toEqual(want ? [want] : []);
    }
    expect(json(join(tmp, 'manifests/transcriber/cutpilot-plugin.json')).permissions.reads).toEqual([
      'audio',
    ]);
  });

  test('a manifest kind works as --kind too, and a name and SDK spec are kept', () => {
    const r = scaffoldPlugin({
      dir: join(tmp, 'named'),
      id: 'tunes',
      kind: 'asset:music',
      name: 'My Tunes',
      sdk: 'file:/opt/sdk',
    });
    expect(r.kind).toBe('music');
    expect(json(join(r.dir, 'cutpilot-plugin.json'))).toMatchObject({
      name: 'My Tunes',
      kinds: ['asset:music'],
    });
    expect(json(join(r.dir, 'package.json')).dependencies['@cutpilot/plugin-sdk']).toBe('file:/opt/sdk');
  });

  test('refuses a bad id, an unknown kind, a non-empty folder and a file', () => {
    const refused = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ScaffoldError);
        return `${(e as ScaffoldError).message} | ${(e as ScaffoldError).fix}`;
      }
      throw new Error('not refused');
    };
    expect(refused(() => scaffoldPlugin({ dir: join(tmp, 'x1'), id: 'My_Plugin' }))).toMatch(
      /^"My_Plugin" can't be a plugin id: ids are kebab-case.* \| use lowercase words/,
    );
    expect(refused(() => scaffoldPlugin({ dir: join(tmp, 'x2'), id: 'a'.repeat(41) }))).toMatch(
      /40 characters/,
    );
    expect(refused(() => scaffoldPlugin({ dir: join(tmp, 'x3'), id: 'ok', kind: 'video' as never }))).toMatch(
      /^there is no plugin kind "video" \| use one of tools, transcriber/,
    );
    mkdirSync(join(tmp, 'used'));
    writeFileSync(join(tmp, 'used/notes.txt'), 'mine');
    expect(refused(() => scaffoldPlugin({ dir: join(tmp, 'used'), id: 'ok' }))).toMatch(/isn't empty/);
    expect(refused(() => scaffoldPlugin({ dir: join(tmp, 'used/notes.txt'), id: 'ok' }))).toMatch(
      /is a file/,
    );
    expect(existsSync(join(tmp, 'x1'))).toBe(false);
    expect(existsSync(join(tmp, 'x3'))).toBe(false);
  });

  test("the template's dev tools are the versions this repo builds and tests with", () => {
    const root = json(join(ROOT, 'package.json')).devDependencies;
    for (const [name, range] of Object.entries(TEMPLATE_DEV_DEPENDENCIES)) expect(range).toBe(root[name]);
  });

  test('cutpilot-plugin new: writes the folder and says what to do next; refusals exit 1 with a fix', async () => {
    const lines: string[] = [];
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(await pluginCli(['new', 'cli-made', '--kind', 'transcriber'], (s) => lines.push(s))).toBe(0);
      expect(existsSync(join(tmp, 'cli-made/src/plugin.ts'))).toBe(true);
      expect(lines.join('\n')).toMatch(
        /^created cli-made \(transcriber\) in .*\n[\s\S]*next:\n {2}cd cli-made\n/,
      );
      lines.length = 0;
      expect(await pluginCli(['new', 'cli-made'], (s) => lines.push(s))).toBe(1);
      expect(lines.join('\n')).toMatch(/isn't empty\nfix: choose a new or empty folder/);
      expect(await pluginCli(['new'], () => {})).toBe(2);
      expect(await pluginCli(['new', 'a', '--colour', 'red'], () => {})).toBe(2);
    } finally {
      process.chdir(cwd);
    }
  });
});

/** What each kind's generated test passes to testPlugin(), so every contract call is made. */
function optionsFor(kind: ScaffoldKind, dir: string): TestOptions {
  if (kind === 'reframe-track') {
    const video = join(dir, 'stand-in.mp4');
    writeFileSync(video, '');
    return { fixtures: { video } };
  }
  if (kind === 'sound') return { sound: { kind: 'sfx', prompt: 'a short beep', durationMs: 500 } };
  if (kind === 'generator') return { templates: findOnPath('ffmpeg') ? 'all' : 'none' };
  return {};
}

describe.skipIf(!built)('every kind, generated, builds and passes testPlugin()', () => {
  const gen = join(tmp, 'built');
  const dirs = Object.fromEntries(KINDS.map((k) => [k, join(gen, `new-${k}`)])) as Record<
    ScaffoldKind,
    string
  >;
  // a clean environment for the vitest started inside this one
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(VITEST|NODE_OPTIONS$)/.test(k)),
  );
  const node = (args: string[]) => spawnSync(process.execPath, args, { cwd: gen, encoding: 'utf8', env });

  beforeAll(() => {
    for (const kind of KINDS) scaffoldPlugin({ dir: dirs[kind], id: `new-${kind}`, kind });
    // one node_modules above the plugins, as `npm install` would make in each
    const link = (to: string, name: string) => {
      mkdirSync(join(gen, 'node_modules', name, '..'), { recursive: true });
      symlinkSync(to, join(gen, 'node_modules', name), 'junction');
    };
    link(PKG, '@cutpilot/plugin-sdk');
    link(join(ROOT, 'node_modules/@types/node'), '@types/node');
    link(join(ROOT, 'node_modules/vitest'), 'vitest');
  });

  test('npm run build (tsc) compiles each, and the tests typecheck', () => {
    const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
    const build = node([tsc, '-b', ...Object.values(dirs)]);
    expect(build.stdout + build.stderr).toBe('');
    expect(build.status).toBe(0);
    for (const d of Object.values(dirs)) expect(existsSync(join(d, 'dist/index.js'))).toBe(true);

    writeFileSync(
      join(gen, 'tsconfig.tests.json'),
      JSON.stringify({
        extends: './new-tools/tsconfig.json',
        compilerOptions: { noEmit: true, rootDir: '.' },
        include: ['new-*/src'],
        exclude: [],
      }),
    );
    const check = node([tsc, '-p', 'tsconfig.tests.json']);
    expect(check.stdout + check.stderr).toBe('');
  }, 60_000);

  test.each(KINDS)(
    '%s passes testPlugin() with every contract call made',
    async (kind) => {
      const r = await testPlugin(dirs[kind], optionsFor(kind, gen));
      expect(r.ok, formatReport(r)).toBe(true);
      expect(r.checks.filter((c) => c.result === 'skip')).toEqual([]);
      if (kind === 'tools') expect(r.checks.map((c) => c.name)).toContain('extra tool suggest_titles');
    },
    30_000,
  );

  test("the generated tests pass (npm test's vitest run)", () => {
    const vitest = join(ROOT, 'node_modules/vitest/vitest.mjs');
    const run = node([vitest, 'run', '--root', gen, '--reporter', 'dot']);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(new RegExp(`Test Files {2}${KINDS.length} passed`));
  }, 60_000);
});
