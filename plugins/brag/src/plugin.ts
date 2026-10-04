/**
 * The plugin: extra tools only. The AI follows /brag's method (guide) and works in a project
 * folder through the plugin, since its client may have no file access of its own:
 * start_project → write_file / add_asset (list_sounds) → check → snapshot → render. The video is
 * a file; CutPilot's own tools put it into an edit (the plugin never touches the timeline).
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  defineTool,
  imageBlock,
  PluginFailure,
  ToolContent,
  type PluginContext,
  type PluginDefinition,
} from '@cutpilot/plugin-sdk';
import { z } from 'zod';
import { FORMATS, GUIDE_TOPICS, HYPERFRAMES_DOCS, PAGES, starterComposition, type Format } from './guide.js';
import {
  allSounds,
  copyAsset,
  findSounds,
  MARKER,
  newProjectDir,
  projectDir,
  projectsRoot,
  RISKS,
  soundPath,
  writeText,
} from './project.js';
import { gsapPath, probe, runCli, toolchain, type Toolchain } from './toolchain.js';

const QUALITIES = ['draft', 'looks', 'delivery'] as const;
const FPS = 30;

interface ProjectInfo {
  name: string;
  format: Format;
  width: number;
  height: number;
  fps: number;
  durationS: number;
}

const NO_FFMPEG = () =>
  new PluginFailure(
    'E_BRAG_NO_FFMPEG',
    'ffmpeg (with ffprobe) is not installed',
    'install ffmpeg (macOS: brew install ffmpeg) so it is on PATH',
  );
const NO_BROWSER = () =>
  new PluginFailure(
    'E_BRAG_NO_BROWSER',
    'no Chrome to check, snapshot or render with',
    'install Google Chrome, or set "Chrome executable" in CutPilot → Plugins → Brag',
  );

/** A render's progress line → 0..1 of the render (HyperFrames prints "… 46% Streaming frame …"). */
export const progressOf = (line: string): number | null => {
  const m = /(\d{1,3})%/.exec(line);
  return m ? Math.min(100, Number(m[1])) / 100 : null;
};

function open(path: string): { dir: string; info: ProjectInfo } {
  const dir = projectDir(path);
  return { dir, info: JSON.parse(readFileSync(join(dir, MARKER), 'utf8')) as ProjectInfo };
}

function tools(ctx: PluginContext, needChrome: boolean): Toolchain {
  const t = toolchain(ctx.settings.browserPath as string);
  if (needChrome && !t.chrome) throw NO_BROWSER();
  return t;
}

const run = (file: string, args: string[], signal: AbortSignal) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, { signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(stderr.trim().split('\n').slice(-3).join(' ') || err.message)) : resolve(stdout),
    ),
  );

interface Finding {
  section: string;
  severity: string;
  code?: string;
  message: string;
  selector?: string;
  time?: number;
  fix?: string;
}

/** `hyperframes check --json` → what to fix, errors first. */
export function readCheck(json: string): {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
} {
  const r = JSON.parse(json) as Record<string, unknown>;
  const findings: Finding[] = [];
  let errors = 0;
  let warnings = 0;
  for (const [section, v] of Object.entries(r)) {
    const s = v as {
      errorCount?: number;
      warningCount?: number;
      findings?: Record<string, unknown>[];
    } | null;
    if (!s || typeof s !== 'object' || !Array.isArray(s.findings)) continue;
    errors += s.errorCount ?? 0;
    warnings += s.warningCount ?? 0;
    for (const f of s.findings)
      findings.push({
        section,
        severity: String(f.severity ?? 'info'),
        code: f.code as string | undefined,
        message: String(f.message ?? ''),
        selector: f.selector as string | undefined,
        time: typeof f.time === 'number' ? f.time : undefined,
        fix: (f.fixHint ?? f.fix) as string | undefined,
      });
  }
  const rank = (x: string) => ['error', 'warning'].indexOf(x) + 1 || 3;
  findings.sort((a, b) => rank(a.severity) - rank(b.severity));
  return { ok: r.ok === true, errors, warnings, findings: findings.slice(0, 40) };
}

export const definition: PluginDefinition = {
  tools: {
    guide: defineTool({
      description:
        'How to make a /brag launch video: start here. Topic "workflow" (default) is the whole method: inspect what was built, plan a 15–25 s story, compose it, render it. "tones" lists the tone presets; "hyperframes" the rules composition/index.html must follow; hyperframes-<page> is a HyperFrames docs page (data-attributes, gsap, compositions, rendering, troubleshooting).',
      input: {
        topic: z
          .enum([...GUIDE_TOPICS, ...HYPERFRAMES_DOCS.map((d) => `hyperframes-${d}` as const)])
          .default('workflow')
          .describe('workflow, tones, hyperframes, or hyperframes-<docs page>'),
      },
      async handler({ topic }, ctx) {
        if (topic in PAGES) return PAGES[topic as keyof typeof PAGES];
        const page = topic.replace(/^hyperframes-/, '');
        const r = await runCli(['docs', page], {
          cwd: process.cwd(),
          tools: tools(ctx, false),
          signal: ctx.signal,
        });
        if (r.code !== 0)
          throw new PluginFailure(
            'E_BRAG_DOCS',
            `hyperframes docs ${page} failed: ${r.tail}`,
            'use topic "hyperframes" instead',
          );
        return r.stdout
          .replace(/^.*(telemetry|usage data|collects anonymous|File paths and|sign in to HeyGen).*$/gim, '')
          .trim();
      },
    }),

    start_project: defineTool({
      description:
        "Make a brag project folder with a starter composition (composition/index.html that passes check) at the format's size. Returns the folder: pass it as project to the other tools. Call after inspecting, before writing brag-plan.md.",
      input: {
        name: z.string().trim().min(1).max(60).describe('what the video is about, e.g. "Qaychi"'),
        format: z
          .enum(['landscape', 'vertical', 'square'])
          .default('landscape')
          .describe('landscape 1920x1080, vertical 1080x1920, square 1080x1080'),
        durationS: z
          .number()
          .min(1)
          .max(60)
          .default(20)
          .describe('target length in seconds; 15–25 is the brag window'),
      },
      handler({ name, format, durationS }, ctx) {
        const root = projectsRoot(ctx.settings.outputDir as string);
        let dir = newProjectDir(root, name);
        const { width, height } = FORMATS[format];
        const info: ProjectInfo = { name, format, width, height, fps: FPS, durationS };
        mkdirSync(join(dir, 'composition', 'vendor'), { recursive: true });
        mkdirSync(join(dir, 'composition', 'assets'), { recursive: true });
        // the resolved path, as every other tool answers with (macOS: /var is /private/var)
        dir = realpathSync(dir);
        writeFileSync(join(dir, MARKER), JSON.stringify(info, null, 2));
        copyFileSync(gsapPath(), join(dir, 'composition', 'vendor', 'gsap.min.js'));
        const html = starterComposition({ title: name, width, height, fps: FPS, durationS });
        writeFileSync(join(dir, 'composition', 'index.html'), html);
        ctx.log(`brag project ${dir}`);
        return {
          project: dir,
          ...info,
          files: ['composition/index.html', 'composition/vendor/gsap.min.js', 'composition/assets/'],
          starter: html,
          next: 'write brag-plan.md with write_file, add assets with add_asset, then replace composition/index.html',
        };
      },
    }),

    write_file: defineTool({
      description:
        'Write a text file in a brag project: brag-plan.md, composition-brief.md, share-copy.txt, composition/index.html, or more composition files (a .css, a sub-composition). Replaces the file. Paths are relative to the project folder.',
      input: {
        project: z.string().min(1).describe('the folder start_project returned'),
        path: z.string().min(1).max(200).describe('relative path, e.g. composition/index.html'),
        content: z.string().max(2_000_000).describe('the whole file'),
      },
      handler({ project, path, content }) {
        const { dir } = open(project);
        const full = writeText(dir, path, content);
        return { written: full, bytes: Buffer.byteLength(content) };
      },
    }),

    add_asset: defineTool({
      description:
        "Copy a file into the project's composition/assets/: a logo, screenshot, product image, video clip, font or music file from this computer (file), or one of the bundled sound effects (sound, from list_sounds). Returns src, the path to use in the composition (e.g. assets/logo.svg).",
      input: {
        project: z.string().min(1).describe('the folder start_project returned'),
        file: z.string().optional().describe('absolute path of a file on this computer'),
        sound: z
          .string()
          .optional()
          .describe('a bundled sound effect as list_sounds gives it, e.g. impact/impactSoft_medium_001.ogg'),
        as: z
          .string()
          .max(120)
          .optional()
          .describe("the name under assets/, e.g. music.mp3 or sfx/reveal.ogg; default: the file's own name"),
      },
      handler({ project, file, sound, as }) {
        const { dir } = open(project);
        if (!!file === !!sound)
          throw new PluginFailure(
            'E_PLUGIN_BAD_INPUT',
            'pass either file or sound',
            'file for a file on this computer, sound for a bundled effect',
          );
        return sound
          ? copyAsset(dir, soundPath(sound), as ?? join('sfx', sound.split('/').pop()!))
          : copyAsset(dir, file!, as);
      },
    }),

    list_sounds: defineTool({
      description: `The bundled sound effects (Kenney, CC0): file, length, brightness, high-frequency risk (low suits polished videos and repeated sounds; high only for tiny accents or the chaotic tone) and suggested uses. Filter by use (e.g. "button press", "major reveal", "card reveal", "logo payoff", "typing"), family (${[...new Set(allSounds().map((s) => s.family))].join(', ')}) or maxRisk. Add one with add_asset's sound.`,
      input: {
        use: z.string().max(40).optional().describe('a suggested use, or part of one, e.g. "reveal"'),
        family: z.string().max(20).optional().describe('casino, impact, interface, keyboard or ui'),
        maxRisk: z.enum(RISKS).optional().describe('the highest high-frequency risk to list'),
      },
      handler(q) {
        const found = findSounds(q);
        return { count: found.length, sounds: found.slice(0, 40), more: Math.max(0, found.length - 40) };
      },
    }),

    check: defineTool({
      description:
        "HyperFrames' gate before rendering: lint, runtime errors, missing assets, layout (overflow, overlap) and contrast, sampled across the timeline in headless Chrome. Fix every error, then check again. Takes a few seconds.",
      input: { project: z.string().min(1).describe('the folder start_project returned') },
      async handler({ project }, ctx) {
        const { dir } = open(project);
        const t = tools(ctx, true);
        ctx.progress(0, 'checking the composition');
        const r = await runCli(['check', '--json', '--at-transitions', join(dir, 'composition')], {
          cwd: dir,
          tools: t,
          signal: ctx.signal,
        });
        const json = /\{[\s\S]*\}\s*$/.exec(r.stdout)?.[0];
        if (!json)
          throw new PluginFailure(
            'E_BRAG_CHECK_FAILED',
            `hyperframes check gave no result (exit ${r.code}): ${r.tail.slice(-300)}`,
            'make sure composition/index.html is a whole HTML page; guide topic "hyperframes" has the rules',
          );
        return readCheck(json);
      },
    }),

    snapshot: defineTool({
      description:
        'Stills of the composition at the given seconds, to look at before rendering: one image each (up to 6). Look at every scene and at mid-transition moments; fix overflow, collisions and low contrast.',
      input: {
        project: z.string().min(1).describe('the folder start_project returned'),
        at: z.array(z.number().min(0)).min(1).max(6).describe('times in seconds, e.g. [1.2, 4, 4.4, 9]'),
      },
      async handler({ project, at }, ctx) {
        const { dir, info } = open(project);
        const t = tools(ctx, true);
        const out = join(dir, 'snapshots', String(Date.now()));
        ctx.progress(0, 'capturing stills');
        const r = await runCli(
          [
            'snapshot',
            join(dir, 'composition'),
            '--at',
            at.join(','),
            '--no-end',
            '--describe',
            'false',
            '-o',
            out,
          ],
          { cwd: dir, tools: t, signal: ctx.signal },
        );
        const pngs = existsSync(out)
          ? readdirSync(out)
              .filter((f) => /^frame-.*\.png$/.test(f))
              .sort()
          : [];
        if (r.code !== 0 || !pngs.length)
          throw new PluginFailure(
            'E_BRAG_SNAPSHOT_FAILED',
            `hyperframes snapshot failed (exit ${r.code}): ${r.tail.slice(-300)}`,
            'run check first and fix what it reports',
          );
        const blocks = [];
        for (const f of pngs) {
          const png = join(out, f);
          // a smaller JPEG when ffmpeg can make one: full-size frames are megabytes each
          let bytes: Buffer = readFileSync(png);
          let mime = 'image/png';
          if (t.ffmpeg && info.width > 960) {
            const jpg = png.replace(/\.png$/, '.jpg');
            await run(
              t.ffmpeg,
              ['-v', 'error', '-y', '-i', png, '-vf', 'scale=960:-2', '-q:v', '3', jpg],
              ctx.signal,
            ).catch(() => null);
            if (existsSync(jpg)) {
              bytes = readFileSync(jpg);
              mime = 'image/jpeg';
            }
          }
          blocks.push(
            { type: 'text' as const, text: `${f.replace(/^frame-\d+-at-|\.png$/g, '')} (${png})` },
            imageBlock(bytes, mime),
          );
        }
        return new ToolContent(blocks, { folder: out, frames: pngs.map((f) => join(out, f)) });
      },
    }),

    render: defineTool({
      description:
        "Render the composition to brag.mp4 in the project (about real time or longer; progress is reported). With posterAt, the frame at that second becomes brag.jpg and is baked in as frame 0, so every platform shows it as the thumbnail: pick the strongest settled frame. Run check first. Returns the files; add brag.mp4 to the user's edit with CutPilot's own tools.",
      input: {
        project: z.string().min(1).describe('the folder start_project returned'),
        posterAt: z
          .number()
          .min(0)
          .optional()
          .describe('seconds: the strongest settled frame, for brag.jpg and frame 0'),
      },
      async handler({ project, posterAt }, ctx) {
        const { dir, info } = open(project);
        const t = tools(ctx, true);
        if (!t.ffmpeg || !t.ffprobe) throw NO_FFMPEG();
        const quality = QUALITIES.includes(ctx.settings.quality as never)
          ? String(ctx.settings.quality)
          : 'looks';
        const file = join(dir, 'brag.mp4');
        const partial = join(dir, 'rendering.mp4');
        rmSync(partial, { force: true });
        ctx.progress(0, 'rendering');
        const r = await runCli(
          [
            'render',
            join(dir, 'composition'),
            '--output',
            partial,
            '--quality',
            quality,
            '--fps',
            String(info.fps),
          ],
          {
            cwd: dir,
            tools: t,
            signal: ctx.signal,
            onLine: (l) => {
              const f = progressOf(l);
              if (f !== null) ctx.progress(f * 0.9, l.trim().slice(0, 80));
            },
          },
        );
        if (r.code !== 0 || !existsSync(partial))
          throw new PluginFailure(
            'E_BRAG_RENDER_FAILED',
            `rendering failed (exit ${r.code}): ${r.tail.slice(-300)}`,
            'run check and fix what it reports; if it passes, try Render quality "draft"',
          );
        renameSync(partial, file);
        const got = await probe(t.ffprobe, file, ctx.signal);
        let poster: string | undefined;
        if (posterAt !== undefined) {
          if (posterAt * 1000 >= got.durationMs)
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              `posterAt ${posterAt} s is past the end of the ${got.durationMs / 1000} s video (brag.mp4 is rendered)`,
              'call render again with a posterAt inside the video',
            );
          ctx.progress(0.92, 'poster frame');
          poster = join(dir, 'brag.jpg');
          await run(
            t.ffmpeg,
            ['-v', 'error', '-y', '-ss', String(posterAt), '-i', file, '-frames:v', '1', '-q:v', '2', poster],
            ctx.signal,
          );
          // replace frame 0 (not add one), so length and audio sync stay the same
          const baked = join(dir, 'baking.mp4');
          const filter = `[1:v]scale=${got.width}:${got.height},format=yuv420p[p];[0:v][p]overlay=shortest=1:enable='eq(n,0)'[v]`;
          // prettier-ignore
          await run(t.ffmpeg, [
            '-v', 'error', '-y', '-i', file, '-loop', '1', '-i', poster,
            '-filter_complex', filter, '-map', '[v]', ...(got.hasAudio ? ['-map', '0:a', '-c:a', 'copy'] : []),
            '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
            baked,
          ], ctx.signal);
          renameSync(baked, file);
        }
        const done = await probe(t.ffprobe, file, ctx.signal);
        ctx.progress(1, 'done');
        const share = join(dir, 'share-copy.txt');
        return {
          file,
          poster,
          shareCopy: existsSync(share) ? share : undefined,
          durationMs: done.durationMs,
          width: done.width,
          height: done.height,
          hasAudio: done.hasAudio,
          ...(existsSync(share) ? {} : { next: 'write share-copy.txt with write_file' }),
        };
      },
    }),

    doctor: defineTool({
      description:
        'What this machine has for brag videos: the HyperFrames CLI, Chrome, ffmpeg, and what to install when something is missing.',
      input: {},
      handler(_a, ctx) {
        const t = toolchain(ctx.settings.browserPath as string);
        const problems: string[] = [];
        if (!t.ffmpeg || !t.ffprobe) problems.push(NO_FFMPEG().fix);
        if (!t.chrome) problems.push(NO_BROWSER().fix);
        return {
          ok: problems.length === 0,
          hyperframes: t.hyperframes,
          chrome: t.chrome,
          ffmpeg: t.ffmpeg,
          ffprobe: t.ffprobe,
          projects: projectsRoot(ctx.settings.outputDir as string),
          sounds: allSounds().length,
          problems,
        };
      },
    }),
  },
};
