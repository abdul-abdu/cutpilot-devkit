/**
 * The plugin's tools. All are extra (free-form) tools: HyperFrames fits no plugin kind, so an AI
 * client sees them as hyperframes__doctor, hyperframes__compose, hyperframes__lint and
 * hyperframes__render, and passes them what it read from the engine (get_words, preview_data).
 * Nothing here touches the NodCut timeline: the plugin writes a project folder and an MP4.
 */
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { ASPECTS, PluginFailure, type ExtraTool, type PluginDefinition } from '@nodcut/plugin-sdk';
import { z } from 'zod';
import {
  CaptionsSchema,
  compose,
  CompositionSpecSchema,
  KeyframeSchema,
  SegmentSchema,
  TitleSchema,
  WordSchema,
  type CompositionSpec,
} from './compose.js';
import { gsapPath, runCli, toolchain, type Toolchain } from './hyperframes.js';
import { probe, type Probe } from './probe.js';

const tool = <S extends z.ZodRawShape>(t: ExtraTool<S>): ExtraTool => t as unknown as ExtraTool;

const QUALITIES = ['draft', 'looks', 'delivery'] as const;
const PROJECT_FILE = 'nodcut-edit.json';

const Dim = z.number().int().min(16).max(7680);

/** The output frame: the aspect asked for, as large as the source allows; or explicit sizes. */
export function outputSize(
  source: { width: number; height: number },
  aspect?: (typeof ASPECTS)[number],
  width?: number,
  height?: number,
): { width: number; height: number } {
  const even = (n: number) => Math.max(16, Math.round(n / 2) * 2);
  if (width && height) return { width: even(width), height: even(height) };
  const ratio = aspect
    ? Number(aspect.split(':')[0]) / Number(aspect.split(':')[1])
    : source.width / source.height;
  if (width) return { width: even(width), height: even(width / ratio) };
  if (height) return { width: even(height * ratio), height: even(height) };
  let h = source.height;
  let w = h * ratio;
  if (w > source.width) {
    w = source.width;
    h = w / ratio;
  }
  return { width: even(w), height: even(h) };
}

const missing = (t: Toolchain): PluginFailure | null => {
  if (!t.ffmpeg || !t.ffprobe)
    return new PluginFailure(
      'E_HYPERFRAMES_NO_FFMPEG',
      'ffmpeg (with ffprobe) is not installed',
      'install ffmpeg (macOS: brew install ffmpeg) so it is on PATH',
    );
  return null;
};

const noBrowser = () =>
  new PluginFailure(
    'E_HYPERFRAMES_NO_BROWSER',
    'no Chrome to render with',
    'install Google Chrome, or set "Chrome executable" in NodCut → Plugins → HyperFrames',
  );

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'edit';

export const definition: PluginDefinition = {
  tools: {
    doctor: tool({
      description:
        'What this machine has for HyperFrames renders: the CLI version, Chrome, ffmpeg. Run it first if a render fails.',
      input: {},
      handler(_a, ctx) {
        const t = toolchain(ctx.settings.browserPath as string);
        const problems: string[] = [];
        if (!t.chrome) problems.push(noBrowser().fix);
        if (!t.ffmpeg || !t.ffprobe) problems.push(missing(t)!.fix);
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
    }),

    compose: tool({
      description:
        'Write a HyperFrames project (index.html) for an edit: the kept parts of the source in order, captions from words, the reframe track as a pan, an optional title card. Returns the project folder; then call render.',
      input: {
        source: z.string().min(1).describe('absolute path of the source video (never modified)'),
        project: z
          .string()
          .optional()
          .describe(
            'folder to write the project into (created); default: a folder under the temp dir named after the source',
          ),
        aspect: z.enum(ASPECTS).optional().describe("output aspect; default: the source's"),
        width: Dim.optional().describe('output width in px; default: from the aspect and the source'),
        height: Dim.optional(),
        fps: z.number().int().min(1).max(120).optional().describe('default: the fps setting'),
        segments: z
          .array(SegmentSchema)
          .min(1)
          .optional()
          .describe('the kept parts in play order, source ms (from preview_data); default: the whole source'),
        words: z
          .array(WordSchema)
          .optional()
          .describe('the transcript in source ms (get_words), shown as captions'),
        captions: CaptionsSchema.optional().describe(
          'how captions look; default: lines of 4 words at the bottom',
        ),
        crop: z
          .array(KeyframeSchema)
          .min(1)
          .optional()
          .describe('the reframe track: crop centres (fractions of the source frame) over source ms'),
        title: TitleSchema.optional().describe('a title card over the first moments'),
      },
      async handler(a, ctx) {
        const tools = toolchain(ctx.settings.browserPath as string);
        const m = missing(tools);
        if (m) throw m;
        if (!isAbsolute(a.source) || !existsSync(a.source))
          throw new PluginFailure(
            'E_HYPERFRAMES_NO_SOURCE',
            `${a.source} doesn't exist`,
            'pass the absolute path of the source video (list_projects shows it)',
          );
        let src: Probe;
        try {
          src = await probe(tools.ffprobe!, a.source, ctx.signal);
        } catch (e) {
          throw new PluginFailure(
            'E_HYPERFRAMES_BAD_SOURCE',
            `ffprobe can't read ${basename(a.source)}: ${(e as Error).message}`,
            'pass a video file ffmpeg can decode',
          );
        }
        const size = outputSize(src, a.aspect, a.width, a.height);
        const spec: CompositionSpec = CompositionSpecSchema.parse({
          ...size,
          fps: a.fps ?? (ctx.settings.fps as number),
          segments: a.segments ?? [{ start: 0, end: Math.max(1, src.durationMs) }],
          words: a.words,
          captions: a.captions,
          crop: a.crop,
          title: a.title,
        });
        const over = spec.segments.find((s) => src.durationMs && s.end > src.durationMs);
        if (over)
          throw new PluginFailure(
            'E_HYPERFRAMES_BAD_SEGMENT',
            `segment ${over.start}–${over.end} ends after the source (${src.durationMs} ms)`,
            'pass segments in source time, inside the source',
          );

        const project = resolve(
          a.project ?? join(tmpdir(), 'nodcut-hyperframes', slug(basename(a.source, extname(a.source)))),
        );
        mkdirSync(join(project, 'assets'), { recursive: true });
        mkdirSync(join(project, 'vendor'), { recursive: true });
        const ext = extname(a.source) || '.mp4';
        const link = join(project, 'assets', `source${ext}`);
        rmSync(link, { force: true });
        try {
          symlinkSync(a.source, link);
        } catch {
          copyFileSync(a.source, link); // no symlinks here (Windows without the privilege)
        }
        copyFileSync(gsapPath(), join(project, 'vendor', 'gsap.min.js'));
        const c = compose(spec, { src: `assets/source${ext}`, ...src, gsap: 'vendor/gsap.min.js' });
        writeFileSync(join(project, 'index.html'), c.html);
        writeFileSync(
          join(project, PROJECT_FILE),
          JSON.stringify({ source: a.source, spec }, null, 2) + '\n',
        );
        ctx.log(
          `composed ${project} (${c.clips} clips, ${c.captionLines} caption lines, ${c.durationMs} ms)`,
        );
        return {
          project,
          html: join(project, 'index.html'),
          ...size,
          fps: spec.fps,
          durationMs: c.durationMs,
          clips: c.clips,
          captionLines: c.captionLines,
          source: src,
          next: `render({ project: ${JSON.stringify(project)} })`,
        };
      },
    }),

    lint: tool({
      description: "HyperFrames' own checks of a composed project (no browser needed).",
      input: { project: z.string().min(1).describe('the folder compose wrote') },
      async handler(a, ctx) {
        const project = resolve(a.project);
        if (!existsSync(join(project, 'index.html')))
          throw new PluginFailure(
            'E_HYPERFRAMES_NO_PROJECT',
            `${project} has no index.html`,
            'call compose first',
          );
        const lines: string[] = [];
        const r = await runCli(['lint', project, '--verbose'], {
          cwd: project,
          tools: toolchain(ctx.settings.browserPath as string),
          signal: ctx.signal,
          onLine: (l) => lines.push(l),
        });
        return { ok: r.code === 0, output: lines.join('\n') };
      },
    }),

    render: tool({
      description:
        'Render a composed project to an MP4 with headless Chrome and ffmpeg. Takes a while (about real time or longer); progress is reported.',
      input: {
        project: z.string().min(1).describe('the folder compose wrote'),
        output: z.string().optional().describe('where to write the MP4; default: <project>/renders/main.mp4'),
        fps: z
          .number()
          .int()
          .min(1)
          .max(120)
          .optional()
          .describe('default: the fps the project was composed with'),
        quality: z.enum(QUALITIES).optional().describe('default: the quality setting'),
      },
      async handler(a, ctx) {
        const project = resolve(a.project);
        if (!existsSync(join(project, 'index.html')))
          throw new PluginFailure(
            'E_HYPERFRAMES_NO_PROJECT',
            `${project} has no index.html`,
            'call compose first',
          );
        const tools = toolchain(ctx.settings.browserPath as string);
        const m = missing(tools);
        if (m) throw m;
        if (!tools.chrome) throw noBrowser();

        const output = resolve(a.output ?? join(project, 'renders', 'main.mp4'));
        mkdirSync(dirname(output), { recursive: true });
        const args = [
          'render',
          project,
          '--output',
          output,
          '--quality',
          a.quality ?? (ctx.settings.quality as string),
        ];
        if (a.fps) args.push('--fps', String(a.fps));
        const started = Date.now();
        ctx.log(`hyperframes ${args.join(' ')}`);
        const r = await runCli(args, {
          cwd: project,
          tools,
          signal: ctx.signal,
          onLine: (l) => {
            ctx.log(l);
            const pct = /(\d{1,3})%/.exec(l);
            if (pct) ctx.progress(Number(pct[1]) / 100, l.trim().slice(0, 80));
          },
        });
        if (r.code !== 0 || !existsSync(output))
          throw new PluginFailure(
            'E_HYPERFRAMES_RENDER_FAILED',
            `hyperframes render exited with ${r.code}: ${r.tail.slice(-300)}`,
            `run "npx hyperframes render" in ${project} to see the full output`,
          );
        return {
          file: output,
          bytes: statSync(output).size,
          seconds: Math.round((Date.now() - started) / 100) / 10,
        };
      },
    }),
  },
};
