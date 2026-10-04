/** The tools through MCP (in memory), and the plugin as NodCut starts it (needs `pnpm build`). */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { findChrome, findOnPath } from './hyperframes.js';
import { definition, outputSize } from './plugin.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const ffmpeg = findOnPath('ffmpeg');
const chrome = findChrome(undefined);
const tmp = mkdtempSync(join(tmpdir(), 'cp-hyperframes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Three seconds of a test pattern with a tone, 320×180. */
function sampleVideo(): string {
  const file = join(tmp, 'sample.mp4');
  if (!existsSync(file))
    execFileSync(ffmpeg!, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x180:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440',
      '-t',
      '3',
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      file,
    ]);
  return file;
}

const clients: Client[] = [];
afterAll(async () => Promise.all(clients.map((c) => c.close())));

async function connect(env: NodeJS.ProcessEnv = {}) {
  const plugin = definePlugin({ ...definition, manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
const structured = <T>(r: Awaited<ReturnType<Client['callTool']>>) => r.structuredContent as T;

test('outputSize: the aspect asked for, as large as the source allows, even sizes', () => {
  const src = { width: 1920, height: 1080 };
  expect(outputSize(src)).toEqual({ width: 1920, height: 1080 });
  expect(outputSize(src, '9:16')).toEqual({ width: 608, height: 1080 });
  expect(outputSize(src, '1:1')).toEqual({ width: 1080, height: 1080 });
  expect(outputSize(src, '4:3')).toEqual({ width: 1440, height: 1080 });
  expect(outputSize({ width: 1080, height: 1920 }, '16:9')).toEqual({ width: 1080, height: 608 });
  expect(outputSize(src, '9:16', undefined, 1920)).toEqual({ width: 1080, height: 1920 });
  expect(outputSize(src, undefined, 641, 361)).toEqual({ width: 642, height: 362 });
});

describe('tools', () => {
  test('the four tools are offered; doctor names what is missing', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'compose',
      'doctor',
      'lint',
      'render',
    ]);
    const d = structured<{ ok: boolean; hyperframes: string; problems: string[] }>(
      await c.callTool({ name: 'doctor', arguments: {} }),
    );
    expect(d.hyperframes).toMatch(/^\d+\.\d+\.\d+/);
    expect(d.ok).toBe(d.problems.length === 0);
  });

  test('a Chrome setting that points nowhere is a problem, not a fallback', async () => {
    const c = await connect({ NODCUT_SETTING_BROWSER_PATH: '/nowhere/chrome' });
    const d = structured<{ chrome: string | null }>(await c.callTool({ name: 'doctor', arguments: {} }));
    expect(d.chrome).toBeNull();
  });

  test('compose refuses a source that is not there', async () => {
    const c = await connect();
    const r = await c.callTool({ name: 'compose', arguments: { source: join(tmp, 'missing.mp4') } });
    expect(r.isError).toBe(true);
    const code = structured<{ error: { code: string } }>(r).error.code;
    expect(['E_HYPERFRAMES_NO_SOURCE', 'E_HYPERFRAMES_NO_FFMPEG']).toContain(code);
  });

  test.skipIf(!ffmpeg)(
    'compose writes a project: index.html, the source linked in, gsap, the edit',
    async () => {
      const c = await connect();
      const project = join(tmp, 'project');
      const r = await c.callTool({
        name: 'compose',
        arguments: {
          source: sampleVideo(),
          project,
          aspect: '1:1',
          segments: [
            { start: 500, end: 1500 },
            { start: 2000, end: 3000 },
          ],
          words: [
            { text: 'Hello', start: 600, end: 900 },
            { text: 'there.', start: 1000, end: 1300 },
          ],
          crop: [{ t: 0, x: 0.3, y: 0.5 }],
          title: { text: 'Sample', durationMs: 800 },
        },
      });
      expect(r.isError).toBeFalsy();
      expect(structured(r)).toMatchObject({
        project,
        width: 180,
        height: 180,
        fps: 30,
        durationMs: 2000,
        clips: 2,
        captionLines: 1,
        source: { width: 320, height: 180, hasAudio: true },
      });
      const html = readFileSync(join(project, 'index.html'), 'utf8');
      expect(html).toContain('src="assets/source.mp4"');
      expect(html).toContain('data-media-start="0.5"');
      expect(existsSync(join(project, 'assets/source.mp4'))).toBe(true);
      expect(existsSync(join(project, 'vendor/gsap.min.js'))).toBe(true);
      expect(JSON.parse(readFileSync(join(project, 'nodcut-edit.json'), 'utf8')).spec.segments).toHaveLength(
        2,
      );
    },
  );

  test.skipIf(!ffmpeg)('compose refuses a segment past the end of the source', async () => {
    const c = await connect();
    const r = await c.callTool({
      name: 'compose',
      arguments: { source: sampleVideo(), project: join(tmp, 'p2'), segments: [{ start: 0, end: 9000 }] },
    });
    expect(structured<{ error: { code: string } }>(r).error.code).toBe('E_HYPERFRAMES_BAD_SEGMENT');
  });

  // A real render: headless Chrome and ffmpeg, about half a minute. Opt in with HYPERFRAMES_E2E=1.
  test.skipIf(!ffmpeg || !chrome || !process.env.HYPERFRAMES_E2E)(
    'lint passes and render writes an MP4 of the right length',
    async () => {
      const c = await connect();
      const project = join(tmp, 'e2e');
      await c.callTool({
        name: 'compose',
        arguments: {
          source: sampleVideo(),
          project,
          segments: [
            { start: 0, end: 1000 },
            { start: 2000, end: 3000 },
          ],
          words: [{ text: 'Hi', start: 100, end: 500 }],
          captions: { style: 'karaoke' },
          crop: [
            { t: 0, x: 0.3, y: 0.5 },
            { t: 3000, x: 0.7, y: 0.5 },
          ],
          aspect: '9:16',
        },
      });
      const lint = structured<{ ok: boolean; output: string }>(
        await c.callTool({ name: 'lint', arguments: { project } }),
      );
      expect(lint.ok, lint.output).toBe(true);
      const r = await c.callTool({ name: 'render', arguments: { project, quality: 'draft' } });
      expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
      const { file } = structured<{ file: string }>(r);
      const probe = execFileSync(findOnPath('ffprobe')!, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        file,
      ]);
      expect(Number(probe.toString())).toBeCloseTo(2, 0);
    },
    180_000,
  );
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as NodCut starts it', () => {
  test('testPlugin passes', async () => {
    const r = await testPlugin(DIR);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['extra tool doctor', 'pass'],
      ['extra tool compose', 'pass'],
      ['extra tool lint', 'pass'],
      ['extra tool render', 'pass'],
    ]);
  });
});
