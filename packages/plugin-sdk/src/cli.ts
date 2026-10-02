/**
 * `cutpilot-plugin`: the SDK's command line.
 *
 *   cutpilot-plugin validate [DIR]   the manifest, icon and command, without starting the plugin
 *   cutpilot-plugin test [DIR]       start it the way CutPilot does and call its tools
 *
 * Each check prints as ✓ (passed), ✗ (failed, with its fix) or – (skipped); the exit code is 1
 * when a check failed and 2 for a usage error. The app's `cutpilot plugin validate|test` call the
 * same functions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { testPlugin, type TestOptions } from './harness.js';
import { formatReport, validatePluginFolder, type TestReport } from './validate.js';

export const CLI_USAGE = `usage:
  cutpilot-plugin validate [DIR]      check the manifest, icon and command without starting the plugin
  cutpilot-plugin test [DIR]          start the plugin the way CutPilot does and call its tools
      --audio FILE                    a 16 kHz mono wav for transcribe (default: a second of silence)
      --language CODE                 the language to ask for (default: en)
      --video FILE                    a video for reframe_track (skipped without one)
      --templates first|all|none      which generator templates to render (default: first)
      --sound JSON                    a sound to ask an asset:sound plugin for, e.g. '{"kind":"sfx","prompt":"a beep"}'
      --secret NAME[=VALUE]           a secret (VALUE, or the NAME environment variable); repeatable
      --setting KEY=VALUE             a setting; repeatable
      --timeout MS                    per call (default: 60000)
  cutpilot-plugin validate|test --json   the report as JSON
DIR defaults to the current folder.`;

class UsageError extends Error {}

const pair = (s: string, what: string): [string, string | undefined] => {
  const i = s.indexOf('=');
  if (i === 0) throw new UsageError(`${what} ${s}: the name comes before =`);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
};

function testOptions(v: Record<string, string | string[] | boolean | undefined>): TestOptions {
  const o: TestOptions = {};
  const fixtures: NonNullable<TestOptions['fixtures']> = {};
  if (typeof v.audio === 'string') fixtures.audio = resolve(v.audio);
  if (typeof v.video === 'string') fixtures.video = resolve(v.video);
  if (typeof v.language === 'string') fixtures.language = v.language;
  if (Object.keys(fixtures).length) o.fixtures = fixtures;
  if (typeof v.templates === 'string') {
    if (!['first', 'all', 'none'].includes(v.templates))
      throw new UsageError('--templates is first, all or none');
    o.templates = v.templates as TestOptions['templates'];
  }
  if (typeof v.sound === 'string') {
    try {
      o.sound = JSON.parse(v.sound) as Record<string, unknown>;
    } catch {
      throw new UsageError(`--sound is JSON, like '{"kind":"sfx","prompt":"a beep"}'`);
    }
  }
  if (typeof v.timeout === 'string') {
    const ms = Number(v.timeout);
    if (!Number.isFinite(ms) || ms <= 0) throw new UsageError('--timeout is a number of milliseconds');
    o.timeoutMs = ms;
  }
  for (const s of (v.secret as string[] | undefined) ?? []) {
    const [name, value] = pair(s, '--secret');
    const got = value ?? process.env[name];
    if (got === undefined) throw new UsageError(`--secret ${name}: give a value (${name}=…) or set ${name}`);
    (o.secrets ??= {})[name] = got;
  }
  for (const s of (v.setting as string[] | undefined) ?? []) {
    const [key, value] = pair(s, '--setting');
    if (value === undefined) throw new UsageError(`--setting ${key}: give a value (${key}=…)`);
    (o.settings ??= {})[key] = value;
  }
  return o;
}

const OPTIONS = {
  json: { type: 'boolean' },
  audio: { type: 'string' },
  video: { type: 'string' },
  language: { type: 'string' },
  templates: { type: 'string' },
  sound: { type: 'string' },
  timeout: { type: 'string' },
  secret: { type: 'string', multiple: true },
  setting: { type: 'string', multiple: true },
  help: { type: 'boolean', short: 'h' },
} as const;

/** Run `cutpilot-plugin <argv>`; returns the exit code. */
export async function pluginCli(
  argv: string[],
  out: (line: string) => void = (s) => void process.stdout.write(s + '\n'),
): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'version' || cmd === '--version') {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version: string;
      };
      out(pkg.version);
      return 0;
    }
    if (cmd !== 'validate' && cmd !== 'test') {
      out(CLI_USAGE);
      return cmd === undefined || cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 2;
    }
    const { values, positionals } = parseArgs({
      args: rest,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    if (values.help) {
      out(CLI_USAGE);
      return 0;
    }
    if (positionals.length > 1) throw new UsageError(`${cmd} takes one folder`);
    const dir = resolve(positionals[0] ?? '.');
    let r: TestReport;
    if (cmd === 'validate') {
      const other = Object.keys(values).filter((k) => k !== 'json');
      if (other.length) throw new UsageError(`validate doesn't take --${other[0]}`);
      r = validatePluginFolder(dir);
    } else r = await testPlugin(dir, testOptions(values));
    if (values.json) {
      const { manifest: _manifest, ...shown } = r;
      out(JSON.stringify(shown, null, 2));
    } else out(formatReport(r));
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      out(`${(e as Error).message}\n\n${CLI_USAGE}`);
      return 2;
    }
    throw e;
  }
}
