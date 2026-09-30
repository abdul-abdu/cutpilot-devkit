/**
 * What a render needs on this machine: the HyperFrames CLI (an npm dependency of this plugin), a
 * Chrome and ffmpeg. The plugin declares no network, so it never lets the CLI download a
 * browser: it finds one and passes it as HYPERFRAMES_BROWSER_PATH, or tells the user what to
 * install. (Plugins can't share code, so this is the same approach as the hyperframes plugin's.)
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** The folder of an installed package (`hyperframes` exports no package.json, so walk up too). */
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

/**
 * Browsers Puppeteer downloaded (`npx puppeteer browsers install`), newest first, the headless
 * shell before full Chrome (HyperFrames captures faster with it). Developers and CI machines
 * often have one when no Chrome is installed.
 */
export function puppeteerBrowsers(home: string = homedir()): string[] {
  const cache = join(home, '.cache', 'puppeteer');
  const kinds: [string, (platformDir: string) => string][] = [
    ['chrome-headless-shell', (d) => join(d, 'chrome-headless-shell')],
    [
      'chrome',
      (d) =>
        process.platform === 'darwin'
          ? join(d, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing')
          : join(d, 'chrome'),
    ],
  ];
  const out: string[] = [];
  for (const [kind, exe] of kinds) {
    let versions: string[];
    try {
      versions = readdirSync(join(cache, kind));
    } catch {
      continue;
    }
    const byVersion = (s: string) => (s.split('-').pop() ?? '').split('.').map(Number);
    versions.sort((a, b) => {
      const x = byVersion(a);
      const y = byVersion(b);
      for (let i = 0; i < Math.max(x.length, y.length); i++)
        if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
      return 0;
    });
    for (const v of versions) {
      let inner: string[];
      try {
        inner = readdirSync(join(cache, kind, v));
      } catch {
        continue;
      }
      for (const d of inner) {
        const p = exe(join(cache, kind, v, d));
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/**
 * The browser to render with: the setting if given; else PUPPETEER_EXECUTABLE_PATH or
 * HYPERFRAMES_BROWSER_PATH when set; else an installed Chrome; else one Puppeteer downloaded.
 */
export function findChrome(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string | null {
  if (setting?.trim()) return existsSync(setting.trim()) ? setting.trim() : null;
  for (const k of ['PUPPETEER_EXECUTABLE_PATH', 'HYPERFRAMES_BROWSER_PATH'])
    if (env[k] && existsSync(env[k]!)) return env[k]!;
  for (const p of CHROME_APPS[process.platform] ?? []) if (existsSync(p)) return p;
  for (const n of CHROME_NAMES) {
    const p = findOnPath(n, env);
    if (p) return p;
  }
  return puppeteerBrowsers(env.HOME || homedir())[0] ?? null;
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

/** Run a HyperFrames command with CutPilot's Node, offline, with the tools we found. */
export function runCli(args: string[], o: RunOptions): Promise<RunResult> {
  const env: Record<string, string> = {
    HYPERFRAMES_NO_TELEMETRY: '1',
    HYPERFRAMES_NO_UPDATE_CHECK: '1',
    HYPERFRAMES_SKIP_SKILLS: '1',
    CI: '1',
  };
  // ELECTRON_RUN_AS_NODE: under the CutPilot app, process.execPath is Electron; without it the
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
  const bins = [o.tools.ffmpeg, o.tools.ffprobe, o.tools.chrome].filter((p): p is string => !!p).map(dirname);
  env.PATH = [...new Set([...bins, ...(env.PATH ?? '').split(delimiter)])].filter(Boolean).join(delimiter);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(cliDir(), 'bin/hyperframes.mjs'), ...args], {
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

export interface Probe {
  width: number;
  height: number;
  durationMs: number;
  hasAudio: boolean;
}

/** What ffprobe says about a rendered clip. */
export function probe(ffprobe: string, file: string, signal?: AbortSignal): Promise<Probe> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file],
      { signal, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr.trim().split('\n')[0] || err.message));
        const info = JSON.parse(stdout) as {
          streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[];
          format?: { duration?: string };
        };
        const video = info.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
        if (!video) return reject(new Error('no video stream'));
        const seconds = Number(info.format?.duration ?? video.duration);
        resolve({
          width: video.width!,
          height: video.height!,
          durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
          hasAudio: !!info.streams?.some((s) => s.codec_type === 'audio'),
        });
      },
    );
  });
}
