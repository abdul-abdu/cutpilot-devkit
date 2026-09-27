/**
 * testPlugin(): start a plugin the way CutPilot does (in its folder, `node` = this Node, a
 * minimal environment, its settings and secrets as variables), then check the manifest, the
 * tools it offers, and one call of each contract tool against `@cutpilot/plugin-api`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CONTRACT_TOOL_NAMES,
  contractTools,
  extraToolProblem,
  KIND_TOOLS,
  MANIFEST_FILE,
  parseManifest,
  PluginErrorSchema,
  secretEnv,
  settingEnv,
  type Manifest,
} from '@cutpilot/plugin-api';
import type { z } from 'zod';

export interface TestOptions {
  /** values for the manifest's secrets; without them, contract calls are skipped */
  secrets?: Record<string, string>;
  settings?: Record<string, string | number | boolean>;
  fixtures?: {
    /** a 16 kHz mono wav for `transcribe` (default: one second of silence) */
    audio?: string;
    language?: string;
    /** a video for `reframe_track` (no default: the check is skipped without one) */
    video?: string;
  };
  /** per call; default 60 s */
  timeoutMs?: number;
}

export interface Check {
  name: string;
  result: 'pass' | 'fail' | 'skip';
  detail?: string;
  fix?: string;
}

export interface TestReport {
  plugin: string;
  ok: boolean;
  checks: Check[];
}

/** A 16 kHz mono 16-bit PCM wav of silence. */
export function silentWav(path: string, ms = 1000): string {
  const samples = Math.round((16000 * ms) / 1000);
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // mono
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  writeFileSync(path, b);
  return path;
}

/** How CutPilot starts a plugin's command. */
export function resolveCommand(dir: string, m: Pick<Manifest, 'command'>): string {
  if (m.command === 'node') return process.execPath;
  return /[\\/]/.test(m.command) ? join(dir, m.command) : m.command;
}

/** The environment CutPilot gives a plugin: nothing of its own but these. */
export function pluginEnv(
  m: Manifest,
  settings: Record<string, string | number | boolean> = {},
  secrets: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[k]) env[k] = process.env[k]!;
  for (const s of m.settings)
    if (settings[s.key] !== undefined) env[settingEnv(s.key)] = String(settings[s.key]);
  for (const name of m.permissions.secrets) if (secrets[name]) env[secretEnv(name)] = secrets[name]!;
  return env;
}

const issues = (e: z.ZodError) =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

export async function testPlugin(dir: string, opts: TestOptions = {}): Promise<TestReport> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const done = (plugin: string): TestReport => ({
    plugin,
    ok: checks.every((c) => c.result !== 'fail'),
    checks,
  });

  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (e) {
    add({
      name: 'manifest',
      result: 'fail',
      detail: (e as Error).message,
      fix: `add ${MANIFEST_FILE} to ${dir}`,
    });
    return done(dir);
  }
  const parsed = parseManifest(json);
  if (!parsed.ok) {
    add({
      name: 'manifest',
      result: 'fail',
      detail: parsed.problems.join('; '),
      fix: `fix ${MANIFEST_FILE}`,
    });
    return done(dir);
  }
  const m = parsed.manifest;
  add({ name: 'manifest', result: 'pass', detail: `${m.id} ${m.version}` });

  const tmp = mkdtempSync(join(tmpdir(), 'cutpilot-plugin-test-'));
  const transport = new StdioClientTransport({
    command: resolveCommand(dir, m),
    args: m.args,
    cwd: dir,
    env: pluginEnv(m, opts.settings, opts.secrets),
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  const client = new Client({ name: 'cutpilot-plugin-test', version: '1' });
  const tail = () => stderr.trim().split('\n').slice(-5).join(' | ') || 'no output';
  try {
    try {
      await client.connect(transport);
      add({ name: 'starts and answers', result: 'pass' });
    } catch (e) {
      add({
        name: 'starts and answers',
        result: 'fail',
        detail: `${(e as Error).message} (stderr: ${tail()})`,
        fix: `run "${m.command} ${m.args.join(' ')}" in ${dir} and fix what it prints`,
      });
      return done(m.id);
    }

    const offered = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const tool of contractTools(m.kinds))
      add(
        offered.has(tool)
          ? { name: `offers ${tool}`, result: 'pass' }
          : {
              name: `offers ${tool}`,
              result: 'fail',
              fix: `its kind needs a ${tool} tool (definePlugin does this for you)`,
            },
      );
    for (const tool of offered) {
      if (CONTRACT_TOOL_NAMES.has(tool)) continue;
      const p = extraToolProblem(m.id, tool);
      add(
        p
          ? { name: `extra tool ${tool}`, result: 'fail', detail: p, fix: 'rename the tool' }
          : { name: `extra tool ${tool}`, result: 'pass' },
      );
    }

    const missing = m.permissions.secrets.filter((s) => !opts.secrets?.[s]);
    const call = async (tool: string, args: Record<string, unknown>, output: z.ZodType) => {
      if (!offered.has(tool)) return undefined;
      const name = `${tool} answers per contract`;
      if (missing.length) {
        add({
          name,
          result: 'skip',
          detail: `needs ${missing.join(', ')}`,
          fix: 'pass the secrets to test the calls',
        });
        return undefined;
      }
      try {
        const r = await client.callTool({ name: tool, arguments: args }, undefined, {
          timeout: opts.timeoutMs ?? 60_000,
        });
        if (r.isError) {
          const err = PluginErrorSchema.safeParse(
            (r.structuredContent as { error?: unknown } | undefined)?.error,
          );
          add({
            name,
            result: 'fail',
            detail: err.success ? `${err.data.code}: ${err.data.message}` : JSON.stringify(r.content),
            fix: err.success ? err.data.fix : 'return errors as PluginFailure(code, message, fix)',
          });
          return undefined;
        }
        const o = output.safeParse(r.structuredContent);
        if (!o.success) {
          add({
            name,
            result: 'fail',
            detail: issues(o.error),
            fix: 'return what the contract in @cutpilot/plugin-api says',
          });
          return undefined;
        }
        add({ name, result: 'pass' });
        return o.data as Record<string, unknown>;
      } catch (e) {
        add({
          name,
          result: 'fail',
          detail: `${(e as Error).message} (stderr: ${tail()})`,
          fix: 'the call must answer within the timeout',
        });
        return undefined;
      }
    };

    if (m.kinds.includes('transcriber'))
      await call(
        'transcribe',
        {
          audio: opts.fixtures?.audio ?? silentWav(join(tmp, 'silence.wav')),
          language: opts.fixtures?.language ?? 'en',
        },
        KIND_TOOLS.transcriber.transcribe.output,
      );
    if (m.kinds.includes('analyzer:reframe-track')) {
      if (!opts.fixtures?.video)
        add({
          name: 'reframe_track answers per contract',
          result: 'skip',
          detail: 'no video given',
          fix: 'pass a short video to test it',
        });
      else
        await call(
          'reframe_track',
          { source: opts.fixtures.video, aspect: '9:16', ranges: [{ start: 0, end: 3000 }] },
          KIND_TOOLS['analyzer:reframe-track'].reframe_track.output,
        );
    }
    if (m.kinds.includes('asset:music')) {
      const found = await call('find_music', {}, KIND_TOOLS['asset:music'].find_music.output);
      const first = (found?.tracks as { id: string }[] | undefined)?.[0];
      if (first) {
        const got = await call('get_music', { id: first.id }, KIND_TOOLS['asset:music'].get_music.output);
        if (got && !existsSync(String(got.file)))
          add({
            name: 'get_music file exists',
            result: 'fail',
            detail: String(got.file),
            fix: 'return an absolute path to an existing file',
          });
      }
    }
    return done(m.id);
  } finally {
    await client.close().catch(() => {});
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The report as lines for a terminal. */
export function formatReport(r: TestReport): string {
  const mark = { pass: '✓', fail: '✗', skip: '–' } as const;
  const lines = r.checks.map((c) => {
    const head = `${mark[c.result]} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
    return c.result !== 'pass' && c.fix ? `${head}\n    fix: ${c.fix}` : head;
  });
  const failed = r.checks.filter((c) => c.result === 'fail').length;
  lines.push(
    r.ok ? `${r.plugin}: all checks passed` : `${r.plugin}: ${failed} check${failed === 1 ? '' : 's'} failed`,
  );
  return lines.join('\n');
}
