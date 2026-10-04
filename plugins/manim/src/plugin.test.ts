/**
 * The tools through MCP (in memory), the parts that find and read Manim, real renders, and the
 * plugin as NodCut starts it (needs `pnpm build`). Renders need Manim: one installed (a manim
 * on PATH, or a Python that imports it), or uv with MANIM_E2E=1 set (uv downloads Manim from
 * PyPI the first time, so CI, which has no network, skips them).
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, KIND_TOOLS, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { definition } from './plugin.js';
import { expressionProblem, TEMPLATES } from './templates.js';
import {
  errorLine,
  findLatex,
  findManim,
  findOnPath,
  lastError,
  progressOf,
  UV_MANIM,
  UV_PYTHON,
} from './toolchain.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const runner = findManim(undefined);
const canRender = !!runner && (runner.via !== 'uv' || !!process.env.MANIM_E2E);
const hasLatex = !!findLatex().latex && !!findLatex().dvisvgm;
const ffprobe = findOnPath('ffprobe');
const tmp = mkdtempSync(join(tmpdir(), 'cp-manim-'));

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
/** a clip is whole frames, so its length is the one asked for within half a frame */
const nearly = (ms: number, asked: number, fps: number) => Math.abs(ms - asked) <= 500 / fps + 1;
const textOf = (r: Result) => (r.content as { type: string; text: string }[])[0]!.text;

describe('tools', () => {
  test('a generator with doctor and scene_guide as its extra tools', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'doctor',
      'generate',
      'list_templates',
      'scene_guide',
    ]);
    const guide = textOf(await c.callTool({ name: 'scene_guide', arguments: {} }));
    expect(guide).toMatch(/config\.frame_width/);
    expect(guide).toMatch(/DURATION/);
    expect(guide).toMatch(/class SquareToCircle\(Scene\)/);
  });

  test('list_templates lists every template per contract, examples passing their own schemas', async () => {
    const c = await connect();
    const r = structured<{ templates: { id: string; params: { type: string }; example: unknown }[] }>(
      await c.callTool({ name: 'list_templates', arguments: {} }),
    );
    expect(KIND_TOOLS.generator.list_templates.output.safeParse(r).success).toBe(true);
    expect(r.templates.map((t) => t.id)).toEqual([
      'title',
      'function-plot',
      'bar-chart',
      'morph-text',
      'equation',
      'custom-scene',
    ]);
    for (const t of TEMPLATES) expect(t.params.safeParse(t.example).success, t.id).toBe(true);
  });

  test('generate refuses an unknown template, bad params and a length out of range, saying what to do', async () => {
    const c = await connect();
    const base = { width: 1080, height: 1920, fps: 30 };
    expect(
      errorOf(await c.callTool({ name: 'generate', arguments: { ...base, template: 'intro' } })),
    ).toEqual({
      code: 'E_PLUGIN_BAD_INPUT',
      message: 'there is no template "intro"',
      fix: 'use one of title, function-plot, bar-chart, morph-text, equation, custom-scene',
    });
    const plot = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { ...base, template: 'function-plot', params: { expression: 'os.system(1)' } },
      }),
    );
    expect(plot.code).toBe('E_PLUGIN_BAD_INPUT');
    expect(plot.message).toMatch(/^function-plot: expression: os is not known/);
    const range = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { ...base, template: 'function-plot', params: { expression: 'x', xMin: 2, xMax: 1 } },
      }),
    );
    expect(range.message).toBe('function-plot: xMax: xMin is less than xMax');
    const long = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { ...base, template: 'title', params: { title: 'x' }, durationMs: 60_000 },
      }),
    );
    expect(long).toMatchObject({ code: 'E_PLUGIN_BAD_INPUT', message: 'title lasts 1–10 s, not 60 s' });
  });

  test('a Manim setting that points nowhere is named, not replaced by another Manim', async () => {
    const c = await connect({ NODCUT_SETTING_MANIM_COMMAND: '/nowhere/manim' });
    const r = errorOf(
      await c.callTool({
        name: 'generate',
        arguments: { template: 'title', params: { title: 'x' }, width: 640, height: 360, fps: 30 },
      }),
    );
    expect(r).toMatchObject({
      code: 'E_MANIM_NOT_FOUND',
      message: 'the "Manim command" setting points nowhere: /nowhere/manim',
    });
    const d = structured<{ ok: boolean; manim: unknown; problems: string[] }>(
      await c.callTool({ name: 'doctor', arguments: {} }),
    );
    expect(d).toMatchObject({ ok: false, manim: null });
    expect(d.problems[0]).toMatch(/clear it to let the plugin find one/);
  });
});

describe('expressions', () => {
  test('arithmetic in x and the math functions are allowed; anything else is named', () => {
    for (const ok of ['x', 'sin(x) * x^2 / 10', '2**x - exp(-x)', 'abs(x) % 3 + pi', 'sqrt(1 + x*x)'])
      expect(expressionProblem(ok), ok).toBeNull();
    expect(expressionProblem('__import__("os")')).toMatch(/use only numbers/);
    expect(expressionProblem('y + 1')).toMatch(/^y is not known/);
    expect(expressionProblem('x.real')).toMatch(/^real is not known/);
    expect(expressionProblem('sin(x')).toBe('the brackets do not match');
  });
});

describe('finding Manim', () => {
  const fake = (dir: string, name: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), '#!/bin/sh\necho "Manim Community v0.19.0"\n');
    chmodSync(join(dir, name), 0o755);
    return join(dir, name);
  };
  const home = join(tmp, 'home');
  const nothingElse =
    !findOnPath('manim', { PATH: '', HOME: home }) && !findOnPath('uv', { PATH: '', HOME: home });

  test('the setting: a manim executable as it is, a Python with -m manim', () => {
    const exe = fake(join(tmp, 'set'), 'manim');
    const py = fake(join(tmp, 'set'), 'python3.12');
    expect(findManim(exe)).toEqual({ command: exe, args: [], via: 'setting' });
    expect(findManim(py)).toEqual({ command: py, args: ['-m', 'manim'], via: 'setting' });
    expect(findManim('/nowhere/manim')).toBeNull();
  });

  test.skipIf(!nothingElse || process.platform === 'win32')('manim on PATH first, else uv fetches it', () => {
    const bin = join(tmp, 'bin');
    const uv = fake(bin, 'uv');
    expect(findManim('', { PATH: bin, HOME: home })).toEqual({
      command: uv,
      args: ['tool', 'run', '--python', UV_PYTHON, '--from', UV_MANIM, 'manim'],
      via: 'uv',
    });
    const manim = fake(bin, 'manim');
    expect(findManim(undefined, { PATH: bin, HOME: home })).toEqual({
      command: manim,
      args: [],
      via: 'manim',
    });
  });
});

describe("reading Manim's output", () => {
  test('progress, the runtime’s error line, and Manim’s own last error', () => {
    expect(progressOf('NODCUT_PROGRESS 0.333')).toBe(0.333);
    expect(progressOf('Animation 0: Write(Text(...)):  65%|██████')).toBeNull();
    const tail = [
      'Animation 1: Create(Circle):  50%|',
      "NODCUT_ERROR NameError: name 'Squre' is not defined (line 7: self.play(Transform(c, Squre())))",
      '╭──── Traceback ────╮',
      "│ NameError: name 'Squre' is not defined │",
    ];
    expect(errorLine(tail)).toBe(
      "NameError: name 'Squre' is not defined (line 7: self.play(Transform(c, Squre())))",
    );
    expect(errorLine(tail.slice(2))).toBeNull();
    expect(lastError(tail.slice(2))).toBe("NameError: name 'Squre' is not defined");
    expect(lastError(['something', 'went', 'sideways'])).toBe('something | went | sideways');
  });
});

describe.skipIf(!canRender)('renders (Manim)', () => {
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

  test('generate renders an MP4 of the size and length asked for, and the same request again is not rendered twice', async () => {
    const c = await connect();
    const args = {
      template: 'title',
      params: { title: `Render check ${process.pid}`, subtitle: 'at 16:9' },
      width: 640,
      height: 360,
      fps: 25,
      durationMs: 1500,
    };
    const progress: number[] = [];
    const r = await c.callTool({ name: 'generate', arguments: args }, undefined, {
      onprogress: (p) => progress.push(p.progress),
      timeout: 600_000,
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
    expect(nearly(out.durationMs, 1500, 25), String(out.durationMs)).toBe(true);
    if (ffprobe) {
      const p = probe(out.file);
      expect(p.streams.find((s) => s.codec_type === 'video')).toMatchObject({ width: 640, height: 360 });
      expect(Number(p.format.duration)).toBeCloseTo(1.5, 1);
    }
    expect(progress.length).toBeGreaterThan(1);

    const started = Date.now();
    const again = structured<{ file: string }>(await c.callTool({ name: 'generate', arguments: args }));
    expect(again.file).toBe(out.file);
    expect(Date.now() - started).toBeLessThan(3000);
  }, 600_000);

  test('every template without LaTeX renders at 9:16', async () => {
    const c = await connect();
    for (const t of TEMPLATES.filter((x) => !x.latex)) {
      const r = await c.callTool(
        {
          name: 'generate',
          arguments: {
            template: t.id,
            params: t.example,
            width: 360,
            height: 640,
            fps: 15,
            durationMs: 2500,
          },
        },
        undefined,
        { timeout: 300_000 },
      );
      expect(r.isError, `${t.id}: ${JSON.stringify(r.structuredContent)}`).toBeFalsy();
      const out = structured<{ durationMs: number; height: number }>(r);
      expect(out.height).toBe(640);
      expect(nearly(out.durationMs, 2500, 15), `${t.id}: ${out.durationMs}`).toBe(true);
    }
  }, 900_000);

  test('a custom scene that fails says why and on which line; one that runs long says how long', async () => {
    const c = await connect();
    const gen = (code: string, durationMs: number) =>
      c.callTool(
        {
          name: 'generate',
          arguments: {
            template: 'custom-scene',
            params: { code },
            width: 320,
            height: 180,
            fps: 10,
            durationMs,
          },
        },
        undefined,
        { timeout: 300_000 },
      );
    const broken = errorOf(
      await gen(
        'from manim import *\n\nclass A(Scene):\n    def construct(self):\n        self.play(Create(Squre()))\n',
        1000,
      ),
    );
    expect(broken.code).toBe('E_MANIM_SCENE_FAILED');
    expect(broken.message).toBe(
      "the scene failed: NameError: name 'Squre' is not defined (line 5: self.play(Create(Squre())))",
    );
    const syntax = errorOf(await gen('from manim import *\nclass A(Scene)\n    pass\n', 1000));
    expect(syntax.message).toMatch(/^the scene failed: SyntaxError: .*\(line 2: class A\(Scene\)\)$/);

    const long = await gen(
      'from manim import *\n\nclass A(Scene):\n    def construct(self):\n        self.play(Create(Circle()), run_time=DURATION + 1)\n',
      1000,
    );
    expect(long.isError, JSON.stringify(long.structuredContent)).toBeFalsy();
    expect(structured<{ durationMs: number }>(long).durationMs).toBe(2000);
  }, 600_000);
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')) || !canRender)('as NodCut starts it', () => {
  test('testPlugin renders every template with its example', async () => {
    const r = await testPlugin(DIR, { templates: 'all', timeoutMs: 300_000 });
    const expected = (id: string) => (id === 'equation' && !hasLatex ? 'fail' : 'pass');
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers list_templates', 'pass'],
      ['offers generate', 'pass'],
      ['extra tool doctor', 'pass'],
      ['extra tool scene_guide', 'pass'],
      ['list_templates answers per contract', 'pass'],
      ...TEMPLATES.flatMap((t) =>
        expected(t.id) === 'pass'
          ? [
              [`generate ${t.id} answers per contract`, 'pass'],
              [`generate ${t.id} makes the clip asked for`, 'pass'],
            ]
          : [[`generate ${t.id} answers per contract`, 'fail']],
      ),
    ]);
    if (hasLatex) expect(r.ok, formatReport(r)).toBe(true);
  }, 900_000);
});
