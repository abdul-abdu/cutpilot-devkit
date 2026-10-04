/**
 * What a render needs on this machine: Manim Community (a Python program the user installs, or
 * one uv fetches from PyPI on first use) and, for MathTex, LaTeX. Manim is found in this order:
 * the "Manim command" setting (a manim executable, or a Python that has manim); `manim` on PATH;
 * a python3 that can `import manim`; else `uv tool run --from manim manim`, which downloads Manim
 * once into uv's cache (that is what the manifest's PyPI hosts are for).
 *
 * A GUI app starts plugins with a short PATH, so the usual install folders (Homebrew, pipx's and
 * uv's ~/.local/bin, MacTeX's /Library/TeX/texbin) are searched too, and passed on to Manim.
 */
import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** What uv installs when Manim isn't on the machine. */
export const UV_MANIM = 'manim>=0.19,<1';
/**
 * The Python uv runs it on: macOS's own python3 is 3.9, where uv resolves a Manim that can't
 * start (no importlib_metadata), so a newer one, downloaded by uv when the machine has none.
 */
export const UV_PYTHON = '>=3.10,<3.14';

/** The Python file that draws the templates and wraps custom scenes. */
export const runtimePath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), '..', 'python', 'nodcut_manim.py');

/** Where tools live when a GUI app's PATH doesn't say. */
export function extraDirs(home: string = homedir()): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/Library/TeX/texbin',
    '/usr/texbin',
  ];
}

export function searchPath(env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), ...extraDirs(env.HOME || homedir())];
  return [...new Set(dirs)];
}

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const d of searchPath(env)) for (const n of names) if (existsSync(join(d, n))) return join(d, n);
  return null;
}

/** How to start Manim: `command ...args render …`. */
export interface Runner {
  command: string;
  args: string[];
  /** where it came from, for the doctor */
  via: 'setting' | 'manim' | 'python' | 'uv';
}

const hasManim = (python: string) =>
  spawnSync(python, ['-c', 'import manim'], { stdio: 'ignore', timeout: 30_000 }).status === 0;

/** Manim to render with, or null; a setting that points nowhere is null, not a fallback. */
export function findManim(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): Runner | null {
  const set = setting?.trim();
  if (set) {
    if (!existsSync(set)) return null;
    return /python[\d.]*(\.exe)?$/i.test(basename(set))
      ? { command: set, args: ['-m', 'manim'], via: 'setting' }
      : { command: set, args: [], via: 'setting' };
  }
  const manim = findOnPath('manim', env);
  if (manim) return { command: manim, args: [], via: 'manim' };
  for (const name of ['python3', 'python']) {
    const py = findOnPath(name, env);
    if (py && hasManim(py)) return { command: py, args: ['-m', 'manim'], via: 'python' };
  }
  const uv = findOnPath('uv', env);
  if (uv)
    return {
      command: uv,
      args: ['tool', 'run', '--python', UV_PYTHON, '--from', UV_MANIM, 'manim'],
      via: 'uv',
    };
  return null;
}

export interface Latex {
  latex: string | null;
  dvisvgm: string | null;
}

/** MathTex runs `latex` then `dvisvgm`; both must be there. */
export const findLatex = (env: NodeJS.ProcessEnv = process.env): Latex => ({
  latex: findOnPath('latex', env),
  dvisvgm: findOnPath('dvisvgm', env),
});

/** The environment Manim runs in: what it needs from ours, and the folders we searched. */
export function manimEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    // no colours or boxes in the lines we read
    NO_COLOR: '1',
    TERM: 'dumb',
    ...extra,
  };
  for (const k of [
    'HOME',
    'LANG',
    'LC_ALL',
    'TMPDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'SYSTEMROOT',
    'UV_CACHE_DIR',
    'UV_TOOL_DIR',
    'UV_PYTHON_INSTALL_DIR',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    // uv fetching Manim behind a proxy or a private index
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'UV_NATIVE_TLS',
    'UV_INDEX_URL',
    'UV_DEFAULT_INDEX',
    'UV_OFFLINE',
  ])
    if (process.env[k]) env[k] = process.env[k]!;
  env.PATH = searchPath(process.env).join(delimiter);
  return env;
}

/** `Manim Community v0.19.0` → "0.19.0"; first use through uv may download Manim, so it is slow. */
export function manimVersion(r: Runner, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      r.command,
      [...r.args, '--version'],
      { env: manimEnv(), signal, timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const m = /v?(\d+\.\d+\.\d+\S*)/.exec(stdout);
        if (m) return resolve(m[1]!);
        const why = (stderr || stdout || err?.message || '').trim().split('\n').slice(-3).join(' ');
        reject(new Error(why || 'manim --version printed no version'));
      },
    );
  });
}

export interface RunOptions {
  cwd: string;
  signal: AbortSignal;
  env: Record<string, string>;
  onLine?: (line: string) => void;
}
export interface RunResult {
  code: number | null;
  /** the last lines Manim printed */
  tail: string[];
  /** what the runtime said about a failure (`NameError: … (line 7: …)`), if it did */
  explained: string | null;
}

/** Run Manim, reading its output line by line (progress bars end in \r). */
export function runManim(r: Runner, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(r.command, [...r.args, ...args], {
      cwd: o.cwd,
      env: o.env,
      signal: o.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines: string[] = [];
    let explained: string | null = null;
    let partial = '';
    const take = (chunk: Buffer) => {
      // eslint-disable-next-line no-control-regex -- strip ANSI colours
      partial += chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const parts = partial.split(/\r?\n|\r/);
      partial = parts.pop() ?? '';
      for (const l of parts) {
        if (!l.trim()) continue;
        explained = errorLine([l]) ?? explained;
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
      resolve({ code, tail: lines.slice(-40), explained });
    });
  });
}

/** The line the runtime printed about a failure (`NODCUT_ERROR NameError: … (line 7: …)`). */
export function errorLine(tail: string[]): string | null {
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = /NODCUT_ERROR (.+)$/.exec(tail[i]!);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** Manim's last words when the runtime didn't explain: the last line that looks like an error. */
export function lastError(tail: string[]): string {
  const clean = tail
    .map((l) => l.replace(/[│╭╮╰╯─┃━]+/g, ' ').trim())
    .filter((l) => l && !/^Animation \d+/.test(l));
  const err = [...clean].reverse().find((l) => /^[\w.]*(Error|Exception)\b|^error:/i.test(l));
  return (err ?? clean.slice(-3).join(' | ')).slice(0, 400);
}

/** `NODCUT_PROGRESS 0.42` → 0.42 */
export function progressOf(line: string): number | null {
  const m = /NODCUT_PROGRESS (\d*\.?\d+)/.exec(line);
  return m ? Math.min(1, Number(m[1])) : null;
}
