/**
 * Scenes in the user's Remotion project: one file per scene in `src/nodcut/<id>.tsx` (the
 * agent's code, which default-exports the component, then a metadata block this plugin writes),
 * and `src/nodcut/index.tsx`, which this plugin owns and rewrites from the scene files: it
 * registers each scene as `<Composition id="nodcut-<id>" …/>`. Nothing else in the project
 * is written here.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { PluginFailure } from '@nodcut/plugin-sdk';
import { z } from 'zod';

/** What the spec allows in a file name: no dots, no slashes, so no way out of src/nodcut. */
export const SCENE_ID_RE = /^[a-z0-9-]{1,64}$/;
/**
 * A scene is also a template of this generator (add_insert takes its id), and template ids are
 * kebab-case, start with a letter and are at most 40 characters (`TemplateIdSchema`).
 */
const TEMPLATE_ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const TEMPLATE_ID_MAX = 40;

export const COMPOSITION_PREFIX = 'nodcut-';
export const compositionId = (sceneId: string) => `${COMPOSITION_PREFIX}${sceneId}`;

/** The scene id, or a PluginFailure that says what an id looks like. */
export function checkSceneId(id: unknown): string {
  const fix = 'use lowercase letters, digits and single hyphens, starting with a letter, e.g. "promo-intro"';
  if (typeof id !== 'string' || !SCENE_ID_RE.test(id))
    throw new PluginFailure('E_REMOTION_BAD_SCENE_ID', `${JSON.stringify(id)} is not a scene id`, fix);
  if (id === 'index')
    throw new PluginFailure('E_REMOTION_BAD_SCENE_ID', '"index" is the file that registers the scenes', fix);
  if (id.length > TEMPLATE_ID_MAX || !TEMPLATE_ID_RE.test(id))
    throw new PluginFailure(
      'E_REMOTION_BAD_SCENE_ID',
      `${JSON.stringify(id)} can't be a template id (kebab-case, starts with a letter, at most ${TEMPLATE_ID_MAX} characters)`,
      fix,
    );
  return id;
}

export const scenesDir = (projectDir: string) => join(projectDir, 'src', 'nodcut');

/** The scene's file, checked to be inside src/nodcut (an id that passed checkSceneId always is). */
export function sceneFile(projectDir: string, id: string): string {
  const dir = resolve(scenesDir(projectDir));
  const file = resolve(dir, `${checkSceneId(id)}.tsx`);
  if (!file.startsWith(dir + sep))
    throw new PluginFailure('E_REMOTION_BAD_SCENE_ID', `${id} leads out of src/nodcut`, 'use a plain id');
  return file;
}

export const SceneMetaSchema = z.object({
  durationInFrames: z.number().int().min(1).max(108_000),
  fps: z.number().positive().max(120),
  width: z
    .number()
    .int()
    .min(16)
    .max(7680)
    .refine((n) => n % 2 === 0, 'sizes are even numbers of pixels'),
  height: z
    .number()
    .int()
    .min(16)
    .max(7680)
    .refine((n) => n % 2 === 0, 'sizes are even numbers of pixels'),
  defaultProps: z.record(z.string(), z.unknown()).default({}),
});
export type SceneMeta = z.infer<typeof SceneMetaSchema>;

export interface Scene {
  id: string;
  file: string;
  code: string;
  meta: SceneMeta;
}

const META_MARKER =
  '// ── NodCut scene metadata: written by the Remotion plugin; change it with remotion__update_scene ──';
const META_RE = new RegExp(
  `\\n?${META_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nexport const nodcutScene = (.*);\\n?$`,
);

/** Why the agent's code can't be a scene file, or null. */
export function codeProblem(code: string): string | null {
  if (!code.trim()) return 'the code is empty';
  if (!/\bexport\s+default\b/.test(code))
    return 'the code must `export default` the scene component (e.g. export default function Scene(props) {…})';
  if (/\bnodcutScene\b/.test(code) || code.includes(META_MARKER))
    return 'leave out nodcutScene: the plugin writes the scene metadata itself from durationInFrames, fps, width, height and defaultProps';
  return null;
}

/** The text of a scene file: the agent's code, then the metadata block. */
export function sceneSource(code: string, meta: SceneMeta): string {
  return `${code.replace(/\s+$/, '')}\n\n${META_MARKER}\nexport const nodcutScene = ${JSON.stringify(meta)};\n`;
}

/** The agent's code and the metadata of a scene file, or null when it isn't one of ours. */
export function parseSceneSource(text: string): { code: string; meta: SceneMeta } | null {
  const m = META_RE.exec(text);
  if (!m) return null;
  let json: unknown;
  try {
    json = JSON.parse(m[1]!);
  } catch {
    return null;
  }
  const meta = SceneMetaSchema.safeParse(json);
  if (!meta.success) return null;
  return { code: text.slice(0, m.index).replace(/\s+$/, '') + '\n', meta: meta.data };
}

/** The scenes in src/nodcut, by id; files that aren't scene files are left alone and skipped. */
export function listScenes(projectDir: string): Scene[] {
  const dir = scenesDir(projectDir);
  if (!existsSync(dir)) return [];
  const out: Scene[] = [];
  for (const name of readdirSync(dir).sort()) {
    const m = /^(.+)\.tsx$/.exec(name);
    if (!m || m[1] === 'index' || !SCENE_ID_RE.test(m[1]!)) continue;
    const file = join(dir, name);
    const parsed = parseSceneSource(readFileSync(file, 'utf8'));
    if (parsed) out.push({ id: m[1]!, file, ...parsed });
  }
  return out;
}

export function readScene(projectDir: string, id: string): Scene | null {
  const file = sceneFile(projectDir, id);
  if (!existsSync(file)) return null;
  const parsed = parseSceneSource(readFileSync(file, 'utf8'));
  return parsed ? { id, file, ...parsed } : null;
}

/** A JS identifier for a scene id (`promo-intro` → `promo_intro`), unique among the ids given. */
const ident = (id: string, i: number) => `S${i}_${id.replace(/-/g, '_')}`;

export const INDEX_HEADER = `// Written by the NodCut Remotion plugin, and rewritten whenever a scene changes: don't edit it.
// Each file next to it is a scene; this registers them as compositions named nodcut-<scene id>.`;

/** src/nodcut/index.tsx for these scene ids (sorted, so the file only changes when they do). */
export function indexSource(ids: readonly string[]): string {
  const sorted = [...ids].sort();
  if (!sorted.length) return `${INDEX_HEADER}\n\nexport const NodCutCompositions = () => null;\n`;
  const imports = sorted.map(
    (id, i) => `import ${ident(id, i)}, { nodcutScene as ${ident(id, i)}_meta } from './${id}';`,
  );
  const comps = sorted.map((id, i) => {
    const s = ident(id, i);
    return [
      '    <Composition',
      `      id="${compositionId(id)}"`,
      `      component={${s} as unknown as ComponentType<Props>}`,
      `      durationInFrames={${s}_meta.durationInFrames}`,
      `      fps={${s}_meta.fps}`,
      `      width={${s}_meta.width}`,
      `      height={${s}_meta.height}`,
      `      defaultProps={${s}_meta.defaultProps as Props}`,
      '    />',
    ].join('\n');
  });
  return `${INDEX_HEADER}

import type { ComponentType } from 'react';
import { Composition } from 'remotion';
${imports.join('\n')}

type Props = Record<string, unknown>;

export const NodCutCompositions = () => (
  <>
${comps.join('\n')}
  </>
);
`;
}

/** Write a file through a temporary name, so a bundler watching src/ never sees half of it. */
export function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.nodcut-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Rewrite index.tsx from the scene files there now; returns its path. Unchanged text isn't rewritten. */
export function writeIndex(projectDir: string): string {
  const dir = scenesDir(projectDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'index.tsx');
  const text = indexSource(listScenes(projectDir).map((s) => s.id));
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) writeAtomic(file, text);
  return file;
}

export function writeScene(projectDir: string, id: string, code: string, meta: SceneMeta): string {
  const file = sceneFile(projectDir, id);
  mkdirSync(scenesDir(projectDir), { recursive: true });
  writeAtomic(file, sceneSource(code, meta));
  writeIndex(projectDir);
  return file;
}

export function deleteScene(projectDir: string, id: string): boolean {
  const file = sceneFile(projectDir, id);
  if (!existsSync(file)) return false;
  rmSync(file);
  writeIndex(projectDir);
  return true;
}

/**
 * A JSON Schema for a scene's props, made from its defaultProps (the template's `params` in
 * list_templates): each prop optional, typed like its default.
 */
export function propsSchema(defaults: Record<string, unknown>): Record<string, unknown> {
  const of = (v: unknown): Record<string, unknown> => {
    if (typeof v === 'string') return { type: 'string', default: v };
    if (typeof v === 'number') return { type: 'number', default: v };
    if (typeof v === 'boolean') return { type: 'boolean', default: v };
    if (Array.isArray(v)) return { type: 'array', default: v };
    if (v && typeof v === 'object') return { type: 'object', default: v };
    return {};
  };
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(defaults).map(([k, v]) => [k, of(v)])),
    additionalProperties: true,
  };
}
