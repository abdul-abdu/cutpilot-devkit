/** Run audio.cpp's CLI for one sound; the last lines of its output explain a failure. */
import { spawn } from 'node:child_process';
import { cpus } from 'node:os';

export interface RunResult {
  code: number | null;
  /** the last lines of stdout and stderr together */
  tail: string;
  /** `metrics.<key>=<value>` lines the CLI prints with --metrics */
  metrics: Record<string, string>;
}

/** Half the cores, 2..8, unless the user set a number. */
export function threadCount(setting: number): number {
  if (setting > 0) return Math.round(setting);
  return Math.max(2, Math.min(8, Math.floor(cpus().length / 2)));
}

export function run(exe: string, args: string[], signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR', 'TEMP', 'TMP', 'USERPROFILE', 'SYSTEMROOT'])
      if (process.env[k]) env[k] = process.env[k]!;
    const child = spawn(exe, args, { env, signal, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const lines: string[] = [];
    const metrics: Record<string, string> = {};
    let partial = '';
    const take = (chunk: Buffer) => {
      partial += chunk.toString();
      const parts = partial.split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const l of parts) {
        if (!l.trim()) continue;
        const m = /^metrics\.([a-z_.]+)=(.*)$/.exec(l);
        if (m) metrics[m[1]!] = m[2]!;
        lines.push(l);
        if (lines.length > 200) lines.shift();
      }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      if (partial.trim()) lines.push(partial);
      resolve({ code, tail: lines.slice(-8).join(' | '), metrics });
    });
  });
}
