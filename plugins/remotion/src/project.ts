/**
 * The user's own Remotion project: where it is, whether the Remotion packages are installed in
 * it, at which version. Remotion is never part of this plugin: it is resolved from the project
 * folder only (createRequire on its package.json), so what runs is what the user installed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { PluginFailure } from '@cutpilot/plugin-sdk';

/** The packages a render needs; Remotion requires all of them at the same version. */
export const REMOTION_PACKAGES = ['remotion', '@remotion/renderer', '@remotion/bundler'] as const;
export type RemotionPackage = (typeof REMOTION_PACKAGES)[number];

/** Remotion 4 only (5 will change the APIs this plugin calls), and 4.0.409 or later: licenseKey. */
export const SUPPORTED_MAJOR = 4;
export const MIN_VERSION = '4.0.409';

const SETTINGS_FIX = 'set "Remotion project folder" in CutPilot → Plugins → Remotion';

/** A require() that resolves from the user's project, never from this plugin. */
export const projectRequire = (projectDir: string) => createRequire(join(projectDir, 'package.json'));

/** The folder of a package as installed for the project, or null when it isn't. */
export function packageDir(projectDir: string, name: string): string | null {
  const req = projectRequire(projectDir);
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    /* no "./package.json" export, or not installed: find the entry, then its package.json */
  }
  let dir: string;
  try {
    dir = dirname(req.resolve(name));
  } catch {
    return null;
  }
  for (;;) {
    const f = join(dir, 'package.json');
    if (existsSync(f)) {
      try {
        if ((JSON.parse(readFileSync(f, 'utf8')) as { name?: string }).name === name) return dir;
      } catch {
        /* keep looking */
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

export function packageVersion(projectDir: string, name: string): string | null {
  const dir = packageDir(projectDir, name);
  if (!dir) return null;
  try {
    return (
      (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null
    );
  } catch {
    return null;
  }
}

const parse = (v: string) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const below = (a: number[], b: number[]) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
};

/**
 * What's wrong with these installed versions, or null: a package missing, versions that differ
 * (Remotion requires one version of all its packages), or a version this plugin doesn't support.
 */
export function versionProblem(versions: Record<RemotionPackage, string | null>): PluginFailure | null {
  const missing = REMOTION_PACKAGES.filter((p) => !versions[p]);
  if (missing.length) {
    const want = versions.remotion ?? 'latest';
    return new PluginFailure(
      'E_REMOTION_NOT_INSTALLED',
      `${missing.join(', ')} ${missing.length === 1 ? "isn't" : "aren't"} installed in the Remotion project`,
      `in the project folder run: npm i && npm i --save-exact ${missing.map((p) => `${p}@${want}`).join(' ')}`,
    );
  }
  const distinct = [...new Set(REMOTION_PACKAGES.map((p) => versions[p]!))];
  if (distinct.length > 1) {
    const newest = distinct
      .map((v) => [v, parse(v)] as const)
      .sort((a, b) => (below(a[1] ?? [0], b[1] ?? [0]) ? 1 : -1))[0]![0];
    return new PluginFailure(
      'E_REMOTION_VERSION_MISMATCH',
      `the Remotion packages differ in version (${REMOTION_PACKAGES.map((p) => `${p} ${versions[p]}`).join(', ')}); Remotion needs them all the same`,
      `in the project folder run: npm i --save-exact ${REMOTION_PACKAGES.map((p) => `${p}@${newest}`).join(' ')} (and the same for any other @remotion/* package)`,
    );
  }
  const v = distinct[0]!;
  const p = parse(v);
  if (!p || p[0] !== SUPPORTED_MAJOR || below(p, parse(MIN_VERSION)!))
    return new PluginFailure(
      'E_REMOTION_UNSUPPORTED_VERSION',
      `Remotion ${v} is installed; this plugin works with Remotion ${SUPPORTED_MAJOR}, version ${MIN_VERSION} or later`,
      p && p[0] > SUPPORTED_MAJOR
        ? `use Remotion ${SUPPORTED_MAJOR} in this project, or update the Remotion plugin when it supports Remotion ${p[0]}`
        : `in the project folder run: npx remotion upgrade (or npm i --save-exact ${REMOTION_PACKAGES.map((x) => `${x}@^${SUPPORTED_MAJOR}`).join(' ')})`,
    );
  return null;
}

export interface Project {
  dir: string;
  version: string;
  versions: Record<RemotionPackage, string | null>;
}

/** The project folder setting, checked; a PluginFailure that says what to do when it's unusable. */
export function linkedDir(setting: unknown): string {
  const dir = typeof setting === 'string' ? setting.trim() : '';
  if (!dir)
    throw new PluginFailure(
      'E_REMOTION_NOT_LINKED',
      'no Remotion project is linked',
      `${SETTINGS_FIX}; to make a new one, call remotion__create_project with a folder the user chose`,
    );
  if (!isAbsolute(dir))
    throw new PluginFailure(
      'E_REMOTION_NOT_LINKED',
      `the project folder ${dir} is not an absolute path`,
      SETTINGS_FIX,
    );
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new PluginFailure('E_REMOTION_NO_PROJECT', `the project folder ${dir} doesn't exist`, SETTINGS_FIX);
  return dir;
}

export function installedVersions(dir: string): Record<RemotionPackage, string | null> {
  return Object.fromEntries(REMOTION_PACKAGES.map((p) => [p, packageVersion(dir, p)])) as Record<
    RemotionPackage,
    string | null
  >;
}

/** The linked project, ready to render with, or the first thing that stops it. */
export function openProject(setting: unknown): Project {
  const dir = linkedDir(setting);
  if (!existsSync(join(dir, 'package.json')))
    throw new PluginFailure(
      'E_REMOTION_NO_PROJECT',
      `${dir} has no package.json, so it isn't a Remotion project`,
      `${SETTINGS_FIX} to a Remotion project, or make one with remotion__create_project`,
    );
  const versions = installedVersions(dir);
  const problem = versionProblem(versions);
  if (problem) throw problem;
  return { dir, version: versions.remotion!, versions };
}
