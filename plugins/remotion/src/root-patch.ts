/**
 * The one change this plugin makes outside src/nodcut: `<NodCutCompositions />` in the
 * user's root component (the one passed to registerRoot), and its import. Applied once, with a
 * backup and a diff to show; when the file isn't laid out in a way that can be patched safely,
 * nothing is written and the user gets the two lines to add instead.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { scenesDir, writeAtomic } from './scenes.js';

const SOURCE_EXT = ['.tsx', '.ts', '.jsx', '.js'];
/** Where Remotion looks when no entry point is configured (and where its templates put it). */
const DEFAULT_ENTRIES = [
  'src/index.ts',
  'src/index.tsx',
  'src/index.js',
  'src/index.jsx',
  'remotion/index.ts',
  'remotion/index.tsx',
  'app/remotion/index.ts',
];

const inside = (projectDir: string, file: string) => {
  const root = resolve(projectDir);
  const f = resolve(file);
  return f === root || f.startsWith(root + sep);
};

/**
 * The entry point (the file that calls registerRoot): `Config.setEntryPoint()` in
 * remotion.config, else the file a `remotion studio|render|bundle …` script names, else
 * Remotion's defaults. Null when there is none in the project.
 */
export function findEntryPoint(projectDir: string): string | null {
  const candidates: string[] = [];
  for (const name of ['remotion.config.ts', 'remotion.config.js', 'remotion.config.mjs']) {
    const f = join(projectDir, name);
    if (!existsSync(f)) continue;
    const m = /Config\.setEntryPoint\(\s*['"`]([^'"`]+)['"`]\s*\)/.exec(readFileSync(f, 'utf8'));
    if (m) candidates.push(m[1]!);
  }
  try {
    const pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const script of Object.values(pkg.scripts ?? {})) {
      const m =
        /\bremotion\s+(?:studio|preview|render|still|bundle|compositions)\s+(\S+\.[cm]?[jt]sx?)\b/.exec(
          script,
        );
      if (m) candidates.push(m[1]!);
    }
  } catch {
    /* no package.json: the project check says so */
  }
  candidates.push(...DEFAULT_ENTRIES);
  for (const c of candidates) {
    const f = resolve(projectDir, c);
    if (inside(projectDir, f) && existsSync(f)) return f;
  }
  return null;
}

/** A relative import as a file: `./Root` → Root.tsx / Root.ts / … / Root/index.tsx. */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  const tries = [base, ...SOURCE_EXT.map((e) => base + e), ...SOURCE_EXT.map((e) => join(base, `index${e}`))];
  if (/\.[cm]?js$/.test(spec)) tries.push(...SOURCE_EXT.map((e) => base.replace(/\.[cm]?js$/, e)));
  return tries.find((f) => existsSync(f) && /\.[cm]?[jt]sx?$/.test(f)) ?? null;
}

/**
 * The file that defines the root component: the one `registerRoot(X)` in the entry point
 * imports X from (or the entry point itself when X is defined there). Null when it can't be told.
 */
export function findRootFile(entryFile: string): string | null {
  const text = readFileSync(entryFile, 'utf8');
  const call = /registerRoot\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(text);
  if (!call) return null;
  const name = call[1]!;
  const esc = name.replace(/\$/g, '\\$');
  const named = new RegExp(
    `import\\s*(?:[\\w$]+\\s*,\\s*)?\\{[^}]*?(?:\\b[\\w$]+\\s+as\\s+${esc}|\\b${esc})\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`,
  ).exec(text);
  const dflt = new RegExp(`import\\s+${esc}\\s*(?:,\\s*\\{[^}]*\\})?\\s*from\\s*['"]([^'"]+)['"]`).exec(text);
  const spec = named?.[1] ?? dflt?.[1];
  if (!spec) return new RegExp(`(?:function|const|let|class)\\s+${esc}\\b`).test(text) ? entryFile : null;
  if (!spec.startsWith('.')) return null;
  return resolveImport(entryFile, spec);
}

export const COMPONENT = 'NodCutCompositions';
const ALREADY_RE = new RegExp(`<${COMPONENT}\\s*/>`);

/** The import specifier of src/nodcut from the root file, e.g. `./nodcut`. */
export function importSpec(rootFile: string, projectDir: string): string {
  const rel = relative(dirname(rootFile), scenesDir(projectDir)).split(sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

export type PatchResult =
  { kind: 'already' } | { kind: 'patched'; text: string } | { kind: 'manual'; reason: string };

/**
 * Add `<NodCutCompositions />` and its import to a root component's source. It goes just
 * before the closing `</>` of the fragment the component returns, so that file must have
 * exactly one; anything else (no fragment, several, a JS file without JSX) is left to the user.
 */
export function patchRootSource(text: string, spec: string): PatchResult {
  if (ALREADY_RE.test(text)) return { kind: 'already' };
  const closings = [...text.matchAll(/<\/>/g)];
  if (closings.length !== 1)
    return {
      kind: 'manual',
      reason: closings.length
        ? `it has ${closings.length} fragments, so the right place isn't certain`
        : "its root component doesn't return a fragment (<>…</>)",
    };
  const at = closings[0]!.index!;
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const before = text.slice(lineStart, at);
  let body: string;
  if (/^\s*$/.test(before)) {
    // `</>` on its own line: a line before it, indented one step more than the `</>`
    const indent = before;
    const step = /\t/.test(indent) ? '\t' : '  ';
    body = `${text.slice(0, lineStart)}${indent}${step}<${COMPONENT} />\n${text.slice(lineStart)}`;
  } else {
    body = `${text.slice(0, at)}<${COMPONENT} />${text.slice(at)}`;
  }

  const imports = [...body.matchAll(/^import\s[\s\S]*?(?:from\s*)?(['"])[^'"]+['"](;?)[ \t]*$/gm)];
  // in the file's own style: its quotes, its semicolons
  const q = imports[0]?.[1] ?? "'";
  const semi = imports.length && !imports[0]![2] ? '' : ';';
  const importLine = `import { ${COMPONENT} } from ${q}${spec}${q}${semi}`;
  if (!imports.length) return { kind: 'patched', text: `${importLine}\n${body}` };
  const last = imports[imports.length - 1]!;
  const end = last.index! + last[0].length;
  return { kind: 'patched', text: `${body.slice(0, end)}\n${importLine}${body.slice(end)}` };
}

/** A unified diff of two texts (a plain LCS over lines; root files are small). */
export function unifiedDiff(name: string, a: string, b: string, context = 2): string {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  type Op = { t: ' ' | '-' | '+'; s: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: ' ', s: x[i]!, ai: i++, bi: j++ });
    else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!))
      ops.push({ t: '+', s: y[j]!, ai: i, bi: j++ });
    else ops.push({ t: '-', s: x[i]!, ai: i++, bi: j });
  }
  const out = [`--- a/${name}`, `+++ b/${name}`];
  for (let k = 0; k < ops.length;) {
    if (ops[k]!.t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    while (end < ops.length) {
      if (ops[end]!.t !== ' ') {
        end++;
        continue;
      }
      let run = 0;
      while (end + run < ops.length && ops[end + run]!.t === ' ') run++;
      if (end + run >= ops.length || run > context * 2) {
        end = Math.min(ops.length, end + context);
        break;
      }
      end += run;
    }
    const hunk = ops.slice(start, end);
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${hunk[0]!.ai + 1},${aLen} +${hunk[0]!.bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(`${o.t}${o.s}`);
    k = end;
  }
  return out.join('\n');
}

export interface RootPatch {
  /**
   * already: nothing to do; patched: done now (backup + diff); pending: would be patched (asked
   * not to write); manual: the user adds the lines
   */
  state: 'already' | 'patched' | 'pending' | 'manual';
  file: string | null;
  backup?: string;
  diff?: string;
  /** for manual: what to add, and where */
  instructions?: string;
}

const manualText = (file: string | null, spec: string, reason: string) =>
  `${file ? `Couldn't patch ${file} safely: ${reason}.` : `Couldn't find the root component: ${reason}.`} ` +
  `Add this line inside the <>…</> your root component returns: <${COMPONENT} />  ` +
  `and this import at the top of that file: import { ${COMPONENT} } from '${spec}';`;

/**
 * Make sure the root component registers NodCut's scenes; the first time, back up and patch.
 * With `write: false`, only say what would happen.
 */
export function ensureRootPatched(
  projectDir: string,
  { write = true, now = new Date() }: { write?: boolean; now?: Date } = {},
): RootPatch {
  const entry = findEntryPoint(projectDir);
  const fallbackSpec = './nodcut';
  if (!entry)
    return {
      state: 'manual',
      file: null,
      instructions: manualText(null, fallbackSpec, 'no entry point (src/index.ts or Config.setEntryPoint)'),
    };
  const root = findRootFile(entry);
  if (!root || !inside(projectDir, root))
    return {
      state: 'manual',
      file: null,
      instructions: manualText(
        null,
        fallbackSpec,
        `${relative(projectDir, entry)} has no registerRoot(…) of a local file`,
      ),
    };
  const rel = relative(projectDir, root);
  const spec = importSpec(root, projectDir);
  const before = readFileSync(root, 'utf8');
  const r = patchRootSource(before, spec);
  if (r.kind === 'already') return { state: 'already', file: rel };
  if (r.kind === 'manual')
    return { state: 'manual', file: rel, instructions: manualText(rel, spec, r.reason) };
  if (!write) return { state: 'pending', file: rel, diff: unifiedDiff(rel, before, r.text) };

  const backups = join(scenesDir(projectDir), 'backups');
  mkdirSync(backups, { recursive: true });
  const backup = join(backups, `${rel.split(sep).join('_')}.${now.toISOString().replace(/[:.]/g, '-')}.bak`);
  copyFileSync(root, backup);
  writeAtomic(root, r.text);
  return {
    state: 'patched',
    file: rel,
    backup: relative(projectDir, backup),
    diff: unifiedDiff(rel, before, r.text),
  };
}
