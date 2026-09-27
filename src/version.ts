/**
 * Just enough semver for plugins: versions like `1.2.3` / `1.2.3-beta.1`, and ranges like
 * `>=0.3 <1`, `^0.3.0`, `~1.2`, `1.x`, `*`, `a || b` (npm semantics, except that a prerelease
 * is compared by precedence without npm's same-tuple rule).
 */

export const VERSION_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

type V = [number, number, number, string[]];

export function parseVersion(v: string): V | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

export function compareVersions(a: V, b: V): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number);
  const [pa, pb] = [a[3], b[3]];
  if (!pa.length || !pb.length) return pb.length - pa.length; // a release is above its prereleases
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i], pb[i]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

type Cmp = { op: '<' | '<=' | '>' | '>=' | '='; v: V };

/** `1`, `1.2`, `1.x`, `1.2.3-beta` → the given parts (null = wildcard) */
function partial(s: string): [number | null, number | null, number | null, string[]] | null {
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/.exec(s);
  if (!m) return null;
  const n = (x: string | undefined) => (x === undefined || /^[xX*]$/.test(x) ? null : Number(x));
  const [a, b, c] = [n(m[1]), n(m[2]), n(m[3])];
  // a wildcard is only ever followed by wildcards (`1.x.x`, not `x.1`)
  if ((a === null && (b !== null || c !== null)) || (b === null && c !== null)) return null;
  return [a, b, c, m[4] ? m[4].split('.') : []];
}

function comparators(token: string): Cmp[] | null {
  if (token === '*' || token === '') return [];
  const m = /^(\^|~|>=|<=|>|<|=)?(.+)$/.exec(token);
  if (!m) return null;
  const op = m[1] ?? '';
  const p = partial(m[2]!);
  if (!p) return null;
  const [maj, min, pat, pre] = p;
  if (maj === null) return op === '' || op === '=' || op === '>=' || op === '<=' ? [] : null;
  const lo: V = [maj, min ?? 0, pat ?? 0, pre];
  const bump = (i: 0 | 1): V => (i === 0 ? [maj + 1, 0, 0, []] : [maj, (min ?? 0) + 1, 0, []]);
  switch (op) {
    case '^': {
      const hi =
        maj > 0 || min === null
          ? bump(0)
          : (min ?? 0) > 0 || pat === null
            ? bump(1)
            : [0, 0, (pat ?? 0) + 1, []];
      return [
        { op: '>=', v: lo },
        { op: '<', v: hi as V },
      ];
    }
    case '~':
      return [
        { op: '>=', v: lo },
        { op: '<', v: min === null ? bump(0) : bump(1) },
      ];
    case '':
    case '=':
      if (min === null)
        return [
          { op: '>=', v: lo },
          { op: '<', v: bump(0) },
        ];
      if (pat === null)
        return [
          { op: '>=', v: lo },
          { op: '<', v: bump(1) },
        ];
      return [{ op: '=', v: lo }];
    case '>':
      // `>1` means above every 1.x.x; `>1.2` above every 1.2.x
      if (min === null) return [{ op: '>=', v: bump(0) }];
      if (pat === null) return [{ op: '>=', v: bump(1) }];
      return [{ op: '>', v: lo }];
    case '<=':
      if (min === null) return [{ op: '<', v: bump(0) }];
      if (pat === null) return [{ op: '<', v: bump(1) }];
      return [{ op: '<=', v: lo }];
    default:
      return [{ op: op as Cmp['op'], v: lo }];
  }
}

/** Parse a range; null when it isn't one. */
export function parseRange(range: string): Cmp[][] | null {
  const sets: Cmp[][] = [];
  for (const alt of range.split('||')) {
    const set: Cmp[] = [];
    // `>= 1.2` → `>=1.2`
    const tokens = alt
      .trim()
      .replace(/(>=|<=|>|<|=|\^|~)\s+/g, '$1')
      .split(/\s+/);
    for (const t of tokens) {
      const c = comparators(t);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

/** Does `version` fall in `range`? False for anything unparseable. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const sets = parseRange(range);
  if (!v || !sets) return false;
  return sets.some((set) =>
    set.every(({ op, v: w }) => {
      const c = compareVersions(v, w);
      return op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '>=' ? c >= 0 : c === 0;
    }),
  );
}
