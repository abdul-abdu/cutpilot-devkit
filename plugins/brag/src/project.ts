/**
 * A brag project: a folder the AI writes into through the plugin (its client may have no file
 * access of its own). Everything it writes or copies stays inside that folder:
 *
 *   <name>-<YYYY-MM-DD-HHmmss>/
 *     brag-plan.md, share-copy.txt, …   what the AI writes
 *     composition/index.html            the HyperFrames composition (a starter at first)
 *     composition/vendor/gsap.min.js
 *     composition/assets/…              logo, screenshots, footage, music, sound effects
 *     snapshots/                        stills from snapshot
 *     brag.mp4, brag.jpg                from render
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginFailure } from '@cutpilot/plugin-sdk';

export const MARKER = '.brag-project';

/** Where projects go: the setting, else ~/Movies/Brag on a Mac and ~/Videos/Brag elsewhere. */
export function projectsRoot(setting: string | undefined, home = homedir()): string {
  if (setting?.trim()) return resolve(setting.trim());
  return join(home, process.platform === 'darwin' ? 'Movies' : 'Videos', 'Brag');
}

export const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'brag';

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export function newProjectDir(root: string, name: string, now = new Date()): string {
  let dir = join(root, `${slug(name)}-${stamp(now)}`);
  for (let i = 2; existsSync(dir); i++) dir = join(root, `${slug(name)}-${stamp(now)}-${i}`);
  return dir;
}

/** A project folder start_project made, or a failure that says to make one. */
export function projectDir(path: string): string {
  const dir = resolve(path);
  if (!existsSync(join(dir, MARKER)))
    throw new PluginFailure(
      'E_BRAG_NO_PROJECT',
      `${dir} is not a brag project`,
      'call start_project first and pass the folder it returns as project',
    );
  return realpathSync(dir);
}

/** A path inside the project, refusing anything that leaves it. */
export function inside(project: string, rel: string): string {
  const bad = () =>
    new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${JSON.stringify(rel)} is not a path inside the project`,
      'pass a relative path like composition/index.html or brag-plan.md',
    );
  if (!rel.trim() || isAbsolute(rel) || rel.includes('\0')) throw bad();
  const full = resolve(project, rel);
  const r = relative(project, full);
  if (!r || r.startsWith('..') || isAbsolute(r) || r.split(sep).includes(MARKER)) throw bad();
  // a symlinked folder inside the project could still point out of it
  let existing = dirname(full);
  while (!existsSync(existing)) existing = dirname(existing);
  const real = realpathSync(existing);
  if (real !== project && !real.startsWith(project + sep)) throw bad();
  return full;
}

export function writeText(project: string, rel: string, content: string): string {
  const full = inside(project, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

/** Copy a file into composition/assets/ (or a subfolder of it); returns the src to use in HTML. */
export function copyAsset(
  project: string,
  from: string,
  as?: string,
): { src: string; path: string; bytes: number } {
  if (!isAbsolute(from) || !existsSync(from) || !statSync(from).isFile())
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `there is no file at ${from}`,
      'pass the absolute path of an existing file (a logo, screenshot, video clip, font or audio file)',
    );
  const name = as?.trim() || from.split(/[\\/]/).pop()!;
  const assets = join(project, 'composition', 'assets');
  const to = inside(project, relative(project, resolve(assets, name)));
  if (!to.startsWith(assets + sep))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `"${name}" is not a name inside composition/assets/`,
      'pass a name like logo.svg or sfx/reveal.ogg',
    );
  if (!extname(to))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `"${name}" has no extension`,
      'name the asset with its extension, e.g. logo.svg or music.mp3',
    );
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  return {
    src: relative(join(project, 'composition'), to).split(sep).join('/'),
    path: to,
    bytes: statSync(to).size,
  };
}

// ── bundled sound effects ────────────────────────────────────────────────────

export interface Sound {
  file: string;
  family: string;
  durationMs: number;
  brightness: 'warm' | 'balanced' | 'bright';
  highFrequencyRisk: 'low' | 'medium' | 'high';
  envelope: string;
  uses: string[];
}

export const soundsDir = (): string => join(dirname(fileURLToPath(import.meta.url)), '..', 'sounds');

let sounds: Sound[] | undefined;
export function allSounds(): Sound[] {
  sounds ??= (JSON.parse(readFileSync(join(soundsDir(), 'index.json'), 'utf8')) as { sounds: Sound[] })
    .sounds;
  return sounds;
}

export const RISKS = ['low', 'medium', 'high'] as const;

export function findSounds(q: { use?: string; family?: string; maxRisk?: (typeof RISKS)[number] }): Sound[] {
  const max = RISKS.indexOf(q.maxRisk ?? 'high');
  const use = q.use?.trim().toLowerCase();
  return allSounds().filter(
    (s) =>
      RISKS.indexOf(s.highFrequencyRisk) <= max &&
      (!q.family || s.family === q.family) &&
      (!use || s.uses.some((u) => u.includes(use))),
  );
}

export function soundPath(file: string): string {
  const s = allSounds().find((x) => x.file === file);
  if (!s)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `there is no bundled sound ${JSON.stringify(file)}`,
      'pass a file exactly as list_sounds gives it, e.g. impact/impactSoft_medium_001.ogg',
    );
  return join(soundsDir(), s.file);
}
