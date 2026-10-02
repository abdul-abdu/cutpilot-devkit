/**
 * The tools through MCP (in memory), against a project whose Remotion is a stand-in
 * (test-helpers/fake-project.ts): what is written where, what Remotion is asked to do, the
 * licence gate, and the errors. Real renders are in e2e.test.ts.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { LICENSE_NOTICE } from './license.js';
import { aspectOf, createDefinition } from './plugin.js';
import { workDir } from './remotion.js';
import { fakeCalls, fakeProject } from './test-helpers/fake-project.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-plugin-'));

const clients: Client[] = [];
const projects: string[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const p of projects) {
    rmSync(p, { recursive: true, force: true });
    rmSync(workDir(p), { recursive: true, force: true });
  }
  rmSync(tmp, { recursive: true, force: true });
});

const KEY = 'rm_sec_test123';

async function connect({ project, key = KEY }: { project?: string; key?: string | null } = {}) {
  const env: NodeJS.ProcessEnv = {};
  if (key) env.CUTPILOT_SECRET_REMOTION_LICENSE_KEY = key;
  if (project) env.CUTPILOT_SETTING_PROJECT_DIR = project;
  const plugin = definePlugin({ ...createDefinition({ stateDir: join(tmp, 'state') }), manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
function project(opts?: Parameters<typeof fakeProject>[0]) {
  const p = fakeProject(opts);
  projects.push(p);
  return p;
}
type Result = Awaited<ReturnType<Client['callTool']>>;
const structured = <T = Record<string, unknown>>(r: Result) => r.structuredContent as T;
const errorOf = (r: Result) => structured<{ error: { code: string; message: string; fix: string } }>(r).error;

const SCENE = `import { AbsoluteFill, useCurrentFrame } from 'remotion';

type Props = { headline: string };

export default function Scene({ headline }: Props) {
  const frame = useCurrentFrame();
  return <AbsoluteFill style={{ opacity: Math.min(1, frame / 10) }}>{headline}</AbsoluteFill>;
}
`;
const promo = {
  id: 'promo',
  code: SCENE,
  durationInFrames: 300,
  fps: 30,
  width: 1080,
  height: 1920,
  defaultProps: { headline: 'Just got safer' },
};
const call = (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args });

describe('tools', () => {
  test('a generator, with the scene tools as extra tools', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'create_project',
      'create_scene',
      'delete_scene',
      'generate',
      'guide',
      'list_templates',
      'preview_frame',
      'render',
      'status',
      'update_scene',
    ]);
    const guide = await call(c, 'guide');
    expect((guide.content as { text: string }[])[0]!.text).toContain('Math.random');
  });

  test("the manifest says Remotion is the user's own, and asks for nothing it doesn't use", () => {
    expect(manifest.description).toMatch(/YOUR OWN Remotion/);
    expect(manifest.description).toMatch(/not included or licensed by CutPilot/);
    expect(manifest.description).toMatch(/remotion\.pro/);
    expect(manifest.permissions.secrets).toEqual(['REMOTION_LICENSE_KEY']);
    expect(manifest.permissions.reads).toEqual([]);
  });
});

describe('the licence comes first', () => {
  test('without a key nothing touches the project: the notice, and where the user enters theirs', async () => {
    const p = project();
    const c = await connect({ project: p, key: null });
    for (const [tool, args] of [
      ['create_scene', promo],
      ['preview_frame', { id: 'promo', frame: 0 }],
      ['render', { id: 'promo' }],
      ['delete_scene', { id: 'promo' }],
      ['create_project', { dir: join(tmp, 'new') }],
      ['generate', { template: 'promo', width: 1080, height: 1920, fps: 30 }],
    ] as const) {
      const e = errorOf(await call(c, tool, args));
      expect(e.code, tool).toBe('E_PLUGIN_NEEDS_SECRET');
      expect(e.message).toContain('licensed separately by Remotion AG');
    }
    expect(structured(await call(c, 'list_templates'))).toEqual({ templates: [] });
    expect(existsSync(join(p, 'src', 'cutpilot'))).toBe(false);
    expect(fakeCalls(p)).toEqual([]);
    const s = structured(await call(c, 'status'));
    expect(s).toMatchObject({
      ok: false,
      linked: true,
      license: { entered: false },
      licenseNotice: LICENSE_NOTICE,
    });
  });

  test('not linked, version mismatch: each says what to do', async () => {
    const c = await connect();
    expect(errorOf(await call(c, 'create_scene', promo)).code).toBe('E_REMOTION_NOT_LINKED');
    const s = structured<{ linked: boolean; problems: { code: string }[] }>(await call(c, 'status'));
    expect(s.linked).toBe(false);
    expect(s.problems.map((x) => x.code)).toEqual(['E_REMOTION_NOT_LINKED']);

    const mixed = project({ versions: { '@remotion/renderer': '4.0.500' } });
    const m = await connect({ project: mixed });
    expect(errorOf(await call(m, 'create_scene', promo)).code).toBe('E_REMOTION_VERSION_MISMATCH');
    const missing = project({ versions: { '@remotion/bundler': null } });
    expect(
      errorOf(await call(await connect({ project: missing }), 'preview_frame', { id: 'a', frame: 0 })).code,
    ).toBe('E_REMOTION_NOT_INSTALLED');
  });
});

describe('scenes', () => {
  test('create: the file, index.tsx, the one-time Root patch with its diff, the check, the notice once', async () => {
    const p = project();
    const c = await connect({ project: p });
    const r = structured<Record<string, unknown>>(await call(c, 'create_scene', promo));
    expect(r).toMatchObject({
      scene: 'promo',
      created: join('src', 'cutpilot', 'promo.tsx'),
      compositionId: 'cutpilot-promo',
      check: {
        ok: true,
        typescript: 'not checked: the project has no TypeScript',
        bundle: 'ok',
        composition: { id: 'cutpilot-promo', width: 1080, height: 1920, fps: 30, durationInFrames: 300 },
      },
      rootPatch: { file: join('src', 'Root.tsx') },
      licenseNotice: LICENSE_NOTICE,
    });
    expect((r.rootPatch as { diff: string }).diff).toContain('+      <CutPilotCompositions />');
    expect(readFileSync(join(p, 'src', 'cutpilot', 'promo.tsx'), 'utf8')).toContain(
      'export const cutpilotScene = {"durationInFrames":300',
    );
    expect(readFileSync(join(p, 'src', 'cutpilot', 'index.tsx'), 'utf8')).toContain('id="cutpilot-promo"');
    expect(readFileSync(join(p, 'src', 'Root.tsx'), 'utf8')).toContain('<CutPilotCompositions />');

    // the second scene: no patch, no notice (same project and version)
    const r2 = structured(await call(c, 'create_scene', { ...promo, id: 'outro' }));
    expect(r2).not.toHaveProperty('rootPatch');
    expect(r2).not.toHaveProperty('licenseNotice');
    expect(errorOf(await call(c, 'create_scene', promo)).code).toBe('E_REMOTION_SCENE_EXISTS');

    const s = structured<{
      ok: boolean;
      scenes: { id: string; durationMs: number }[];
      root: { state: string };
    }>(await call(c, 'status'));
    expect(s.ok).toBe(true);
    expect(s.scenes.map((x) => [x.id, x.durationMs])).toEqual([
      ['outro', 10_000],
      ['promo', 10_000],
    ]);
    expect(s.root.state).toBe('already');
  });

  test('bad ids, path traversal, code without a default export are refused before anything is written', async () => {
    const p = project();
    const c = await connect({ project: p });
    for (const id of ['../Root', 'a/b', 'Promo', 'index'])
      expect(errorOf(await call(c, 'create_scene', { ...promo, id })).code, id).toBe(
        'E_REMOTION_BAD_SCENE_ID',
      );
    expect(errorOf(await call(c, 'create_scene', { ...promo, code: 'export const A = 1;' }))).toMatchObject({
      code: 'E_PLUGIN_BAD_INPUT',
    });
    expect(existsSync(join(p, 'src', 'cutpilot', 'promo.tsx'))).toBe(false);
    expect(readFileSync(join(p, 'src', 'Root.tsx'), 'utf8')).not.toContain('CutPilot');
  });

  test('bundler and composition errors come back verbatim in check, for the AI to fix', async () => {
    const p = project();
    const c = await connect({ project: p });
    const bad = structured<{ check: { ok: boolean; bundle: string } }>(
      await call(c, 'create_scene', { ...promo, code: `${SCENE}\n// BUNDLE_ERROR` }),
    );
    expect(bad.check).toMatchObject({
      ok: false,
      bundle: 'Module parse failed: Unexpected token (3:10)\nYou may need an appropriate loader',
    });
    const thrown = structured<{ check: { ok: boolean; composition: string } }>(
      await call(c, 'update_scene', { id: 'promo', code: `${SCENE}\n// LOAD_ERROR` }),
    );
    expect(thrown.check.ok).toBe(false);
    expect(thrown.check.composition).toContain('ReferenceError: foo is not defined');
    const fixed = structured<{ check: { ok: boolean } }>(
      await call(c, 'update_scene', { id: 'promo', code: SCENE }),
    );
    expect(fixed.check.ok).toBe(true);
    const s = structured<{ lastErrors: { code: string }[] }>(await call(c, 'status'));
    expect(s.lastErrors.map((e) => e.code)).toEqual(['E_REMOTION_BUNDLE_FAILED', 'E_REMOTION_SCENE_FAILED']);
  });

  test('update changes only what is passed; delete removes the scene and its composition', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const r = structured<{ check: { composition: { durationInFrames: number; width: number } } }>(
      await call(c, 'update_scene', {
        id: 'promo',
        durationInFrames: 150,
        defaultProps: { headline: 'New' },
      }),
    );
    expect(r.check.composition).toMatchObject({ durationInFrames: 150, width: 1080 });
    const text = readFileSync(join(p, 'src', 'cutpilot', 'promo.tsx'), 'utf8');
    expect(text.startsWith(SCENE)).toBe(true);
    expect(text).toContain('"defaultProps":{"headline":"New"}');
    expect(errorOf(await call(c, 'update_scene', { id: 'nope', fps: 25 })).code).toBe('E_REMOTION_NO_SCENE');

    expect(structured(await call(c, 'delete_scene', { id: 'promo' }))).toEqual({
      ok: true,
      deleted: 'promo',
    });
    expect(existsSync(join(p, 'src', 'cutpilot', 'promo.tsx'))).toBe(false);
    expect(readFileSync(join(p, 'src', 'cutpilot', 'index.tsx'), 'utf8')).not.toContain('promo');
    expect(errorOf(await call(c, 'delete_scene', { id: 'promo' })).code).toBe('E_REMOTION_NO_SCENE');
  });
});

describe('preview and render', () => {
  test("preview_frame: a PNG image block, frame and time; a development render with the user's key", async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const r = await call(c, 'preview_frame', { id: 'promo', frame: 45, props: { headline: 'Hi' } });
    const [text, image] = r.content as [
      { type: string; text: string },
      { type: string; mimeType: string; data: string },
    ];
    expect(text.text).toContain('frame 45 of 300 (1.50 s of 10.00 s), 1080x1920 shown at 540x960');
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(image.data, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(structured(r)).toMatchObject({ frame: 45, timeMs: 1500, width: 540, height: 960 });
    const still = fakeCalls(p).find((x) => x.fn === 'renderStill')!.args;
    expect(still).toMatchObject({
      frame: 45,
      imageFormat: 'png',
      scale: 0.5,
      licenseKey: KEY,
      isProduction: false,
      inputProps: { headline: 'Hi' },
    });
    expect(errorOf(await call(c, 'preview_frame', { id: 'promo', frame: 300 }))).toMatchObject({
      code: 'E_PLUGIN_BAD_INPUT',
      fix: 'pass a frame from 0 to 299',
    });
  });

  test('the bundle is reused until a file in src/ changes', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const bundles = () => fakeCalls(p).filter((x) => x.fn === 'bundle').length;
    expect(bundles()).toBe(1);
    await call(c, 'preview_frame', { id: 'promo', frame: 0 });
    await call(c, 'preview_frame', { id: 'promo', frame: 10 });
    expect(bundles()).toBe(1);
    const later = new Date(Date.now() + 5000);
    writeFileSync(join(p, 'src', 'Extra.tsx'), 'export const x = 1;\n');
    utimesSync(join(p, 'src', 'Extra.tsx'), later, later);
    await call(c, 'preview_frame', { id: 'promo', frame: 0 });
    expect(bundles()).toBe(2);
  });

  test('render: H.264 into out/cutpilot with unique names, a production render with the key', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', { ...promo, durationInFrames: 30 });
    const a = structured<{ file: string; codec: string; durationMs: number; next: string }>(
      await call(c, 'render', { id: 'promo' }),
    );
    const b = structured<{ file: string }>(await call(c, 'render', { id: 'promo' }));
    expect(a.file.startsWith(join(p, 'out', 'cutpilot', 'promo-'))).toBe(true);
    expect(a.file.endsWith('.mp4')).toBe(true);
    expect(b.file).not.toBe(a.file);
    expect(existsSync(a.file) && existsSync(b.file)).toBe(true);
    expect(a).toMatchObject({ codec: 'h264', durationMs: 1000 });
    expect(a.next).toContain('add_insert { template: "promo"');
    expect(fakeCalls(p).find((x) => x.fn === 'renderMedia')!.args).toMatchObject({
      codec: 'h264',
      imageFormat: 'jpeg',
      licenseKey: KEY,
      isProduction: true,
    });
  });

  test('transparent: ProRes 4444 with alpha in a .mov; H.264 or a profile without alpha is refused', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const r = structured<{ file: string; codec: string; proresProfile: string }>(
      await call(c, 'render', { id: 'promo', transparent: true, frameRange: [0, 29] }),
    );
    expect(r).toMatchObject({ codec: 'prores', proresProfile: '4444' });
    expect(r.file.endsWith('.mov')).toBe(true);
    expect(fakeCalls(p).find((x) => x.fn === 'renderMedia')!.args).toMatchObject({
      codec: 'prores',
      proResProfile: '4444',
      pixelFormat: 'yuva444p10le',
      imageFormat: 'png',
      frameRange: [0, 29],
    });
    expect(errorOf(await call(c, 'render', { id: 'promo', transparent: true, codec: 'h264' })).code).toBe(
      'E_PLUGIN_BAD_INPUT',
    );
    expect(
      errorOf(await call(c, 'render', { id: 'promo', transparent: true, proresProfile: 'hq' })).code,
    ).toBe('E_PLUGIN_BAD_INPUT');
    expect(errorOf(await call(c, 'render', { id: 'promo', frameRange: [10, 400] })).code).toBe(
      'E_PLUGIN_BAD_INPUT',
    );
  });

  test('a cancelled render stops, leaves no partial file, and says so', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const ac = new AbortController();
    const pending = c.callTool(
      { name: 'render', arguments: { id: 'promo', props: { slow: true } } },
      undefined,
      {
        signal: ac.signal,
      },
    );
    setTimeout(() => ac.abort(), 100);
    await expect(pending).rejects.toThrow();
    // the plugin side saw the cancellation and cleaned up
    await new Promise((r) => setTimeout(r, 300));
    expect(readFileSync(join(tmp, 'state', 'acceptances.json'), 'utf8')).toContain(p);
    const out = join(p, 'out', 'cutpilot');
    expect(existsSync(out) ? (await import('node:fs')).readdirSync(out) : []).toEqual([]);
  });
});

describe('as a generator (what add_insert calls)', () => {
  test('list_templates: the scenes, with props as JSON Schema and their aspect', async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    await call(c, 'create_scene', { ...promo, id: 'wide', width: 1920, height: 1080, defaultProps: {} });
    const all = structured<{
      templates: { id: string; aspects: string[]; params: unknown; defaultDurationMs: number }[];
    }>(await call(c, 'list_templates'));
    expect(all.templates.map((t) => [t.id, t.aspects, t.defaultDurationMs])).toEqual([
      ['promo', ['9:16'], 10_000],
      ['wide', ['16:9'], 10_000],
    ]);
    expect(all.templates[0]!.params).toMatchObject({
      type: 'object',
      properties: { headline: { type: 'string' } },
    });
    const vertical = structured<{ templates: { id: string }[] }>(
      await call(c, 'list_templates', { aspect: '9:16' }),
    );
    expect(vertical.templates.map((t) => t.id)).toEqual(['promo']);
  });

  test("generate renders at the timeline's size, rate and length, and answers the same request from its cache", async () => {
    const p = project();
    const c = await connect({ project: p });
    await call(c, 'create_scene', promo);
    const args = {
      template: 'promo',
      params: { headline: 'Hi' },
      width: 720,
      height: 1280,
      fps: 25,
      durationMs: 2000,
    };
    const r = structured<{
      file: string;
      width: number;
      height: number;
      durationMs: number;
      hasAudio: boolean;
    }>(await call(c, 'generate', args));
    expect(r).toMatchObject({ width: 720, height: 1280, durationMs: 2000, hasAudio: false });
    expect(r.file.startsWith(workDir(p))).toBe(true);
    const media = fakeCalls(p).filter((x) => x.fn === 'renderMedia');
    expect(media).toHaveLength(1);
    expect(media[0]!.args).toMatchObject({
      composition: { width: 720, height: 1280, fps: 25, durationInFrames: 50 },
      inputProps: { headline: 'Hi' },
      licenseKey: KEY,
      isProduction: true,
    });
    expect(structured(await call(c, 'generate', args))).toEqual(r);
    expect(fakeCalls(p).filter((x) => x.fn === 'renderMedia')).toHaveLength(1);
    expect(errorOf(await call(c, 'generate', { ...args, template: 'nope' })).code).toBe(
      'E_REMOTION_NO_SCENE',
    );
  });
});

test('aspect names', () => {
  expect(aspectOf(1080, 1920)).toBe('9:16');
  expect(aspectOf(1920, 1080)).toBe('16:9');
  expect(aspectOf(1080, 1080)).toBe('1:1');
  expect(aspectOf(1080, 1350)).toBe('4:5');
  expect(aspectOf(1000, 300)).toBeNull();
});
