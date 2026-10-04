/**
 * The HyperFrames CLI (an npm dependency of this plugin) and what it needs: a Chrome and ffmpeg
 * on this machine. The plugin declares no network, so it never lets the CLI download a browser:
 * it finds one and passes it as HYPERFRAMES_BROWSER_PATH, or tells the user what to install.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/**
 * The folder of an installed package. `hyperframes` is a CLI with no entry point to resolve, so
 * this tries the package.json export, then walks up from this file the way Node would.
 */
function packageDir(name: string): string {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    /* no "./package.json" export: look for it ourselves */
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return dirname(candidate);
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`can't find the ${name} package: is the plugin installed?`);
    dir = parent;
  }
}

export const cliDir = (): string => packageDir('hyperframes');
export const cliPath = (): string => join(cliDir(), 'bin/hyperframes.mjs');
export const cliVersion = (): string =>
  JSON.parse(readFileSync(join(cliDir(), 'package.json'), 'utf8')).version as string;
export const gsapPath = (): string => join(packageDir('gsap'), 'dist/gsap.min.js');

/** Where tools live when a GUI app's PATH doesn't say (Homebrew, /usr/local). */
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...EXTRA_DIRS];
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

const CHROME_APPS: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  win32: ['Google\\Chrome\\Application\\chrome.exe', 'Microsoft\\Edge\\Application\\msedge.exe'].flatMap(
    (rel) =>
      [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
        .filter((p): p is string => !!p)
        .map((p) => join(p, rel)),
  ),
};
const CHROME_NAMES = [
  'google-chrome',
  'google-chrome-stable',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

/** The browser to render with: the setting if given, else a well-known install. */
export function findChrome(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (setting?.trim()) return existsSync(setting.trim()) ? setting.trim() : null;
  for (const p of CHROME_APPS[process.platform] ?? []) if (existsSync(p)) return p;
  for (const n of CHROME_NAMES) {
    const p = findOnPath(n, env);
    if (p) return p;
  }
  return null;
}

export interface Toolchain {
  hyperframes: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  chrome: string | null;
}

export function toolchain(
  browserSetting: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Toolchain {
  return {
    hyperframes: cliVersion(),
    ffmpeg: findOnPath('ffmpeg', env),
    ffprobe: findOnPath('ffprobe', env),
    chrome: findChrome(browserSetting, env),
  };
}

export interface RunOptions {
  cwd: string;
  tools: Toolchain;
  signal: AbortSignal;
  onLine?: (line: string) => void;
}
export interface RunResult {
  code: number | null;
  /** the last lines of stdout and stderr together */
  tail: string;
}

/** Run a HyperFrames command with NodCut's Node, offline, and the tools we found. */
export function runCli(args: string[], o: RunOptions): Promise<RunResult> {
  const env: Record<string, string> = {
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_SKIP_SKILLS: '1',
    CI: '1',
  };
  // ELECTRON_RUN_AS_NODE: under the NodCut app, process.execPath is Electron; without it the
  // CLI would start as an Electron app and hang
  for (const k of [
    'PATH',
    'HOME',
    'LANG',
    'TMPDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'ELECTRON_RUN_AS_NODE',
  ])
    if (process.env[k]) env[k] = process.env[k]!;
  if (o.tools.chrome) env.HYPERFRAMES_BROWSER_PATH = o.tools.chrome;
  if (o.tools.ffmpeg) env.HYPERFRAMES_FFMPEG_PATH = o.tools.ffmpeg;
  if (o.tools.ffprobe) env.HYPERFRAMES_FFPROBE_PATH = o.tools.ffprobe;
  // ffmpeg next to the CLI's own PATH lookups too
  const bins = [o.tools.ffmpeg, o.tools.ffprobe, o.tools.chrome].filter((p): p is string => !!p).map(dirname);
  env.PATH = [...new Set([...bins, ...(env.PATH ?? '').split(delimiter)])].filter(Boolean).join(delimiter);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath(), ...args], {
      cwd: o.cwd,
      env,
      signal: o.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let partial = '';
    const take = (chunk: Buffer) => {
      // eslint-disable-next-line no-control-regex -- strip ANSI colours
      partial += chunk.toString().replace(/\x1b\[[0-9;]*m/g, '');
      const parts = partial.split(/\r?\n|\r/);
      partial = parts.pop() ?? '';
      for (const l of parts) {
        if (!l.trim()) continue;
        lines.push(l);
        if (lines.length > 200) lines.shift();
        o.onLine?.(l);
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (partial.trim()) lines.push(partial);
      resolve({ code, tail: lines.slice(-12).join(' | ') });
    });
  });
}
