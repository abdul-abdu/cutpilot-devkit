/**
 * The plugin: a `generator` (list_templates, generate) and one extra tool, doctor. generate
 * checks the parameters against the template's schema, writes a HyperFrames project in a
 * folder named by everything that affects the picture, renders it with a local Chrome, checks
 * the MP4 with ffprobe and returns its path; NodCut copies it into the project. The same
 * request again is answered from that folder without rendering.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFailure, type ExtraTool, type PluginContext, type PluginDefinition } from '@nodcut/plugin-sdk';
import type { z } from 'zod';
import { compose, describeTemplate, TEMPLATES, templateById } from './templates.js';
import { cliVersion, gsapPath, probe, runCli, toolchain } from './toolchain.js';

const VERSION = '0.1.0';
const QUALITIES = ['draft', 'looks', 'delivery'] as const;

/** Where rendered clips are kept (the OS clears its temp folder; NodCut keeps its own copy). */
export const cacheDir = () => join(tmpdir(), 'nodcut-html-motion');

const issues = (e: z.ZodError) =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

const NO_FFMPEG = () =>
  new PluginFailure(
    'E_HTML_MOTION_NO_FFMPEG',
    'ffmpeg (with ffprobe) is not installed',
    'install ffmpeg (macOS: brew install ffmpeg) so it is on PATH',
  );
const NO_BROWSER = () =>
  new PluginFailure(
    'E_HTML_MOTION_NO_BROWSER',
    'no Chrome to render with',
    'install Google Chrome, or set "Chrome executable" in NodCut → Plugins → HTML Motion',
  );

/** A render's progress line → 0..1 of the render (HyperFrames prints "… 46% Streaming frame …"). */
export const progressOf = (line: string): number | null => {
  const m = /(\d{1,3})%/.exec(line);
  return m ? Math.min(100, Number(m[1])) / 100 : null;
};

const doctor: ExtraTool = {
  description:
    'What this machine has for HTML Motion renders: the HyperFrames CLI, Chrome, ffmpeg, and what to install when something is missing.',
  input: {},
  handler(_a: unknown, ctx: PluginContext) {
    const t = toolchain(ctx.settings.browserPath as string);
    const problems: string[] = [];
    if (!t.ffmpeg || !t.ffprobe) problems.push(NO_FFMPEG().fix);
    if (!t.chrome) problems.push(NO_BROWSER().fix);
    return {
      ok: problems.length === 0,
      hyperframes: t.hyperframes,
      node: process.version,
      chrome: t.chrome,
      ffmpeg: t.ffmpeg,
      ffprobe: t.ffprobe,
      problems,
    };
  },
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
        `pass params as ${t.id}'s schema in list_templates says, e.g. ${JSON.stringify(t.example)}`,
      );
    const durationMs = input.durationMs ?? t.defaultDurationMs;
    if (durationMs < t.minDurationMs || durationMs > t.maxDurationMs)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        `${t.id} lasts ${t.minDurationMs / 1000}–${t.maxDurationMs / 1000} s, not ${durationMs / 1000} s`,
        `pass durationMs between ${t.minDurationMs} and ${t.maxDurationMs}, or leave it out (${t.defaultDurationMs})`,
      );
    // HyperFrames renders whole frames per second; NodCut resamples the clip to the edit's rate
    const fps = Math.min(60, Math.max(1, Math.round(input.fps)));
    const frame = { width: input.width, height: input.height, fps, durationMs };
    const quality = QUALITIES.includes(ctx.settings.quality as never)
      ? (ctx.settings.quality as string)
      : 'looks';

    const key = createHash('sha256')
      .update(JSON.stringify([VERSION, cliVersion(), t.id, parsed.data, frame, quality]))
      .digest('hex')
      .slice(0, 16);
    const dir = join(cacheDir(), `${t.id}-${key}`);
    const file = join(dir, 'clip.mp4');
    const tools = toolchain(ctx.settings.browserPath as string);
    if (!tools.ffmpeg || !tools.ffprobe) throw NO_FFMPEG();

    if (!existsSync(file)) {
      if (!tools.chrome) throw NO_BROWSER();
      mkdirSync(join(dir, 'vendor'), { recursive: true });
      copyFileSync(gsapPath(), join(dir, 'vendor', 'gsap.min.js'));
      writeFileSync(join(dir, 'index.html'), compose(t, parsed.data, frame, 'vendor/gsap.min.js').html);
      const partial = join(dir, 'rendering.mp4');
      rmSync(partial, { force: true });
      ctx.log(`rendering ${t.id} ${frame.width}x${frame.height} ${durationMs} ms (${quality}) in ${dir}`);
      ctx.progress(0, `rendering ${t.name}`);
      const r = await runCli(
        ['render', dir, '--output', partial, '--quality', quality, '--fps', String(fps)],
        {
          cwd: dir,
          tools,
          signal: ctx.signal,
          onLine: (l) => {
            const f = progressOf(l);
            if (f !== null) ctx.progress(f * 0.95, l.trim().slice(0, 80));
          },
        },
      );
      if (r.code !== 0 || !existsSync(partial))
        throw new PluginFailure(
          'E_HTML_MOTION_RENDER_FAILED',
          `rendering ${t.id} failed (exit ${r.code}): ${r.tail.slice(-300)}`,
          'run the doctor tool (html-motion__doctor); if it says all is fine, report this to the plugin publisher',
        );
      renameSync(partial, file);
    }
    const got = await probe(tools.ffprobe!, file, ctx.signal).catch((e: Error) => {
      rmSync(file, { force: true });
      throw new PluginFailure(
        'E_HTML_MOTION_RENDER_FAILED',
        `the rendered ${t.id} can't be read: ${e.message}`,
        'try again; the broken file was removed',
      );
    });
    ctx.progress(1, 'done');
    return { file, durationMs: got.durationMs, width: got.width, height: got.height, hasAudio: got.hasAudio };
  },

  tools: { doctor },
};
