import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  defineTool,
  imageBlock,
  PluginFailure,
  ToolContent,
  type PluginContext,
  type PluginDefinition,
} from '@nodcut/plugin-sdk';
import { z } from 'zod';
import { choices, Comfy, localUrl } from './comfy.js';
import { executable, probe, range, run } from './media.js';
import { processingSize, REQUIRED_NODES, type Lighting } from './workflow.js';

export const VIDEO_NOTICE =
  'Experimental: frames are relit independently. A fixed seed does not ensure temporal consistency; flicker and changes to appearance are possible. Review before using the clip.';
export const TERMS = [
  {
    name: 'ComfyUI (your installation)',
    license: 'GPL-3.0',
    url: 'https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE',
  },
  {
    name: 'ComfyUI-IC-Light-Native (your installation)',
    license: 'Apache-2.0',
    url: 'https://github.com/huchenlei/ComfyUI-IC-Light-Native/blob/main/LICENSE',
  },
  {
    name: 'IC-Light SD1.5 foreground weights (your download)',
    license: 'Apache-2.0',
    url: 'https://huggingface.co/lllyasviel/ic-light',
  },
  {
    name: 'Your base SD1.5 checkpoint',
    license: 'The publisher’s separate terms; the plugin cannot infer them from a filename.',
  },
];

const lightInput = {
  prompt: z
    .string()
    .min(1)
    .max(1500)
    .default('soft studio lighting, soft key light from the left, natural skin tones, detailed face')
    .describe(
      'Lighting description, e.g. soft studio lighting, key light from the left; appearance can also change.',
    ),
  negativePrompt: z
    .string()
    .max(1500)
    .default('blurry, distorted, low quality, overexposed')
    .describe('Things to avoid, e.g. blurry, distorted, overexposed.'),
  seed: z
    .number()
    .int()
    .min(0)
    .max(2_147_483_647)
    .default(42)
    .describe('Noise seed; the same seed is used for every video frame. It does not prevent flicker.'),
  steps: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Diffusion steps per frame, default 20; more steps take longer.'),
  cfg: z.number().min(1).max(15).default(3).describe('Prompt guidance strength, default 3.'),
  denoise: z
    .number()
    .min(0.05)
    .max(1)
    .default(0.6)
    .describe(
      'Image-to-image denoising strength, default 0.6; larger values can change identity and scene details.',
    ),
  maxSide: z
    .number()
    .int()
    .min(64)
    .max(1024)
    .default(512)
    .describe(
      'Largest processing dimension in pixels, default 512; video is resized back to the source dimensions when encoded.',
    ),
};

interface Configuration {
  dataDir: string;
  checkpoint: string;
  icLightModel: string;
  timeoutMs: number;
  maxSeconds: number;
  ffmpeg: string | null;
  ffprobe: string | null;
  comfy: Comfy;
  key: string;
}

function settingNumber(value: unknown, fallback: number, min: number, max: number, label: string): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n) || n < min || n > max)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${label} must be between ${min} and ${max}`,
      `change ${label} in the plugin settings`,
    );
  return n;
}

function configuration(ctx: PluginContext, transport: typeof fetch, pollMs: number): Configuration {
  const dataDir =
    typeof ctx.settings.dataDir === 'string' && ctx.settings.dataDir.trim()
      ? ctx.settings.dataDir.trim()
      : join(homedir(), '.nodcut', 'ic-light');
  if (!isAbsolute(dataDir))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'Data folder must be an absolute path',
      'choose a Data folder in the plugin settings',
    );
  const checkpoint = String(ctx.settings.checkpoint ?? '').trim();
  const icLightModel = String(ctx.settings.icLightModel ?? 'iclight_sd15_fc_unet_ldm.safetensors').trim();
  const comfy = new Comfy(localUrl(ctx.settings.comfyUrl), transport, pollMs);
  return {
    dataDir,
    checkpoint,
    icLightModel,
    comfy,
    timeoutMs: settingNumber(ctx.settings.frameTimeoutSeconds, 1200, 5, 7200, 'Frame timeout seconds') * 1000,
    maxSeconds: settingNumber(ctx.settings.maxVideoSeconds, 10, 1, 600, 'Maximum video seconds'),
    ffmpeg: executable(ctx.settings.ffmpegPath, 'ffmpeg'),
    ffprobe: executable(ctx.settings.ffprobePath, 'ffprobe'),
    key: JSON.stringify([1, comfy.url.origin, checkpoint, icLightModel]),
  };
}

interface Acceptance {
  key: string;
  at: string;
  checkpointLicenseUrl: string;
}
async function acceptance(c: Configuration): Promise<Acceptance | null> {
  try {
    const a = JSON.parse(await readFile(join(c.dataDir, 'acceptance.json'), 'utf8')) as Acceptance;
    return a.key === c.key &&
      typeof a.checkpointLicenseUrl === 'string' &&
      /^https?:\/\//.test(a.checkpointLicenseUrl)
      ? a
      : null;
  } catch {
    return null;
  }
}

/** The HTTP transport and poll interval are injectable for protocol tests; no models in CI. */
export function makeDefinition(transport: typeof fetch = fetch, pollMs = 1000): PluginDefinition {
  async function inspect(ctx: PluginContext) {
    const c = configuration(ctx, transport, pollMs);
    const agreed = await acceptance(c);
    const problems: string[] = [];
    if (!c.ffmpeg) problems.push('FFmpeg is missing; install it or set FFmpeg path.');
    if (!c.ffprobe) problems.push('FFprobe is missing; install FFmpeg or set FFprobe path.');
    let checkpoints: string[] = [];
    let icLightModels: string[] = [];
    let stats: Record<string, unknown> | null = null;
    try {
      const info = await c.comfy.info(ctx.signal);
      stats = info.stats;
      const missing = REQUIRED_NODES.filter((n) => !info.nodes[n]);
      if (missing.length)
        problems.push(
          `Missing ComfyUI nodes: ${missing.join(', ')}. Install ComfyUI-IC-Light-Native and restart ComfyUI.`,
        );
      checkpoints = choices(info.nodes, 'CheckpointLoaderSimple', 'ckpt_name');
      icLightModels = choices(info.nodes, 'UNETLoader', 'unet_name');
      if (!c.checkpoint || !checkpoints.includes(c.checkpoint))
        problems.push(
          'Set SD1.5 checkpoint to an installed checkpoint name shown in checkpoints. SDXL/Flux are not supported.',
        );
      if (
        !icLightModels.includes(c.icLightModel) ||
        !/(^|[/\\])iclight_sd15_fc_unet_ldm(?:\.[^.]+)?$/.test(c.icLightModel)
      )
        problems.push(
          'Set IC-Light model to the converted SD1.5 foreground model iclight_sd15_fc_unet_ldm.safetensors in ComfyUI/models/unet. The fbc background model is not supported by this workflow.',
        );
    } catch (e) {
      ctx.signal.throwIfAborted();
      if (e instanceof PluginFailure) problems.push(`${e.message}; ${e.fix}`);
      else throw e;
    }
    return {
      c,
      report: {
        ok: problems.length === 0 && !!agreed,
        configured: problems.length === 0,
        accepted: !!agreed,
        comfyUrl: c.comfy.url.origin,
        dataDir: c.dataDir,
        ffmpeg: c.ffmpeg,
        ffprobe: c.ffprobe,
        checkpoint: c.checkpoint,
        icLightModel: c.icLightModel,
        checkpoints,
        icLightModels,
        stats,
        problems,
        terms: TERMS.map((t) => ({
          ...t,
          ...(t.name === 'Your base SD1.5 checkpoint' && agreed ? { url: agreed.checkpointLicenseUrl } : {}),
        })),
        downloads: [],
        setup:
          'Use your own local ComfyUI, native IC-Light nodes and SD1.5 models. Nothing is installed or downloaded by this plugin. Show these terms and the selected base checkpoint’s licence to the user, then call ic-light__setup with agree:true and its licence URL.',
        video: VIDEO_NOTICE,
      },
    };
  }

  async function ready(ctx: PluginContext) {
    const c = configuration(ctx, transport, pollMs);
    if (!(await acceptance(c)))
      throw new PluginFailure(
        'E_PLUGIN_NOT_APPROVED',
        'terms for the selected ComfyUI and models have not been accepted',
        'run ic-light__doctor, show the user the component terms and their base checkpoint’s licence, then call ic-light__setup with agree:true and checkpointLicenseUrl after they agree',
      );
    const status = await inspect(ctx);
    if (!status.report.configured)
      throw new PluginFailure(
        'E_PLUGIN_FAILED',
        'IC-Light is not ready',
        status.report.problems.join(' ').slice(0, 1500),
      );
    return c;
  }

  async function work<T>(
    c: Configuration,
    ctx: PluginContext,
    action: (dir: string, progress: (fraction: number, message: string) => void) => Promise<T>,
  ): Promise<T> {
    const dir = join(c.dataDir, 'outputs', randomUUID());
    await mkdir(dir, { recursive: true });
    let latest = { fraction: 0, message: 'preparing relighting' };
    const progress = (fraction: number, message: string) => {
      latest = { fraction, message };
      ctx.progress(fraction, message);
    };
    const heartbeat = setInterval(() => ctx.progress(latest.fraction, latest.message), 10_000);
    try {
      return await action(dir, progress);
    } catch (e) {
      await rm(dir, { recursive: true, force: true });
      throw e;
    } finally {
      clearInterval(heartbeat);
    }
  }

  const sourceInput = z
    .string()
    .min(1)
    .describe(
      'Absolute path to the source picture or video, obtained from list_media; the source is never overwritten.',
    );
  return {
    tools: {
      doctor: defineTool({
        description:
          'Check the local ComfyUI connection, native IC-Light nodes, models, FFmpeg and acceptance. Lists installed model names and terms. Downloads nothing; run this before setup or rendering.',
        input: {},
        handler: async (_, ctx) => (await inspect(ctx)).report,
      }),
      setup: defineTool({
        description:
          'Record the user’s agreement to use their own installed ComfyUI and models after doctor shows their terms. Installs and downloads nothing. Re-run when changing the server or models.',
        input: {
          agree: z
            .boolean()
            .default(false)
            .describe(
              'True only after the user has seen the terms from doctor and their selected base checkpoint’s licence and agreed.',
            ),
          checkpointLicenseUrl: z
            .url({ protocol: /^https?$/ })
            .describe(
              'The selected SD1.5 checkpoint publisher’s actual licence URL, e.g. its Hugging Face LICENSE file; this is recorded, not fetched.',
            ),
        },
        handler: async ({ agree, checkpointLicenseUrl }, ctx) => {
          if (!agree)
            throw new PluginFailure(
              'E_PLUGIN_NOT_APPROVED',
              'model terms must be accepted before relighting',
              'show the licences from ic-light__doctor and the base checkpoint publisher’s terms, then ask the user to agree',
            );
          const { c, report } = await inspect(ctx);
          if (!report.configured)
            throw new PluginFailure(
              'E_PLUGIN_FAILED',
              'IC-Light is not configured',
              report.problems.join(' ').slice(0, 1500),
            );
          await mkdir(c.dataDir, { recursive: true });
          const a: Acceptance = { key: c.key, at: new Date().toISOString(), checkpointLicenseUrl };
          await writeFile(join(c.dataDir, 'acceptance.json'), JSON.stringify(a, null, 2));
          return {
            ok: true,
            checkpoint: c.checkpoint,
            icLightModel: c.icLightModel,
            checkpointLicenseUrl,
            next: 'Call ic-light__preview on one source frame to judge appearance before attempting an experimental video render.',
          };
        },
      }),
      preview: defineTool({
        description:
          'Relight one picture or one video frame using local IC-Light. Returns the preview image and its persistent PNG path. Run doctor/setup first; inspect the image for changes to identity, text or scene details before video rendering.',
        input: {
          source: sourceInput,
          atMs: z
            .number()
            .int()
            .nonnegative()
            .default(0)
            .describe('Frame position in integer source milliseconds; pictures use 0.'),
          ...lightInput,
        },
        handler: async ({ source, atMs, maxSide, ...lighting }, ctx) => {
          const c = await ready(ctx);
          const media = await probe(source, c.ffprobe!, ctx.signal);
          if (media.durationMs !== null ? atMs >= media.durationMs : atMs !== 0)
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              'the preview time is outside the source',
              'use atMs:0 for a picture, or a source millisecond within the video duration',
            );
          const size = processingSize(media.width, media.height, maxSide);
          return work(c, ctx, async (dir, progress) => {
            const original = join(dir, 'original.png');
            const file = join(dir, 'preview.png');
            progress(0.05, 'extracting the source frame');
            await run(
              c.ffmpeg!,
              [
                '-v',
                'error',
                '-nostdin',
                '-ss',
                String(atMs / 1000),
                '-i',
                source,
                '-vf',
                `scale=${size.width}:${size.height}:flags=lanczos`,
                '-frames:v',
                '1',
                original,
              ],
              ctx.signal,
            );
            const bytes = await c.comfy.render(
              await readFile(original),
              {
                ...lighting,
                ...size,
                checkpoint: c.checkpoint,
                icLightModel: c.icLightModel,
                prefix: `nodcut-ic-light/${randomUUID()}`,
              },
              ctx,
              c.timeoutMs,
              () => progress(0.2, 'relighting the preview frame'),
            );
            await writeFile(file, bytes);
            const result = {
              file,
              original,
              source,
              atMs,
              ...size,
              lighting,
              checkpoint: c.checkpoint,
              icLightModel: c.icLightModel,
              notice:
                'This is generative image relighting. Appearance may change. Independent video frames can flicker.',
            };
            await writeFile(join(dir, 'provenance.json'), JSON.stringify(result, null, 2));
            progress(1, 'preview ready');
            return new ToolContent(
              [
                {
                  type: 'text',
                  text: `Relit frame: ${file}. Compare it with the original before video rendering.`,
                },
                imageBlock(bytes, 'image/png'),
              ],
              result,
            );
          });
        },
      }),
      render: defineTool({
        description:
          'Experimental video relighting: processes every frame independently with a fixed seed, then encodes an MP4 with the source audio. This can be slow and can flicker/change appearance. Preview first. Default maximum is 10 seconds. Returns a persistent file; add_media or import_media then add_segment imports it as separate footage, or add_layer shows it over narration. It does not replace existing transcript-linked source media.',
        input: {
          source: sourceInput,
          startMs: z
            .number()
            .int()
            .nonnegative()
            .default(0)
            .describe('Range start in integer source milliseconds, default 0.'),
          endMs: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              'Exclusive range end in integer source milliseconds; omitted means the source end, subject to Maximum video seconds.',
            ),
          ...lightInput,
        },
        handler: async ({ source, startMs, endMs, maxSide, ...lighting }, ctx) => {
          const c = await ready(ctx);
          const media = await probe(source, c.ffprobe!, ctx.signal);
          const selected = range(media, startMs, endMs, c.maxSeconds);
          const size = processingSize(media.width, media.height, maxSide);
          return work(c, ctx, async (dir, progress) => {
            const input = join(dir, 'input');
            const output = join(dir, 'frames');
            await mkdir(input);
            await mkdir(output);
            const seconds = String(selected.durationMs / 1000);
            progress(0.01, 'extracting video frames');
            await run(
              c.ffmpeg!,
              [
                '-v',
                'error',
                '-nostdin',
                '-ss',
                String(startMs / 1000),
                '-i',
                source,
                '-t',
                seconds,
                '-vf',
                `fps=${media.fps},scale=${size.width}:${size.height}:flags=lanczos`,
                '-start_number',
                '0',
                join(input, '%08d.png'),
              ],
              ctx.signal,
            );
            const frames = (await readdir(input)).filter((f) => /^\d{8}\.png$/.test(f)).sort();
            if (!frames.length)
              throw new PluginFailure(
                'E_PLUGIN_FAILED',
                'the selected range contains no decoded frames',
                'choose a range of at least one source frame',
              );
            for (let i = 0; i < frames.length; i++) {
              const beat = () =>
                progress(0.05 + (0.85 * i) / frames.length, `relighting frame ${i + 1} of ${frames.length}`);
              const bytes = await c.comfy.render(
                await readFile(join(input, frames[i])),
                {
                  ...lighting,
                  ...size,
                  checkpoint: c.checkpoint,
                  icLightModel: c.icLightModel,
                  prefix: `nodcut-ic-light/${randomUUID()}`,
                },
                ctx,
                c.timeoutMs,
                beat,
              );
              await writeFile(join(output, frames[i]), bytes);
            }
            const file = join(dir, 'relit.mp4');
            progress(0.92, 'encoding video with the source audio');
            await run(
              c.ffmpeg!,
              [
                '-v',
                'error',
                '-nostdin',
                '-framerate',
                String(media.fps),
                '-start_number',
                '0',
                '-i',
                join(output, '%08d.png'),
                '-ss',
                String(startMs / 1000),
                '-i',
                source,
                '-map',
                '0:v:0',
                '-map',
                '1:a:0?',
                '-vf',
                `scale=${media.width}:${media.height}:flags=lanczos,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
                '-c:v',
                'libx264',
                '-preset',
                'fast',
                '-crf',
                '18',
                '-pix_fmt',
                'yuv420p',
                '-c:a',
                'aac',
                '-b:a',
                '192k',
                '-t',
                seconds,
                '-movflags',
                '+faststart',
                file,
              ],
              ctx.signal,
            );
            const actual = await probe(file, c.ffprobe!, ctx.signal);
            const result = {
              file,
              source,
              range: selected,
              ...actual,
              frames: frames.length,
              processing: size,
              lighting: lighting as Lighting,
              checkpoint: c.checkpoint,
              icLightModel: c.icLightModel,
              audio: media.hasAudio
                ? 'Source’s first audio stream, encoded to AAC; no generated audio.'
                : 'No source audio.',
              timing:
                'Constant frame rate from the source average; odd source dimensions are padded to even pixels.',
              temporalConsistency: 'Independent frames; not guaranteed.',
              notice: VIDEO_NOTICE,
              next: 'Review the relit clip for flicker and appearance changes. Add it as separate media, or as a video layer over the original narration. Existing source words, cuts and captions are not rebound to this file.',
            };
            await writeFile(join(dir, 'provenance.json'), JSON.stringify(result, null, 2));
            await rm(input, { recursive: true });
            await rm(output, { recursive: true });
            progress(1, 'experimental relit clip ready');
            return result;
          });
        },
      }),
    },
  };
}

export const definition = makeDefinition();
