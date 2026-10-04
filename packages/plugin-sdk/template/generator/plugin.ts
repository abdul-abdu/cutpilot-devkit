// A generator: clips made from templates (a title card, a chapter heading, an end card).
// NodCut asks for a clip at its timeline's size, frame rate and length, and puts the MP4 it
// gets back into the edit as an insert.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findOnPath, PluginFailure, z, type PluginDefinition } from '@nodcut/plugin-sdk';

const run = promisify(execFile);

/** The parameters of the one template here; list_templates sends them as JSON Schema. */
const ColorCardParams = z.object({
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #1e293b')
    .default('#1e293b')
    .describe('the background colour'),
});

export const TEMPLATES = [
  {
    id: 'color-card',
    name: 'Colour card',
    description: 'A plain card in one colour: a pause between two parts of a video.',
    params: z.toJSONSchema(ColorCardParams, { io: 'input' }) as Record<string, unknown>,
    example: { color: '#1e293b' },
    defaultDurationMs: 2000,
    maxDurationMs: 10_000,
    aspects: [],
  },
];

export const plugin: PluginDefinition = {
  listTemplates: () => ({ templates: TEMPLATES }),
  generate: async ({ template, params, width, height, fps, durationMs }, ctx) => {
    if (template !== 'color-card')
      throw new PluginFailure('E_PLUGIN_BAD_INPUT', `no template ${template}`, 'use one from list_templates');
    const p = ColorCardParams.safeParse(params);
    if (!p.success)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        z.prettifyError(p.error).replace(/\n/g, ' '),
        'fix the params',
      );
    // Replace this with your own renderer. The placeholder uses ffmpeg, which must be on PATH.
    const ffmpeg = findOnPath('ffmpeg');
    if (!ffmpeg)
      throw new PluginFailure(
        'E_PLUGIN_FAILED',
        'ffmpeg is not installed',
        'install ffmpeg so it is on PATH',
      );
    const ms = durationMs ?? TEMPLATES[0]!.defaultDurationMs;
    const file = join(tmpdir(), `${template}-${randomUUID()}.mp4`);
    const color = `0x${p.data.color.slice(1)}`;
    await run(
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=${width}x${height}:r=${fps}:d=${ms / 1000}`,
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        file,
      ],
      { signal: ctx.signal },
    );
    return { file, durationMs: ms, width, height, hasAudio: false };
  },
};
