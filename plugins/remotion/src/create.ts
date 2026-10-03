/**
 * "Create a Remotion project": Remotion's own scaffolder (`npx create-video --yes --blank`), then
 * `npm i` and the two packages a render needs (@remotion/renderer and @remotion/bundler at the
 * project's Remotion version). It runs on the user's machine with the user's own Node and npm, so
 * Remotion is installed from npm by the user, under their own name and licence.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { PluginFailure, type PluginContext } from '@cutpilot/plugin-sdk';
import { installedVersions } from './project.js';

/** Where Node lives when a GUI app's PATH doesn't say: Homebrew, the nodejs.org installer, the system. */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.HOME ?? '';
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    ...EXTRA_DIRS,
    ...(home ? [join(home, '.volta', 'bin'), join(home, '.local', 'bin')] : []),
  ];
  const names = process.platform === 'win32' ? [`${name}.cmd`, `${name}.exe`, name] : [name];
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/** `v24.2.0` / `24.2.0` / `node-v20.1.0` → [24, 2, 0]; anything else sorts last. */
function versionOf(name: string): number[] {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [-1, -1, -1];
}

/** `<root>/<version>/<sub>` for every version installed under root, newest first. */
function versions(root: string, sub: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const newer = (a: string, b: string) => {
    const [x, y] = [versionOf(a), versionOf(b)];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return y[i]! - x[i]!;
    return 0;
  };
  return names.sort(newer).map((n) => join(root, n, sub));
}

/**
 * The folders that may hold the user's Node, in the order they are tried: the PATH the plugin
 * was started with, the fixed places, then version managers. An app opened from the Dock or
 * Finder doesn't run the user's shell profile, so a Node from nvm, fnm, Volta, asdf or mise is
 * on no PATH it sees; their install folders are searched instead, newest version first.
 */
export function nodeDirs(
  env: NodeJS.ProcessEnv = process.env,
  fixed: readonly string[] = EXTRA_DIRS,
): string[] {
  const home = env.HOME ?? '';
  const at = (...p: string[]) => join(home, ...p);
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...fixed];
  if (env.NVM_BIN) dirs.push(env.NVM_BIN);
  if (env.VOLTA_HOME) dirs.push(join(env.VOLTA_HOME, 'bin'));
  if (env.NVM_DIR) dirs.push(...versions(join(env.NVM_DIR, 'versions', 'node'), 'bin'));
  if (home)
    dirs.push(
      ...versions(at('.nvm', 'versions', 'node'), 'bin'),
      at('.volta', 'bin'),
      ...versions(at('Library', 'Application Support', 'fnm', 'node-versions'), join('installation', 'bin')),
      ...versions(at('.local', 'share', 'fnm', 'node-versions'), join('installation', 'bin')),
      ...versions(at('.fnm', 'node-versions'), join('installation', 'bin')),
      ...versions(at('.local', 'share', 'mise', 'installs', 'node'), 'bin'),
      ...versions(at('.asdf', 'installs', 'nodejs'), 'bin'),
      at('.asdf', 'shims'),
      at('.local', 'bin'),
    );
  return [...new Set(dirs)];
}

/**
 * The user's Node: one folder with node, npm and npx together. npm and npx are scripts that
 * start with `#!/usr/bin/env node`, and `run` puts their folder first on PATH, so the node next
 * to them is the one that runs them; an npx from one install with a node from another is not
 * picked. Null when no folder has all three.
 */
export function findNode(
  env: NodeJS.ProcessEnv = process.env,
  fixed: readonly string[] = EXTRA_DIRS,
): { node: string; npm: string; npx: string } | null {
  const win = process.platform === 'win32';
  const pick = (dir: string, name: string) =>
    (win ? [`${name}.cmd`, `${name}.exe`, name] : [name]).map((n) => join(dir, n)).find((f) => existsSync(f));
  for (const dir of nodeDirs(env, fixed)) {
    const node = pick(dir, 'node');
    const npm = pick(dir, 'npm');
    const npx = pick(dir, 'npx');
    if (node && npm && npx) return { node, npm, npx };
  }
  return null;
}

const NO_NODE = () =>
  new PluginFailure(
    'E_REMOTION_NO_NODE',
    "Node.js (with npm and npx) wasn't found, and creating a Remotion project needs it",
    'install Node.js 20 or later from nodejs.org (macOS: brew install node). A Node from nvm, fnm, Volta, asdf or mise is found in their usual folders; one installed elsewhere needs a link to node, npm and npx in ~/.local/bin',
  );

/** The command lines `create` runs, in order (exported for tests). */
export function createSteps(
  name: string,
): { cmd: 'npx' | 'npm'; args: string[]; where: 'parent' | 'project' }[] {
  return [
    {
      cmd: 'npx',
      args: ['--yes', 'create-video@latest', '--yes', '--blank', '--no-tailwind', name],
      where: 'parent',
    },
    { cmd: 'npm', args: ['install', '--no-audit', '--no-fund', '--loglevel=error'], where: 'project' },
  ];
}

/** How often a silent step still reports progress (AD1: npm install is quiet for minutes). */
export const BEAT_MS = 5000;

/**
 * Run one step with the user's npm or npx, reporting progress for each line it prints and, while
 * it prints nothing, every `beatMs`: CutPilot ends a plugin call after 120 s without progress,
 * and `npm install --loglevel=error` can be silent for minutes on a slow connection.
 */
export function run(
  bin: string,
  args: string[],
  cwd: string,
  ctx: Pick<PluginContext, 'progress' | 'log' | 'signal'>,
  from: number,
  to: number,
  beatMs = BEAT_MS,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, CI: '1', npm_config_yes: 'true' };
    // under the CutPilot app this process runs as Electron-as-Node; the user's npm must not
    delete env.ELECTRON_RUN_AS_NODE;
    const binDir = dirname(bin);
    env.PATH = [binDir, ...(env.PATH ?? '').split(delimiter)].filter(Boolean).join(delimiter);
    const child = spawn(bin, args, {
      cwd,
      env,
      signal: ctx.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
    const lines: string[] = [];
    let n = 0;
    const step =
      `${basename(bin).replace(/\.(cmd|exe)$/, '')} ${args.find((a) => !a.startsWith('-')) ?? ''}`.trim();
    const started = Date.now();
    let fraction = from;
    let message = `${step} is running`;
    const beat = setInterval(
      () => ctx.progress(fraction, `${message} (${Math.round((Date.now() - started) / 1000)} s)`),
      beatMs,
    );
    const done = () => clearInterval(beat);
    const take = (chunk: Buffer) => {
      // eslint-disable-next-line no-control-regex -- strip ANSI colours
      const text = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      for (const l of text.split(/\r?\n|\r/)) {
        if (!l.trim()) continue;
        lines.push(l);
        if (lines.length > 200) lines.shift();
        ctx.log(l);
        n++;
        fraction = from + (to - from) * (1 - 1 / (1 + n / 20));
        message = l.trim().slice(0, 100);
        ctx.progress(fraction, message);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => {
      done();
      reject(e);
    });
    child.on('close', (code) => {
      done();
      if (code === 0) return resolve(lines);
      reject(
        new PluginFailure(
          'E_REMOTION_CREATE_FAILED',
          `${basename(bin)} ${args.join(' ')} failed (exit ${code}): ${lines.slice(-6).join(' | ')}`,
          'check the internet connection and that the folder is writable, then try again',
        ),
      );
    });
  });
}

export interface Created {
  projectDir: string;
  version: string;
  log: string[];
}

/** Scaffold a blank Remotion project in `dir` (which must not exist yet, or be empty). */
export async function createProject(
  dir: string,
  ctx: Pick<PluginContext, 'progress' | 'log' | 'signal'>,
): Promise<Created> {
  if (!isAbsolute(dir))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${dir} is not an absolute path`,
      'pass the full path of the new folder',
    );
  const parent = dirname(dir);
  const name = basename(dir);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${name} can't be an npm project name`,
      'use a folder name of letters, digits, dots, hyphens and underscores, e.g. my-video',
    );
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${parent} doesn't exist`,
      'pick a folder inside one that exists',
    );
  if (existsSync(dir) && readdirSync(dir).length)
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `${dir} already exists and isn't empty`,
      'pick a new folder; to use an existing Remotion project, the user sets it as "Remotion project folder" instead',
    );
  const found = findNode();
  if (!found) throw NO_NODE();
  const { npx, npm } = found;

  const log: string[] = [];
  const [scaffold, install] = createSteps(name);
  log.push(...(await run(npx, scaffold!.args, parent, ctx, 0, 0.3)));
  log.push(...(await run(npm, install!.args, dir, ctx, 0.3, 0.8)));
  const version = installedVersions(dir).remotion;
  if (!version)
    throw new PluginFailure(
      'E_REMOTION_CREATE_FAILED',
      `the project in ${dir} was made, but remotion isn't installed in it`,
      `in ${dir} run: npm i`,
    );
  log.push(
    ...(await run(
      npm,
      [
        'install',
        '--save-exact',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
        `@remotion/renderer@${version}`,
        `@remotion/bundler@${version}`,
      ],
      dir,
      ctx,
      0.8,
      1,
    )),
  );
  ctx.progress(1, 'Remotion project ready');
  return { projectDir: dir, version, log: log.slice(-20) };
}
