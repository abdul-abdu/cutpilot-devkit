/**
 * The face helper: a small macOS program (helper/main.swift, Apple Vision) that prints face
 * boxes for frames sampled from the video as JSON lines. This finds it and runs it.
 */
import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginFailure } from '@cutpilot/plugin-sdk';
import { z } from 'zod';
import type { Range } from './follow.js';
import type { Sample } from './tracker.js';

/** The plugin folder (dist/.. at run time). */
export const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
/** Set to run another helper (tests use a stand-in written in Node). */
export const HELPER_ENV = 'CUTPILOT_FACE_HELPER';

/** The helper to run: $CUTPILOT_FACE_HELPER, else bin/face-helper on a Mac. */
export function helperPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  dir: string = PLUGIN_DIR,
): string {
  const override = env[HELPER_ENV];
  if (override) {
    if (!existsSync(override))
      throw new PluginFailure(
        'E_FACE_HELPER_MISSING',
        `${HELPER_ENV} names ${override}, which doesn't exist`,
        `point ${HELPER_ENV} at a face helper, or unset it`,
      );
    return override;
  }
  if (platform !== 'darwin')
    throw new PluginFailure(
      'E_FOLLOW_SPEAKER_UNSUPPORTED',
      `following the speaker works on macOS only (its face detection is Apple Vision); this is ${platform}`,
      'use a fixed crop instead (set_reframe without follow), or reframe on a Mac',
    );
  const file = join(dir, 'bin', 'face-helper');
  try {
    accessSync(file, constants.X_OK);
  } catch {
    throw new PluginFailure(
      'E_FACE_HELPER_MISSING',
      `the face helper isn't in the plugin (${file})`,
      'reinstall Follow the speaker from CutPilot → Plugins; when building from source, run helper/build.sh first',
    );
  }
  return file;
}

const FaceSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
  confidence: z.number().min(0).max(1).default(1),
});
const LineSchema = z.union([
  z.object({ t: z.number().int().nonnegative(), faces: z.array(FaceSchema) }),
  z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    durationMs: z.number().optional(),
  }),
]);

export interface Detected {
  /** the upright frame's width / height, when the helper said */
  sourceAspect?: number;
  samples: Sample[];
}

/** How many samples the helper will print for these ranges, for progress. */
export const expectedSamples = (ranges: readonly Range[], fps: number) =>
  ranges.reduce((n, r) => n + Math.max(1, Math.ceil(((r.end - r.start) * fps) / 1000)), 0);

/** Run the helper over the ranges; `onProgress` gets the share of samples done. */
export function detectFaces(
  helper: string,
  source: string,
  ranges: readonly Range[],
  fps: number,
  opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<Detected> {
  const args = [source, '--ranges', ranges.map((r) => `${r.start}-${r.end}`).join(','), '--fps', String(fps)];
  const expected = expectedSamples(ranges, fps);
  return new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Detected = { samples: [] };
    let stderr = '';
    let buffer = '';
    let bad: string | null = null;
    const abort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', abort, { once: true });

    const line = (text: string) => {
      if (!text.trim() || bad) return;
      let parsed: z.infer<typeof LineSchema>;
      try {
        parsed = LineSchema.parse(JSON.parse(text));
      } catch {
        bad = text.slice(0, 120);
        return;
      }
      if ('t' in parsed) {
        out.samples.push({ t: parsed.t, faces: parsed.faces });
        opts.onProgress?.(Math.min(1, out.samples.length / expected));
      } else out.sourceAspect = parsed.width / parsed.height;
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      buffer += d;
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      lines.forEach(line);
    });
    child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on('error', (e) =>
      reject(
        new PluginFailure(
          'E_FACE_HELPER_FAILED',
          `the face helper couldn't start: ${e.message}`,
          'reinstall Follow the speaker from CutPilot → Plugins',
        ),
      ),
    );
    child.on('close', (code, signal) => {
      opts.signal?.removeEventListener('abort', abort);
      line(buffer);
      const tail = stderr.trim().split('\n').at(-1) ?? '';
      if (opts.signal?.aborted)
        return reject(
          new PluginFailure(
            'E_FOLLOW_CANCELLED',
            'following the speaker was cancelled',
            'ask again when you want it',
          ),
        );
      if (code !== 0)
        return reject(
          new PluginFailure(
            'E_FACE_HELPER_FAILED',
            `the face helper stopped (${signal ?? `exit ${code}`})${tail ? `: ${tail}` : ''}`,
            code === 3 || code === 4
              ? 'check that the source video plays; follow the speaker needs a video track macOS can decode'
              : 'try again; if it keeps failing, report it with the video format to the plugin publisher',
          ),
        );
      if (bad)
        return reject(
          new PluginFailure(
            'E_FACE_HELPER_FAILED',
            `the face helper printed a line this plugin can't read: ${bad}`,
            'reinstall Follow the speaker from CutPilot → Plugins',
          ),
        );
      resolve(out);
    });
  });
}
