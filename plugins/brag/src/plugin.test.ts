/**
 * The tools through MCP (in memory), the project folder's rules, and real HyperFrames runs
 * (check, snapshot, render with a baked poster) when this machine has a Chrome and ffmpeg: an
 * installed Chrome, one Puppeteer or Playwright downloaded, or BRAG_TEST_CHROME.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { definition, readCheck } from './plugin.js';
import { allSounds, inside, projectsRoot, slug, soundsDir } from './project.js';
import { findChrome, findOnPath } from './toolchain.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
// resolved: macOS's temp folder is reached through a link (/var → /private/var), and the tools
// answer resolved paths
const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cp-brag-')));

/** A Chrome for the real runs: the plugin's own search, else a Playwright download. */
function testChrome(): string | null {
  if (process.env.BRAG_TEST_CHROME) return process.env.BRAG_TEST_CHROME;
  const found = findChrome(undefined);
  if (found) return found;
  for (const root of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache', 'ms-playwright')]) {
    if (!root || !existsSync(root)) continue;
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x))) {
      const exe = join(root, d, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}
const chrome = testChrome();
const ffprobe = findOnPath('ffprobe');
const canRender = !!chrome && !!findOnPath('ffmpeg') && !!ffprobe;
const ENV = {
  NODCUT_SETTING_OUTPUT_DIR: join(tmp, 'projects'),
  NODCUT_SETTING_BROWSER_PATH: chrome ?? '',
};

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(env: NodeJS.ProcessEnv = ENV) {
  const plugin = definePlugin({ ...definition, manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
type Result = Awaited<ReturnType<Client['callTool']>>;
const ok = <T>(r: Result) => {
  expect(r.isError, JSON.stringify(r.content).slice(0, 500)).toBeFalsy();
  return r.structuredContent as T;
};
const errorOf = (r: Result) => {
  expect(r.isError).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
};
const text = (r: Result) => (r.content as { type: string; text: string }[])[0]!.text;
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args }, undefined, { timeout: 300_000 });

async function start(c: Client, args: Record<string, unknown> = {}) {
  return ok<{ project: string; width: number; height: number; starter: string }>(
    await call(c, 'start_project', { name: 'Qaychi Café', ...args }),
  );
}

describe('tools', () => {
  test('extra tools only, the guide first', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'add_asset',
      'check',
      'doctor',
      'guide',
      'list_sounds',
      'render',
      'snapshot',
      'start_project',
      'write_file',
    ]);
    const workflow = text(await call(c, 'guide'));
    expect(workflow).toMatch(/Hook \(2–3 s\) → Reveal/);
    expect(workflow).toMatch(/start_project/);
    expect(text(await call(c, 'guide', { topic: 'tones' }))).toMatch(/yc-parody/);
    expect(text(await call(c, 'guide', { topic: 'hyperframes' }))).toMatch(/window\.__timelines\.main/);
  });

  test('a HyperFrames docs page comes from the CLI, without its telemetry notice', async () => {
    const c = await connect();
    const page = text(await call(c, 'guide', { topic: 'hyperframes-data-attributes' }));
    expect(page).toMatch(/data-start/);
    expect(page).not.toMatch(/telemetry/i);
  });

  test("start_project makes the folder with a starter at the format's size", async () => {
    const c = await connect();
    const p = await start(c, { format: 'vertical', durationS: 18 });
    expect(p.project.startsWith(join(tmp, 'projects', 'qaychi-cafe-'))).toBe(true);
    expect(p).toMatchObject({ width: 1080, height: 1920 });
    const html = readFileSync(join(p.project, 'composition', 'index.html'), 'utf8');
    expect(html).toBe(p.starter);
    expect(html).toMatch(/data-width="1080" data-height="1920" data-fps="30"/);
    expect(html).toMatch(/data-duration="18"/);
    expect(existsSync(join(p.project, 'composition', 'vendor', 'gsap.min.js'))).toBe(true);
    // a second project of the same name the same second gets its own folder
    expect((await start(c)).project).not.toBe(p.project);
  });

  test('write_file and add_asset stay inside the project', async () => {
    const c = await connect();
    const { project } = await start(c);
    expect(
      ok<{ written: string }>(
        await call(c, 'write_file', { project, path: 'brag-plan.md', content: '# Plan' }),
      ).written,
    ).toBe(join(project, 'brag-plan.md'));
    for (const path of ['../escape.md', '/etc/passwd', 'composition/../../x', '.brag-project'])
      expect(errorOf(await call(c, 'write_file', { project, path, content: 'x' })).code).toBe(
        'E_PLUGIN_BAD_INPUT',
      );
    // a link inside the project that points out of it
    mkdirSync(join(tmp, 'outside'), { recursive: true });
    symlinkSync(join(tmp, 'outside'), join(project, 'out'));
    expect(errorOf(await call(c, 'write_file', { project, path: 'out/x.md', content: 'x' })).code).toBe(
      'E_PLUGIN_BAD_INPUT',
    );
    expect(existsSync(join(tmp, 'outside', 'x.md'))).toBe(false);

    const logo = join(tmp, 'logo.svg');
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(ok(await call(c, 'add_asset', { project, file: logo }))).toMatchObject({ src: 'assets/logo.svg' });
    expect(ok(await call(c, 'add_asset', { project, file: logo, as: 'brand/mark.svg' }))).toMatchObject({
      src: 'assets/brand/mark.svg',
    });
    expect(
      ok(await call(c, 'add_asset', { project, sound: 'impact/impactSoft_medium_001.ogg' })),
    ).toMatchObject({
      src: 'assets/sfx/impactSoft_medium_001.ogg',
    });
    expect(errorOf(await call(c, 'add_asset', { project, sound: 'nope.ogg' })).message).toMatch(
      /no bundled sound/,
    );
    // a guessed path to a library track: the fix says how music from find_music gets in
    expect(
      errorOf(await call(c, 'add_asset', { project, file: join(tmp, 'music', 'tracks', 'bright-side.ogg') })),
    ).toMatchObject({
      code: 'E_PLUGIN_BAD_INPUT',
      fix: expect.stringMatching(/never a guessed one.*set_music/),
    });
    expect(errorOf(await call(c, 'add_asset', { project, file: logo, as: '../../x.svg' })).code).toBe(
      'E_PLUGIN_BAD_INPUT',
    );
    expect(errorOf(await call(c, 'add_asset', { project })).message).toBe('pass either file or sound');
  });

  test('a folder that is not a brag project is refused, saying what to call', async () => {
    const c = await connect();
    expect(errorOf(await call(c, 'write_file', { project: tmp, path: 'x.md', content: 'x' }))).toMatchObject({
      code: 'E_BRAG_NO_PROJECT',
      fix: 'call start_project first and pass the folder it returns as project',
    });
  });

  test('list_sounds filters by use, family and risk; every listed file is there', async () => {
    const c = await connect();
    const all = allSounds();
    expect(all).toHaveLength(228);
    for (const s of all) expect(existsSync(join(soundsDir(), s.file)), s.file).toBe(true);
    const r = ok<{ count: number; sounds: { file: string; highFrequencyRisk: string; uses: string[] }[] }>(
      await call(c, 'list_sounds', { use: 'reveal', maxRisk: 'low' }),
    );
    expect(r.count).toBeGreaterThan(0);
    expect(
      r.sounds.every((s) => s.highFrequencyRisk === 'low' && s.uses.some((u) => u.includes('reveal'))),
    ).toBe(true);
    expect(
      ok<{ sounds: { file: string }[] }>(await call(c, 'list_sounds', { family: 'keyboard' })).sounds.every(
        (s) => s.file.startsWith('keyboard/'),
      ),
    ).toBe(true);
  });
});

describe('helpers', () => {
  test('slugs, the default folder, and paths inside', () => {
    expect(slug('Qaychi Café!')).toBe('qaychi-cafe');
    expect(slug('!!!')).toBe('brag');
    expect(projectsRoot('', '/home/u')).toBe(
      join('/home/u', process.platform === 'darwin' ? 'Movies' : 'Videos', 'Brag'),
    );
    expect(projectsRoot(' /x/y ', '/home/u')).toBe('/x/y');
    const p = mkdtempSync(join(tmp, 'p-'));
    expect(inside(p, 'composition/index.html')).toBe(join(p, 'composition', 'index.html'));
    expect(() => inside(p, '..')).toThrow(/not a path inside/);
  });

  test('a project reached through a symlink (macOS /var is /private/var) works and is answered resolved', async () => {
    const real = mkdtempSync(join(tmp, 'real-'));
    const link = join(tmp, `link-${process.pid}`);
    symlinkSync(real, link);
    const p = join(link, 'p');
    mkdirSync(p);
    expect(inside(p, 'composition/index.html')).toBe(join(realpathSync(p), 'composition', 'index.html'));
    expect(() => inside(p, '../x')).toThrow(/not a path inside/);

    const c = await connect({ ...ENV, NODCUT_SETTING_OUTPUT_DIR: join(link, 'projects') });
    const { project } = await start(c);
    expect(project).toBe(realpathSync(project));
    expect(
      ok<{ written: string }>(await call(c, 'write_file', { project, path: 'a.md', content: 'a' })).written,
    ).toBe(join(project, 'a.md'));
    const logo = join(link, 'logo.svg');
    writeFileSync(logo, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(
      ok(
        await call(c, 'add_asset', {
          project: join(link, 'projects', project.split('/').pop()!),
          file: logo,
        }),
      ),
    ).toMatchObject({
      src: 'assets/logo.svg',
      path: join(project, 'composition', 'assets', 'logo.svg'),
    });
  });

  test("check's JSON: errors first, counted across sections", () => {
    const r = readCheck(
      JSON.stringify({
        ok: false,
        lint: {
          errorCount: 0,
          warningCount: 1,
          findings: [{ severity: 'warning', code: 'w', message: 'a warning' }],
        },
        layout: {
          errorCount: 1,
          warningCount: 0,
          findings: [
            {
              severity: 'error',
              code: 'overflow',
              message: 'text overflows',
              selector: '#t',
              time: 2.5,
              fixHint: 'shrink it',
            },
          ],
        },
        samples: [1, 2],
      }),
    );
    expect(r).toMatchObject({ ok: false, errors: 1, warnings: 1 });
    expect(r.findings[0]).toEqual({
      section: 'layout',
      severity: 'error',
      code: 'overflow',
      message: 'text overflows',
      selector: '#t',
      time: 2.5,
      fix: 'shrink it',
    });
  });
});

describe.skipIf(!canRender)('with Chrome and ffmpeg', () => {
  const probe = (file: string) =>
    JSON.parse(
      execFileSync(ffprobe!, [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        file,
      ]).toString(),
    ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };

  test('the starter passes check; a broken composition does not', async () => {
    const c = await connect();
    const { project } = await start(c, { durationS: 3 });
    const good = ok<{ ok: boolean; errors: number; warnings: number }>(await call(c, 'check', { project }));
    expect(good).toMatchObject({ ok: true, errors: 0, warnings: 0 });
    await call(c, 'write_file', {
      project,
      path: 'composition/index.html',
      content: '<!doctype html><html><body><div id="root">no composition here</div></body></html>',
    });
    const bad = ok<{ ok: boolean; errors: number; findings: { severity: string }[] }>(
      await call(c, 'check', { project }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors).toBeGreaterThan(0);
    expect(bad.findings[0]!.severity).toBe('error');
  }, 300_000);

  test('snapshot returns a still per time, as images', async () => {
    const c = await connect();
    const { project } = await start(c, { durationS: 3 });
    const r = await call(c, 'snapshot', { project, at: [0.1, 2] });
    expect(r.isError, JSON.stringify(r.content).slice(0, 300)).toBeFalsy();
    const content = r.content as { type: string; mimeType?: string }[];
    expect(content.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(content.find((b) => b.type === 'image')!.mimeType).toBe('image/jpeg');
  }, 300_000);

  test('render writes brag.mp4 with music and a poster baked in as frame 0', async () => {
    const c = await connect({ ...ENV, NODCUT_SETTING_QUALITY: 'draft' });
    const { project } = await start(c, { name: 'Render check', format: 'square', durationS: 2 });
    // a second of tone as the music
    const tone = join(tmp, 'tone.wav');
    execFileSync(findOnPath('ffmpeg')!, [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      tone,
    ]);
    ok(await call(c, 'add_asset', { project, file: tone, as: 'music.wav' }));
    const html = readFileSync(join(project, 'composition', 'index.html'), 'utf8').replace(
      '</div>\n    </div>',
      '</div>\n      <audio id="music" class="clip" src="assets/music.wav" data-start="0" data-duration="2" data-volume="0.5"></audio>\n    </div>',
    );
    ok(await call(c, 'write_file', { project, path: 'composition/index.html', content: html }));
    ok(await call(c, 'write_file', { project, path: 'share-copy.txt', content: 'Look at it go.' }));

    const progress: number[] = [];
    const r = await c.callTool({ name: 'render', arguments: { project, posterAt: 1.5 } }, undefined, {
      timeout: 600_000,
      onprogress: (p) => progress.push(p.progress),
    });
    const out = ok<{
      file: string;
      poster: string;
      shareCopy: string;
      durationMs: number;
      width: number;
      height: number;
      hasAudio: boolean;
    }>(r);
    expect(out).toMatchObject({
      file: join(project, 'brag.mp4'),
      poster: join(project, 'brag.jpg'),
      shareCopy: join(project, 'share-copy.txt'),
      width: 1080,
      height: 1080,
      hasAudio: true,
    });
    expect(out.durationMs).toBeGreaterThanOrEqual(1900);
    expect(out.durationMs).toBeLessThanOrEqual(2100);
    expect(progress.length).toBeGreaterThan(1);
    const p = probe(out.file);
    expect(p.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 1080, height: 1080 });

    // frame 0 is the poster (the title fully in); the frames after it are the starter's empty
    // opening (the title fades in from 0.2 s), so frame 0 is brighter than frame 3
    const ffmpeg = findOnPath('ffmpeg')!;
    const brightness = (frame: number) => {
      const log = spawnSync(
        ffmpeg,
        [
          '-i',
          out.file,
          '-vf',
          `select=eq(n\\,${frame}),signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        { encoding: 'utf8' },
      ).stderr;
      return Number(/YAVG=([\d.]+)/.exec(log)?.[1]);
    };
    expect(brightness(0)).toBeGreaterThan(brightness(3) + 1);
  }, 900_000);
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as NodCut starts it', () => {
  test('testPlugin: manifest, icon, starts, offers its tools', async () => {
    const r = await testPlugin(DIR, { timeoutMs: 60_000 });
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => c.name)).toContain('extra tool start_project');
  }, 120_000);
});
