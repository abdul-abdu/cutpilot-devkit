/**
 * The plugin with a stand-in face helper written in Node (the real one needs a Mac): through MCP
 * in memory, and as NodCut starts it (needs `pnpm build`).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, ReframeTrackOutputSchema, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { bundlePlugin } from '../../../scripts/bundle-plugin.mjs';
import { expectedSamples, HELPER_ENV, helperPath } from './helper.js';
import { makeDefinition, type Options } from './plugin.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'cp-follow-'));
const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * A stand-in for bin/face-helper with the same arguments and output. Its "video" is a JSON
 * scene: the frame size and faces, each there from `from` to `to` ms, its centre moving from x0
 * to x1. `fail` makes it exit with that code; `garbage` prints a line that isn't JSON.
 */
const FAKE = join(tmp, 'fake-face-helper');
writeFileSync(
  FAKE,
  `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
const scene = JSON.parse(fs.readFileSync(a[0], 'utf8'));
if (scene.fail) { console.error('face-helper: ' + scene.fail.message); process.exit(scene.fail.code); }
const fps = Number(arg('--fps') ?? 5);
const ranges = (arg('--ranges') ?? '0-' + scene.durationMs).split(',').map((r) => r.split('-').map(Number));
console.log(JSON.stringify({ width: scene.width, height: scene.height, durationMs: scene.durationMs }));
if (scene.garbage) console.log('not json');
for (const [start, end] of ranges)
  for (let t = start; t <= end; t += 1000 / fps) {
    const ms = Math.round(t);
    const faces = scene.faces
      .filter((f) => ms >= f.from && ms < f.to)
      .map((f) => {
        const k = f.to > f.from ? (ms - f.from) / (f.to - f.from) : 0;
        const cx = f.x0 + ((f.x1 ?? f.x0) - f.x0) * k;
        return { x: cx - f.w / 2, y: f.cy - f.h / 2, w: f.w, h: f.h, confidence: f.confidence ?? 0.95 };
      });
    console.log(JSON.stringify({ t: ms, faces }));
  }
`,
);
chmodSync(FAKE, 0o755);

interface SceneFace {
  from: number;
  to: number;
  x0: number;
  x1?: number;
  cy: number;
  w: number;
  h: number;
  confidence?: number;
}
function scene(name: string, faces: SceneFace[], extra: Record<string, unknown> = {}): string {
  const file = join(tmp, `${name}.json`);
  writeFileSync(file, JSON.stringify({ width: 1920, height: 1080, durationMs: 12_000, faces, ...extra }));
  return file;
}

/** An interview: the speaker right of centre all along, someone walking through the back for a second. */
const INTERVIEW = scene('interview', [
  { from: 0, to: 12_000, x0: 0.74, cy: 0.38, w: 0.12, h: 0.22 },
  { from: 4000, to: 5000, x0: 0.1, x1: 0.3, cy: 0.3, w: 0.04, h: 0.07, confidence: 0.7 },
]);

async function connect(o: Options = { helper: FAKE }) {
  const plugin = definePlugin({ ...makeDefinition(o), manifest }, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}

type Result = Awaited<ReturnType<Client['callTool']>>;
const error = (r: Result) => {
  expect(r.isError, JSON.stringify(r.content)).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
};
const reframe = (c: Client, args: Record<string, unknown>, onprogress?: (p: { progress: number }) => void) =>
  c.callTool(
    { name: 'reframe_track', arguments: { aspect: '9:16', ranges: [{ start: 0, end: 12_000 }], ...args } },
    undefined,
    onprogress ? { onprogress } : undefined,
  );

describe('reframe_track', () => {
  test('follows the speaker at x ≈ 0.74 and ignores the passer-by, with progress', async () => {
    const progress: number[] = [];
    const r = await reframe(await connect(), { source: INTERVIEW }, (p) => progress.push(p.progress));
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    const out = ReframeTrackOutputSchema.parse(r.structuredContent);
    for (const k of out.keyframes) expect(Math.abs(k.x - 0.74)).toBeLessThanOrEqual(0.03);
    expect(out.confidence).toBeGreaterThan(0.9);
    expect(progress.length).toBeGreaterThan(2);
    expect(progress.at(-1)).toBe(100);
  });

  test('only the kept ranges are looked at, at the rate asked for', async () => {
    const walk = scene('walk', [
      { from: 0, to: 5000, x0: 0.3, cy: 0.4, w: 0.1, h: 0.18 },
      { from: 5000, to: 7000, x0: 0.3, x1: 0.7, cy: 0.4, w: 0.1, h: 0.18 },
      { from: 7000, to: 12_000, x0: 0.7, cy: 0.4, w: 0.1, h: 0.18 },
    ]);
    const ranges = [
      { start: 1000, end: 3000 },
      { start: 8000, end: 11_000 },
    ];
    const r = await reframe(await connect(), { source: walk, ranges, sampleFps: 10 });
    const out = ReframeTrackOutputSchema.parse(r.structuredContent);
    expect(out.keyframes[0]).toMatchObject({ t: 1000, x: expect.closeTo(0.3, 2) });
    expect(out.keyframes.at(-1)).toMatchObject({ t: 11_000, x: expect.closeTo(0.7, 2) });
    for (const k of out.keyframes) expect(k.t <= 3000 || k.t >= 8000).toBe(true);
  });

  test('a helper that fails: its message and a fix', async () => {
    const broken = scene('broken', [], { fail: { code: 4, message: 'x.mov has no video track' } });
    const e = error(await reframe(await connect(), { source: broken }));
    expect(e.code).toBe('E_FACE_HELPER_FAILED');
    expect(e.message).toMatch(/exit 4.*no video track/);
    expect(e.fix).toMatch(/video track/);
  });

  test('a helper that prints something else', async () => {
    const e = error(await reframe(await connect(), { source: scene('garbage', [], { garbage: true }) }));
    expect(e.code).toBe('E_FACE_HELPER_FAILED');
    expect(e.message).toMatch(/not json/);
  });

  test('no faces at all: the middle, confidence 0', async () => {
    const r = await reframe(await connect(), { source: scene('empty', []) });
    expect(r.structuredContent).toMatchObject({
      confidence: 0,
      keyframes: [{ t: 0, x: 0.5, y: 0.5 }, { t: 12_000 }],
    });
  });
});

describe('finding the helper', () => {
  test('not on a Mac, without an override: a clear error with a fix', () => {
    expect(() => helperPath({}, 'linux', DIR)).toThrow(/macOS only/);
    try {
      helperPath({}, 'win32', DIR);
    } catch (e) {
      expect(e).toMatchObject({
        code: 'E_FOLLOW_SPEAKER_UNSUPPORTED',
        fix: expect.stringMatching(/fixed crop/),
      });
    }
  });

  test('on a Mac without bin/face-helper: reinstall, or build it', () => {
    const empty = mkdtempSync(join(tmp, 'plugin-'));
    expect(() => helperPath({}, 'darwin', empty)).toThrow(
      expect.objectContaining({ code: 'E_FACE_HELPER_MISSING' }),
    );
    mkdirSync(join(empty, 'bin'));
    copyFileSync(FAKE, join(empty, 'bin', 'face-helper'));
    chmodSync(join(empty, 'bin', 'face-helper'), 0o755);
    expect(helperPath({}, 'darwin', empty)).toBe(join(empty, 'bin', 'face-helper'));
  });

  test('the override wins on any platform, and must exist', () => {
    expect(helperPath({ [HELPER_ENV]: FAKE }, 'linux', DIR)).toBe(FAKE);
    expect(() => helperPath({ [HELPER_ENV]: join(tmp, 'nope') }, 'darwin', DIR)).toThrow(/doesn't exist/);
  });

  test('through the tool: the error reaches the AI as code, message and fix', async () => {
    if (process.platform === 'darwin' && existsSync(join(DIR, 'bin', 'face-helper'))) return;
    const e = error(await reframe(await connect({}), { source: INTERVIEW }));
    expect(['E_FOLLOW_SPEAKER_UNSUPPORTED', 'E_FACE_HELPER_MISSING']).toContain(e.code);
  });

  test('expected samples, for progress', () => {
    expect(expectedSamples([{ start: 0, end: 1000 }], 5)).toBe(5);
    expect(
      expectedSamples(
        [
          { start: 0, end: 100 },
          { start: 500, end: 2500 },
        ],
        5,
      ),
    ).toBe(11);
  });
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as NodCut starts it', () => {
  test('testPlugin without a video: starts, offers reframe_track; the call is skipped', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers reframe_track', 'pass'],
      ['reframe_track answers per contract', 'skip'],
    ]);
  });

  /**
   * The harness gives a plugin only its settings and secrets, so to use the stand-in helper this
   * starts the built plugin from a copy of the folder whose entry sets NODCUT_FACE_HELPER first.
   */
  test('testPlugin with the stand-in helper and a scene as the video', async () => {
    const dir = mkdtempSync(join(tmp, 'harness-'));
    writeFileSync(join(dir, 'nodcut-plugin.json'), JSON.stringify({ ...manifest, args: ['start.mjs'] }));
    copyFileSync(join(DIR, 'icon.png'), join(dir, 'icon.png'));
    writeFileSync(
      join(dir, 'start.mjs'),
      `process.env.${HELPER_ENV} = ${JSON.stringify(FAKE)};\nawait import(${JSON.stringify(pathToFileURL(join(DIR, 'dist/index.js')).href)});\n`,
    );
    const r = await testPlugin(dir, { fixtures: { video: INTERVIEW } });
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.find((c) => c.name === 'reframe_track answers per contract')?.result).toBe('pass');
  });

  test('pnpm bundle copies bin/ when the helper is built, and says so when it is not', async () => {
    const lines: string[] = [];
    const b = await bundlePlugin(DIR, join(tmp, 'bundle'), { log: (l) => lines.push(l) });
    const built = existsSync(join(DIR, 'bin', 'face-helper'));
    expect(lines).toContain(built ? 'copied bin' : 'skipped bin (listed in files, not there)');
    expect(existsSync(join(b.dir, 'bin', 'face-helper'))).toBe(built);
    expect(existsSync(join(b.dir, 'helper'))).toBe(false);
  });
});
