/**
 * The tools through MCP (in memory), real renders, and the plugin as CutPilot starts it (needs
 * `pnpm build`). Renders need ffmpeg and a Chrome (an installed one, or one Puppeteer
 * downloaded); they are skipped only on a machine that has neither.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { definition, progressOf } from './plugin.js';
import { compose, TEMPLATES } from './templates.js';
import { findChrome, findOnPath, gsapPath, puppeteerBrowsers, runCli, toolchain } from './toolchain.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const ffprobe = findOnPath('ffprobe');
const canRender = !!findOnPath('ffmpeg') && !!ffprobe && !!findChrome(undefined);
const tmp = mkdtempSync(join(tmpdir(), 'cp-html-motion-'));

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

async function connect(env: NodeJS.ProcessEnv = {}) {
  const plugin = definePlugin({ ...definition, manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
type Result = Awaited<ReturnType<Client['callTool']>>;
const structured = <T>(r: Result) => r.structuredContent as T;
const errorOf = (r: Result) => structured<{ error: { code: string; message: string; fix: string } }>(r).error;

describe('tools', () => {
  test('a generator with doctor as its extra tool', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'doctor',
      'generate',
      'list_templates',
    ]);
    const d = structured<{ ok: boolean; hyperframes: string; problems: string[] }>(
      await c.callTool({ name: 'doctor', arguments: {} }),
    );
    expect(d.hyperframes).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.ok).toBe(d.problems.length === 0);
  });

  test('list_templates lists the five, with schemas', async () => {
    const c = await connect();
    const r = structured<{ templates: { id: string; params: { type: string } }[] }>(
      await c.callTool({ name: 'list_templates', arguments: { aspect: '9:16' } }),
    );
    expect(r.templates.map((t) => t.id)).toEqual(TEMPLATES.map((t) => t.id));
    expect(r.templates.every((t) => t.params.type === 'object')).toBe(true);
  });

  test('generate refuses an unknown template, bad params and a length out of range, saying what to do', async () => {
    const c = await connect();
    const base = { width: 1080, height: 1920, fps: 30 };
    const unknown = errorOf(
      await c.callTool({ name: 'generate', arguments: { ...base, template: 'intro' } }),
    );
    expect(unknown).toEqual({
      code: 'E_PLUGIN_BAD_INPUT',
      message: 'there is no template "intro"',
      fix: 'use one of title-card, chapter, quote, bullets, end-card',
    });
    const bad = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { ...base, template: 'bullets', params: { items: 'x' } },
      }),
    );
    expect(bad.code).toBe('E_PLUGIN_BAD_INPUT');
    expect(bad.message).toBe('bullets: items: Invalid input: expected array, received string');
    expect(bad.fix).toMatch(/^pass params as bullets's schema in list_templates says, e\.g\. \{"title"/);
    const long = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { ...base, template: 'chapter', params: { title: 'x' }, durationMs: 60_000 },
      }),
    );
    expect(long).toMatchObject({ code: 'E_PLUGIN_BAD_INPUT', message: 'chapter lasts 1–8 s, not 60 s' });
  });

  test('a Chrome setting that points nowhere is a problem, not a fallback', async () => {
    const c = await connect({ CUTPILOT_SETTING_BROWSER_PATH: '/nowhere/chrome' });
    const d = structured<{ chrome: string | null; ok: boolean }>(
      await c.callTool({ name: 'doctor', arguments: {} }),
    );
    expect(d.chrome).toBeNull();
    expect(d.ok).toBe(false);
  });

  test('progress is read from HyperFrames lines', () => {
    expect(progressOf('  ███░░  46%  Streaming frame 23/60 (2 workers)')).toBe(0.46);
    expect(progressOf('Assembling final video')).toBeNull();
  });
});

describe('finding Chrome', () => {
  test('PUPPETEER_EXECUTABLE_PATH is used when set and there', () => {
    const fake = join(tmp, 'chrome');
    writeFileSync(fake, '');
    expect(findChrome(undefined, { PATH: '', PUPPETEER_EXECUTABLE_PATH: fake })).toBe(fake);
    expect(findChrome('', { PATH: '', HYPERFRAMES_BROWSER_PATH: fake })).toBe(fake);
    expect(findChrome(fake, { PATH: '' })).toBe(fake);
  });

  test("Puppeteer's downloads: the headless shell first, newest version first", () => {
    const home = join(tmp, 'home');
    const put = (kind: string, version: string, exe: string) => {
      const d = join(home, '.cache/puppeteer', kind, `linux-${version}`, `${kind}-linux64`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, exe), '');
      return join(d, exe);
    };
    const oldShell = put('chrome-headless-shell', '120.0.1.2', 'chrome-headless-shell');
    const newShell = put('chrome-headless-shell', '154.0.8037.57', 'chrome-headless-shell');
    const chrome = put('chrome', '154.0.8037.57', 'chrome');
    if (process.platform === 'linux') expect(puppeteerBrowsers(home)).toEqual([newShell, oldShell, chrome]);
    expect(puppeteerBrowsers(join(tmp, 'nobody'))).toEqual([]);
  });
});

describe.skipIf(!canRender)('renders (Chrome + ffmpeg)', () => {
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

  test("every template passes HyperFrames' linter at 9:16 and 16:9", async () => {
    const tools = toolchain(undefined);
    for (const t of TEMPLATES)
      for (const [width, height] of [
        [1080, 1920],
        [1920, 1080],
      ] as const) {
        const dir = join(tmp, 'lint', `${t.id}-${width}`);
        mkdirSync(join(dir, 'vendor'), { recursive: true });
        writeFileSync(join(dir, 'vendor/gsap.min.js'), readFileSync(gsapPath()));
        const frame = { width, height, fps: 30, durationMs: t.defaultDurationMs };
        writeFileSync(
          join(dir, 'index.html'),
          compose(t, t.params.parse(t.example), frame, 'vendor/gsap.min.js').html,
        );
        const lines: string[] = [];
        const r = await runCli(['lint', dir], {
          cwd: dir,
          tools,
          signal: new AbortController().signal,
          onLine: (l) => lines.push(l),
        });
        expect(r.code, lines.join('\n')).toBe(0);
        expect(lines.join('\n')).toMatch(/0 errors?, 0 warnings?/);
      }
  }, 120_000);

  test('generate renders an MP4 of the size and length asked for, and the same request again is not rendered twice', async () => {
    const c = await connect({ CUTPILOT_SETTING_QUALITY: 'draft' });
    const args = {
      template: 'title-card',
      params: { title: `Render check ${process.pid}`, subtitle: 'at 16:9' },
      width: 640,
      height: 360,
      fps: 25,
      durationMs: 1500,
    };
    const progress: number[] = [];
    const r = await c.callTool({ name: 'generate', arguments: args }, undefined, {
      onprogress: (p) => progress.push(p.progress),
    });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const out = structured<{
      file: string;
      durationMs: number;
      width: number;
      height: number;
      hasAudio: boolean;
    }>(r);
    expect(out).toMatchObject({ width: 640, height: 360, hasAudio: false });
    expect(out.durationMs).toBeGreaterThanOrEqual(1450);
    expect(out.durationMs).toBeLessThanOrEqual(1550);
    const p = probe(out.file);
    expect(p.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 640, height: 360 });
    expect(Number(p.format.duration)).toBeCloseTo(1.5, 1);
    expect(progress.at(-1)).toBe(100);

    const started = Date.now();
    const again = structured<{ file: string }>(await c.callTool({ name: 'generate', arguments: args }));
    expect(again.file).toBe(out.file);
    expect(Date.now() - started).toBeLessThan(2000);
  }, 180_000);
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')) || !canRender)('as CutPilot starts it', () => {
  test('testPlugin renders every template with its example', async () => {
    const r = await testPlugin(DIR, { templates: 'all', settings: { quality: 'draft' }, timeoutMs: 120_000 });
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers list_templates', 'pass'],
      ['offers generate', 'pass'],
      ['extra tool doctor', 'pass'],
      ['list_templates answers per contract', 'pass'],
      ...TEMPLATES.flatMap((t) => [
        [`generate ${t.id} answers per contract`, 'pass'],
        [`generate ${t.id} makes the clip asked for`, 'pass'],
      ]),
    ]);
  }, 600_000);
});
