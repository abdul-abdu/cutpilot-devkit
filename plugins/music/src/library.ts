/** The library on disk: `library.json` and the audio files next to it. */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginFailure } from '@nodcut/plugin-sdk';
import { z } from 'zod';
import type { Track } from './picker.js';

/** The library shipped with the plugin: `library/` next to `dist/`. */
export const LIBRARY_DIR = fileURLToPath(new URL('../library/', import.meta.url));

const TrackSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'ids are kebab-case'),
  title: z.string().min(1).max(200),
  moods: z.array(z.string().min(1)).default([]),
  bpm: z.number().positive().optional(),
  durationMs: z.number().int().positive(),
  loopable: z.boolean().default(false),
  license: z.string().min(1),
  attribution: z.string().min(1).optional(),
  file: z
    .string()
    .min(1)
    .refine((f) => !isAbsolute(f) && !normalize(f).split(sep).includes('..'), 'files are inside the library'),
});

export const LibrarySchema = z.object({
  tracks: z.array(TrackSchema).superRefine((ts, ctx) => {
    const seen = new Set<string>();
    ts.forEach((t, i) => {
      if (seen.has(t.id))
        ctx.addIssue({ code: 'custom', message: `${t.id} is listed twice`, path: [i, 'id'] });
      seen.add(t.id);
    });
  }),
});

export interface Library {
  dir: string;
  tracks: Track[];
}

const broken = (dir: string, why: string) =>
  new PluginFailure(
    'E_MUSIC_LIBRARY',
    `the music library in ${dir} can't be read: ${why}`,
    'reinstall the Music plugin from NodCut → Plugins',
  );

export function loadLibrary(dir: string = LIBRARY_DIR): Library {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8'));
  } catch (e) {
    throw broken(dir, (e as Error).message.split('\n')[0]!);
  }
  const r = LibrarySchema.safeParse(json);
  if (!r.success)
    throw broken(dir, r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return { dir, tracks: r.data.tracks };
}

/** The absolute path of a track's audio, which must exist. */
export function trackFile(lib: Library, t: Track): string {
  const file = join(lib.dir, t.file);
  if (!existsSync(file))
    throw new PluginFailure(
      'E_MUSIC_FILE_MISSING',
      `the audio of "${t.title}" (${t.file}) is missing from the library`,
      'pick another track with find_music, or reinstall the Music plugin from NodCut → Plugins',
    );
  return file;
}
