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

/** Where Node lives when a GUI app's PATH doesn't say (Homebrew, the installer, nvm/volta shims). */
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

const NO_NODE = () =>
  new PluginFailure(
    'E_REMOTION_NO_NODE',
    "Node.js (with npm and npx) isn't installed, and creating a Remotion project needs it",
    'install Node.js 20 or later from nodejs.org (macOS: brew install node), then try again',
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

function run(
  bin: string,
  args: string[],
  cwd: string,
  ctx: Pick<PluginContext, 'progress' | 'log' | 'signal'>,
  from: number,
  to: number,
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
    const take = (chunk: Buffer) => {
      // eslint-disable-next-line no-control-regex -- strip ANSI colours
      const text = chunk.toString().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      for (const l of text.split(/\r?\n|\r/)) {
        if (!l.trim()) continue;
        lines.push(l);
        if (lines.length > 200) lines.shift();
        ctx.log(l);
        n++;
        ctx.progress(from + (to - from) * (1 - 1 / (1 + n / 20)), l.trim().slice(0, 100));
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(lines)
        : reject(
            new PluginFailure(
              'E_REMOTION_CREATE_FAILED',
              `${basename(bin)} ${args.join(' ')} failed (exit ${code}): ${lines.slice(-6).join(' | ')}`,
              'check the internet connection and that the folder is writable, then try again',
            ),
          ),
    );
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
  const npx = findOnPath('npx');
  const npm = findOnPath('npm');
  if (!npx || !npm) throw NO_NODE();

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
