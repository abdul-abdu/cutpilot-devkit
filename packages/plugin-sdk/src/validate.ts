/**
 * validatePluginFolder(): what can be checked in a plugin folder without starting it — the
 * manifest against `@cutpilot/plugin-api`, its icon, and that its command is there to run.
 * Fast and side-effect free, so editors and CLIs can run it on every save; `testPlugin()` starts
 * the plugin and checks the rest.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import {
  ICON_MAX_BYTES,
  ICON_MAX_PX,
  ICON_MIN_PX,
  iconProblem,
  MANIFEST_FILE,
  parseManifest,
  pngSize,
  type Manifest,
} from '@cutpilot/plugin-api';

export interface Check {
  name: string;
  result: 'pass' | 'fail' | 'skip';
  detail?: string;
  fix?: string;
}

/** What `validatePluginFolder()` and `testPlugin()` return; `formatReport()` prints it. */
export interface TestReport {
  /** the plugin's id, or the folder when the manifest can't be read */
  plugin: string;
  /** no check failed (skipped ones don't count) */
  ok: boolean;
  checks: Check[];
  /** the parsed manifest, when it is valid */
  manifest?: Manifest;
}

export const report = (plugin: string, checks: Check[], manifest?: Manifest): TestReport => ({
  plugin,
  ok: checks.every((c) => c.result !== 'fail'),
  checks,
  ...(manifest ? { manifest } : {}),
});

/** The manifest and its icon: the checks `testPlugin()` starts with. */
export function manifestChecks(dir: string): { checks: Check[]; manifest?: Manifest } {
  const checks: Check[] = [];
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
    checks.push({
      name: 'manifest',
      result: 'fail',
      detail: (e as Error).message,
      fix: missing ? `add ${MANIFEST_FILE} to ${dir}` : `make ${MANIFEST_FILE} valid JSON`,
    });
    return { checks };
  }
  const parsed = parseManifest(json);
  if (!parsed.ok) {
    checks.push({
      name: 'manifest',
      result: 'fail',
      detail: parsed.problems.join('; '),
      fix: `fix ${MANIFEST_FILE}`,
    });
    return { checks };
  }
  const m = parsed.manifest;
  checks.push({ name: 'manifest', result: 'pass', detail: `${m.id} ${m.version}` });

  if (m.icon) {
    // the store and the app check the same bytes the same way, so a bad icon fails here, not there
    let bytes: Buffer | null;
    try {
      bytes = readFileSync(join(dir, m.icon));
    } catch {
      bytes = null;
    }
    const problem = bytes ? iconProblem(bytes) : `${m.icon} doesn't exist`;
    checks.push(
      problem
        ? {
            name: 'icon',
            result: 'fail',
            detail: problem,
            fix: `put a square PNG (${ICON_MIN_PX}–${ICON_MAX_PX} px, at most ${ICON_MAX_BYTES / 1024} KB) at ${m.icon}, or drop "icon" from ${MANIFEST_FILE}`,
          }
        : { name: 'icon', result: 'pass', detail: `${pngSize(bytes!)!.width} px` },
    );
  }
  return { checks, manifest: m };
}

/** Where a bare command name is found on PATH, or null. */
export function findOnPath(name: string, path = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const d of path.split(delimiter).filter(Boolean))
    for (const ext of exts) {
      const p = join(d, name + ext);
      try {
        if (statSync(p).isFile()) {
          accessSync(p, constants.X_OK);
          return p;
        }
      } catch {
        // not here
      }
    }
  return null;
}

/** Arguments that name a file of the plugin folder (`dist/index.js`, `server.py`), not flags or subcommands. */
const looksLikeFile = (a: string) => !a.startsWith('-') && /\.[cm]?[jt]s$|\.py$|[\\/]/.test(a);

/**
 * Whether the manifest's command can start here. `node <file>`: the file exists (a TypeScript
 * plugin has to be built first). A path: the file exists in the folder. Another bare name (`uv`,
 * `python3`): it's on PATH — if not, the check is skipped, since that's this machine's business,
 * but the detail says what users will need.
 */
export function commandCheck(dir: string, m: Pick<Manifest, 'command' | 'args'>): Check {
  const name = 'command';
  const shown = [m.command, ...m.args].join(' ');
  const inFolder = (p: string) => {
    const rel = relative(dir, join(dir, p));
    return !rel.startsWith('..') && !isAbsolute(rel);
  };
  if (m.command === 'node') {
    const entry = m.args.find((a) => !a.startsWith('-'));
    if (!entry)
      return {
        name,
        result: 'fail',
        detail: 'node is started without a file',
        fix: `put the entry file in "args", like ["dist/index.js"]`,
      };
    if (!inFolder(entry))
      return {
        name,
        result: 'fail',
        detail: `${entry} is outside the plugin folder`,
        fix: 'keep the entry file inside the plugin folder',
      };
    if (!existsSync(join(dir, entry)))
      return {
        name,
        result: 'fail',
        detail: `${entry} doesn't exist`,
        fix: existsSync(join(dir, 'package.json'))
          ? `build the plugin (npm run build), or point "args" at the file that starts it`
          : `point "args" at the file that starts the plugin`,
      };
    return { name, result: 'pass', detail: shown };
  }
  if (/[\\/]/.test(m.command)) {
    if (!existsSync(join(dir, m.command)))
      return {
        name,
        result: 'fail',
        detail: `${m.command} doesn't exist in the plugin folder`,
        fix: 'build it, or fix "command" in the manifest',
      };
    return { name, result: 'pass', detail: shown };
  }
  const missing = m.args.filter(looksLikeFile).filter((a) => inFolder(a) && !existsSync(join(dir, a)));
  if (missing.length)
    return {
      name,
      result: 'fail',
      detail: `${missing.join(', ')} doesn't exist`,
      fix: 'add the file, or fix "args" in the manifest',
    };
  if (!findOnPath(m.command))
    return {
      name,
      result: 'skip',
      detail: `${m.command} isn't on PATH here`,
      fix: `install ${m.command} to run the plugin, and tell users in your README that they need it too`,
    };
  return { name, result: 'pass', detail: shown };
}

/**
 * Check a plugin folder without starting it: the manifest (schema, contract version, the reads
 * its kinds need), its icon, and its command. Synchronous; prints with `formatReport()`.
 */
export function validatePluginFolder(dir: string): TestReport {
  const { checks, manifest } = manifestChecks(dir);
  if (!manifest) return report(dir, checks);
  checks.push(commandCheck(dir, manifest));
  return report(manifest.id, checks, manifest);
}

/** The report as lines for a terminal: ✓ / ✗ / – per check, with the fix under what failed. */
export function formatReport(r: Pick<TestReport, 'plugin' | 'ok' | 'checks'>): string {
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
