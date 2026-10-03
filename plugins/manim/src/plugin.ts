/**
 * The plugin: a `generator` (list_templates, generate) and two extra tools, doctor and
 * scene_guide. generate checks the parameters against the template's schema, writes a job (the
 * template, its parameters, the length) into a folder named by everything that affects the
 * picture, runs Manim on python/cutpilot_manim.py at the edit's size and fps, and returns the MP4;
 * CutPilot copies it into the project. The same request again is answered from that folder.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PluginFailure,
  type ExtraTool,
  type PluginContext,
  type PluginDefinition,
} from '@cutpilot/plugin-sdk';
import type { z } from 'zod';
import { describeTemplate, TEMPLATES, templateById } from './templates.js';
import {
  findLatex,
  findManim,
  lastError,
  manimEnv,
  manimVersion,
  progressOf,
  runManim,
  runtimePath,
  type Runner,
} from './toolchain.js';

const VERSION = '0.1.0';

/** Where rendered clips are kept (the OS clears its temp folder; CutPilot keeps its own copy). */
export const cacheDir = () => join(tmpdir(), 'cutpilot-manim');

const issues = (e: z.ZodError) =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

const INSTALL: Record<string, string> = {
  darwin:
    'install Manim (brew install uv pango pkg-config, then uv tool install manim), or just uv and the plugin fetches Manim itself',
  linux:
    'install Manim (sudo apt install libcairo2-dev libpango1.0-dev pkg-config python3-dev, then uv tool install manim), or just those and uv',
  win32:
    'install Manim (winget install astral-sh.uv, then uv tool install manim), or just uv and the plugin fetches Manim itself',
};
const installFix = () =>
  `${INSTALL[process.platform] ?? INSTALL.linux}; or set "Manim command" in CutPilot → Plugins → Manim`;

const NO_MANIM = (setting: string) =>
  setting.trim()
    ? new PluginFailure(
        'E_MANIM_NOT_FOUND',
        `the "Manim command" setting points nowhere: ${setting.trim()}`,
        'set it to a manim executable or a Python that has manim, or clear it to let the plugin find one',
      )
    : new PluginFailure('E_MANIM_NOT_FOUND', 'Manim is not installed (and neither is uv)', installFix());
const NO_LATEX = () =>
  new PluginFailure(
    'E_MANIM_NO_LATEX',
    'this needs LaTeX (latex and dvisvgm), which is not installed',
    process.platform === 'darwin'
      ? 'install MacTeX or BasicTeX (brew install --cask basictex), or use a template without LaTeX (title, function-plot, bar-chart, morph-text)'
      : 'install TeX Live (sudo apt install texlive texlive-latex-extra dvisvgm), or use a template without LaTeX (title, function-plot, bar-chart, morph-text)',
  );

/** Manim's version per runner; the first call through uv downloads Manim, so it is remembered. */
const versions = new Map<string, Promise<string>>();
function versionOf(r: Runner, signal?: AbortSignal): Promise<string> {
  const key = [r.command, ...r.args].join(' ');
  let v = versions.get(key);
  if (!v) {
    v = manimVersion(r, signal);
    versions.set(key, v);
    v.catch(() => versions.delete(key));
  }
  return v;
}

/** Wait for Manim's version, reporting progress meanwhile so a first download isn't timed out. */
async function readyManim(ctx: PluginContext): Promise<{ runner: Runner; version: string }> {
  const setting = String(ctx.settings.manimCommand ?? '');
  const runner = findManim(setting);
  if (!runner) throw NO_MANIM(setting);
  const beat = setInterval(
    () => ctx.progress(0, runner.via === 'uv' ? 'getting Manim with uv (first use only)' : 'starting Manim'),
    5000,
  );
  try {
    return { runner, version: await versionOf(runner, ctx.signal) };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    throw new PluginFailure(
      'E_MANIM_BROKEN',
      `Manim does not start (${[runner.command, ...runner.args].join(' ')}): ${(e as Error).message.slice(0, 300)}`,
      installFix(),
    );
  } finally {
    clearInterval(beat);
  }
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory() && e.name !== 'partial_movie_files') {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

interface Rendered {
  durationMs: number;
  hasAudio: boolean;
}

const doctor: ExtraTool = {
  description:
    'What this machine has for Manim renders: Manim (and how it is started), its version, LaTeX for equations, and what to install when something is missing. Slow the first time when Manim comes through uv.',
  input: {},
  async handler(_a: unknown, ctx: PluginContext) {
    const setting = String(ctx.settings.manimCommand ?? '');
    const runner = findManim(setting);
    const latex = findLatex();
    const problems: string[] = [];
    let version: string | null = null;
    if (!runner) problems.push(NO_MANIM(setting).fix);
    else
      try {
        version = (await readyManim(ctx)).version;
      } catch (e) {
        problems.push(e instanceof PluginFailure ? `${e.message}; ${e.fix}` : String(e));
      }
    const equations = !!latex.latex && !!latex.dvisvgm;
    return {
      ok: problems.length === 0,
      manim: runner
        ? { command: [runner.command, ...runner.args].join(' '), via: runner.via, version }
        : null,
      latex: { ...latex, equations },
      problems,
      notes: equations ? [] : [`equations need LaTeX: ${NO_LATEX().fix}`],
    };
  },
};

const GUIDE = `How to write a custom-scene for the Manim plugin (Manim Community, https://docs.manim.community).

The code is one Python file: \`from manim import *\` and a class extending Scene (or MovingCameraScene, ThreeDScene, ZoomedScene …) whose construct() animates with self.play(...) and self.wait(...). With several classes, pass sceneName; otherwise the last one is rendered.

Size: the frame is always 8 units tall; its width follows the edit's aspect: config.frame_width is 14.2 for 16:9, 8 for 1:1, 4.5 for 9:16. Lay out from config.frame_width / config.frame_height (and .scale_to_fit_width(config.frame_width * 0.85) on wide things), so the scene fits a vertical video too.

Length: DURATION is a global in your file: the clip's length in seconds (generate's durationMs / 1000). Time the animations to it (run_time=...). If the scene ends sooner, its last frame is held to DURATION; if it runs longer, the clip is longer and generate says so in durationMs.

Text: Text("...") and MarkupText need nothing more; MathTex / Tex / axes with numbers (include_numbers, add_coordinates, DecimalNumber) need LaTeX, which the doctor tool says whether the machine has. Without it, label axes with Text.

Colours: the background parameter sets the background; or self.camera.background_color = "#0f172a". Named colours: BLUE, YELLOW, RED, GREEN, WHITE, GREY, ...

Rules: no files outside the scene, no network, no input; Python errors come back with the line, so fix and call generate again.

Example:
${templateById('custom-scene')!.example.code as string}`;

const sceneGuide: ExtraTool = {
  description:
    'The rules for writing a custom-scene (Python code for Manim): the frame size per aspect, the DURATION global, which objects need LaTeX, an example. Read it before generate with template custom-scene.',
  input: {},
  handler: () => GUIDE,
};

export const definition: PluginDefinition = {
  listTemplates: () => ({ templates: TEMPLATES.map(describeTemplate) }),

  async generate(input, ctx) {
    const t = templateById(input.template);
    if (!t)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        `there is no template ${JSON.stringify(input.template)}`,
        `use one of ${TEMPLATES.map((x) => x.id).join(', ')}`,
      );
    const parsed = t.params.safeParse(input.params);
    if (!parsed.success)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        `${t.id}: ${issues(parsed.error)}`,
        `pass params as ${t.id}'s schema in list_templates says, e.g. ${JSON.stringify(t.example).slice(0, 200)}`,
      );
    const durationMs = input.durationMs ?? t.defaultDurationMs;
    if (durationMs < t.minDurationMs || durationMs > t.maxDurationMs)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        `${t.id} lasts ${t.minDurationMs / 1000}–${t.maxDurationMs / 1000} s, not ${durationMs / 1000} s`,
        `pass durationMs between ${t.minDurationMs} and ${t.maxDurationMs}, or leave it out (${t.defaultDurationMs})`,
      );
    const latex = findLatex();
    if (t.latex && (!latex.latex || !latex.dvisvgm)) throw NO_LATEX();

    const { runner, version } = await readyManim(ctx);
    const runtime = readFileSync(runtimePath());
    const frame = { width: input.width, height: input.height, fps: input.fps, durationMs };
    const params = parsed.data as Record<string, unknown>;
    const key = sha(JSON.stringify([VERSION, sha(runtime), version, t.id, params, frame])).slice(0, 16);
    const dir = join(cacheDir(), `${t.id}-${key}`);
    const file = join(dir, 'clip.mp4');
    const meta = join(dir, 'clip.json');

    if (!existsSync(file) || !existsSync(meta)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      // the runtime runs from the job folder, so Python's caches never land in the plugin
      writeFileSync(join(dir, 'cutpilot_manim.py'), runtime);
      const { code, ...rest } = params as { code?: string };
      if (code !== undefined) writeFileSync(join(dir, 'scene.py'), code);
      writeFileSync(
        join(dir, 'job.json'),
        JSON.stringify({
          template: t.id,
          params: rest,
          duration: durationMs / 1000,
          result: join(dir, 'result.json'),
          ...(code !== undefined ? { code: join(dir, 'scene.py') } : {}),
        }),
      );
      const media = join(dir, 'media');
      ctx.log(
        `rendering ${t.id} ${frame.width}x${frame.height}@${frame.fps} ${durationMs} ms with Manim ${version} in ${dir}`,
      );
      ctx.progress(0, `rendering ${t.name}`);
      let done = 0;
      const r = await runManim(
        runner,
        [
          'render',
          'cutpilot_manim.py',
          'CutPilotScene',
          '--resolution',
          `${frame.width},${frame.height}`,
          '--fps',
          String(frame.fps),
          '--media_dir',
          media,
          '--output_file',
          'clip',
          '--format',
          'mp4',
          '--disable_caching',
          '--verbosity',
          'WARNING',
        ],
        {
          cwd: dir,
          signal: ctx.signal,
          env: manimEnv({ CUTPILOT_MANIM_JOB: join(dir, 'job.json') }),
          onLine: (l) => {
            const f = progressOf(l);
            if (f !== null) done = f;
            // every progress bar line counts as a sign of life; the fraction moves per animation
            if (f !== null || /^Animation \d+/.test(l))
              ctx.progress(done * 0.95, f !== null ? undefined : l.slice(0, 80));
          },
        },
      );
      const out = r.code === 0 ? findFile(media, 'clip.mp4') : null;
      if (!out || !existsSync(join(dir, 'result.json'))) {
        const why = r.explained ?? lastError(r.tail);
        if (/latex|dvisvgm/i.test(why) && (!latex.latex || !latex.dvisvgm)) throw NO_LATEX();
        if (t.id === 'custom-scene')
          throw new PluginFailure(
            'E_MANIM_SCENE_FAILED',
            `the scene failed: ${why}`,
            'fix the code and call generate again; scene_guide lists the rules (size, DURATION, what needs LaTeX)',
          );
        throw new PluginFailure(
          'E_MANIM_RENDER_FAILED',
          `rendering ${t.id} failed (exit ${r.code}): ${why}`,
          'run the doctor tool (manim__doctor); if it says all is fine, report this to the plugin publisher',
        );
      }
      const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as {
        seconds: number;
        hasAudio: boolean;
      };
      renameSync(out, file);
      rmSync(media, { recursive: true, force: true });
      const rendered: Rendered = { durationMs: Math.round(result.seconds * 1000), hasAudio: result.hasAudio };
      writeFileSync(meta, JSON.stringify(rendered));
    }
    const rendered = JSON.parse(readFileSync(meta, 'utf8')) as Rendered;
    ctx.progress(1, 'done');
    return { file, width: frame.width, height: frame.height, ...rendered };
  },

  tools: { doctor, scene_guide: sceneGuide },
};

/** For tests: forget the versions read, so a changed setting or PATH is seen. */
export const forgetVersions = () => versions.clear();
