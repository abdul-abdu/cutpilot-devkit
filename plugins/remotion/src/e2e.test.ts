/**
 * With a real Remotion: a project made by remotion__create_project (REMOTION_E2E=1; needs Node,
 * npm and the internet) or an existing one (REMOTION_PROJECT=<folder>, a scratch copy: scenes are
 * written into it). A scene is created and checked, frame 0 previewed, one second rendered to
 * H.264 and a few frames to ProRes 4444, then the plugin is started as NodCut starts it
 * (needs `pnpm build`). Remotion downloads its Chrome Headless Shell on first use. Skipped otherwise.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { findOnPath } from './create.js';
import { createDefinition } from './plugin.js';
import { workDir } from './remotion.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const existing = process.env.REMOTION_PROJECT;
const scaffold = !!process.env.REMOTION_E2E;
const ffprobe = findOnPath('ffprobe');
const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-e2e-'));
const KEY = 'free-license';
const MIN = 60_000;

const SCENE = `import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = { headline: string; accent: string };

export default function Scene({ headline, accent }: Props) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ color: 'white', fontSize: width * 0.08, opacity, transform: \`scale(\${pop})\`, borderBottom: \`8px solid \${accent}\` }}>
        {headline}
      </h1>
    </AbsoluteFill>
  );
}
`;

const probe = (file: string) =>
  JSON.parse(
    execFileSync(ffprobe!, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], {
      encoding: 'utf8',
    }),
  ) as {
    format: { duration: string };
    streams: { codec_type: string; codec_name: string; width: number; pix_fmt: string }[];
  };

describe.skipIf(!existing && !scaffold)('with a real Remotion', () => {
  let project = existing ?? '';
  let client: Client;
  type Result = Awaited<ReturnType<Client['callTool']>>;
  const ok = <T = Record<string, unknown>>(r: Result) => {
    if (r.isError) throw new Error(JSON.stringify(r.structuredContent ?? r.content));
    return r.structuredContent as T;
  };
  const connect = async (projectDir: string) => {
    const plugin = definePlugin(
      { ...createDefinition({ stateDir: join(tmp, 'state') }), manifest },
      { NODCUT_SECRET_REMOTION_LICENSE_KEY: KEY, NODCUT_SETTING_PROJECT_DIR: projectDir },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    await plugin.server.connect(a);
    const c = new Client({ name: 'e2e', version: '1' });
    await c.connect(b);
    return c;
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }, undefined, {
      timeout: 10 * MIN,
      resetTimeoutOnProgress: true,
      onprogress: () => {},
    });

  beforeAll(async () => {
    if (!existing) {
      project = join(tmp, 'remotion-project');
      const c = await connect('');
      const made = await c.callTool({ name: 'create_project', arguments: { dir: project } }, undefined, {
        timeout: 15 * MIN,
        resetTimeoutOnProgress: true,
        onprogress: () => {},
      });
      expect(made.isError, JSON.stringify(made.structuredContent)).toBeFalsy();
      expect(made.structuredContent).toMatchObject({ projectDir: project, root: { state: 'patched' } });
      await c.close();
    }
    client = await connect(project);
  }, 20 * MIN);

  afterAll(async () => {
    await client?.close();
    if (project && !existing) rmSync(workDir(project), { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  });

  test(
    'create a scene: TypeScript and the bundler check it',
    async () => {
      const status = ok<{ ok: boolean; versions: Record<string, string> }>(await call('status'));
      expect(status.ok, JSON.stringify(status)).toBe(true);
      await call('delete_scene', { id: 'e2e-promo' });
      const r = ok<{ check: { ok: boolean; typescript: unknown; composition: unknown } }>(
        await call('create_scene', {
          id: 'e2e-promo',
          code: SCENE,
          durationInFrames: 30,
          fps: 30,
          width: 640,
          height: 360,
          defaultProps: { headline: 'Just got safer', accent: '#C6FF00' },
        }),
      );
      expect(r.check, JSON.stringify(r.check)).toMatchObject({
        ok: true,
        typescript: 'ok',
        composition: { id: 'nodcut-e2e-promo', width: 640, height: 360, durationInFrames: 30 },
      });
      // a type error comes back verbatim, the scene stays written
      const bad = ok<{ check: { ok: boolean; typescript: string[] } }>(
        await call('update_scene', { id: 'e2e-promo', code: SCENE.replace('width * 0.08', 'width * "big"') }),
      );
      expect(bad.check.ok).toBe(false);
      expect(bad.check.typescript.join('\n')).toMatch(/e2e-promo\.tsx\(\d+,\d+\): error TS236[23]/);
      expect(
        ok<{ check: { ok: boolean } }>(await call('update_scene', { id: 'e2e-promo', code: SCENE })).check.ok,
      ).toBe(true);
    },
    10 * MIN,
  );

  test(
    'preview frame 0: a PNG',
    async () => {
      const r = await call('preview_frame', { id: 'e2e-promo', frame: 0, scale: 0.5 });
      expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
      const image = (r.content as { type: string; data?: string }[]).find((b) => b.type === 'image')!;
      const png = Buffer.from(image.data!, 'base64');
      expect(png.subarray(1, 4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(320);
      expect(png.readUInt32BE(20)).toBe(180);
    },
    10 * MIN,
  );

  test(
    'render one second of H.264, then a few frames of ProRes 4444 with alpha',
    async () => {
      const r = ok<{ file: string; durationMs: number; width: number }>(
        await call('render', { id: 'e2e-promo' }),
      );
      expect(existsSync(r.file)).toBe(true);
      expect(r.file.startsWith(join(project, 'out', 'nodcut'))).toBe(true);
      expect(Math.abs(r.durationMs - 1000)).toBeLessThan(100);
      if (ffprobe) {
        const info = probe(r.file);
        expect(Math.abs(Number(info.format.duration) - 1)).toBeLessThan(0.1);
        expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({
          codec_name: 'h264',
          width: 640,
        });
      }
      const alpha = ok<{ file: string }>(
        await call('render', { id: 'e2e-promo', transparent: true, frameRange: [0, 4] }),
      );
      expect(alpha.file.endsWith('.mov')).toBe(true);
      if (ffprobe) {
        const v = probe(alpha.file).streams.find((s) => s.codec_type === 'video')!;
        expect(v.codec_name).toBe('prores');
        expect(v.pix_fmt).toMatch(/^yuva444p/);
      }
    },
    15 * MIN,
  );

  test(
    "generate (add_insert) at the timeline's size",
    async () => {
      const r = ok<{ file: string; width: number; height: number; durationMs: number }>(
        await call('generate', {
          template: 'e2e-promo',
          params: { headline: 'Vertical' },
          width: 360,
          height: 640,
          fps: 30,
          durationMs: 1000,
        }),
      );
      expect(r).toMatchObject({ width: 360, height: 640 });
      expect(Math.abs(r.durationMs - 1000)).toBeLessThan(100);
    },
    15 * MIN,
  );

  test.skipIf(!existsSync(join(DIR, 'dist', 'index.js')))(
    'as NodCut starts it',
    async () => {
      const report = await testPlugin(DIR, {
        secrets: { REMOTION_LICENSE_KEY: KEY },
        settings: { projectDir: project },
        timeoutMs: 10 * MIN,
      });
      expect(report.ok, formatReport(report)).toBe(true);
    },
    20 * MIN,
  );
});
