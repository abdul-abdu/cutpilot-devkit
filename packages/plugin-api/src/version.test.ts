import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { compareVersions, parseRange, parseVersion, satisfies } from './version.js';

describe('versions and ranges', () => {
  test.each([
    ['0.3.0', '>=0.3 <1', true],
    ['0.9.12', '>=0.3 <1', true],
    ['1.0.0', '>=0.3 <1', false],
    ['0.2.9', '>=0.3 <1', false],
    ['0.3.4', '^0.3.0', true],
    ['0.4.0', '^0.3.0', false],
    ['1.9.0', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.7.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['5.0.0', '*', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '=1.2.3', false],
    ['1.2.9', '>1.2', false],
    ['1.3.0', '>1.2', true],
    ['1.2.9', '<=1.2', true],
    ['1.3.0', '<=1.2', false],
    ['0.5.0', '<0.3 || >=0.5', true],
    ['0.4.0', '<0.3 || >=0.5', false],
    ['0.3.0-beta.1', '>=0.3', false],
    ['0.3.0-beta.1', '>=0.3.0-beta.0', true],
    ['0.3.0', '>= 0.3', true],
  ])('%s in %s → %s', (v, r, want) => {
    expect(satisfies(v, r)).toBe(want);
  });

  test('garbage is never satisfied and ranges that are not ranges are refused', () => {
    expect(satisfies('one', '*')).toBe(false);
    expect(satisfies('1.0.0', 'soon')).toBe(false);
    expect(parseRange('>=x.1')).toBeNull();
    expect(parseRange('>=0.3 <1')).not.toBeNull();
  });

  test('prereleases sort below their release, numerically by part', () => {
    const c = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));
    expect(c('1.0.0-beta.2', '1.0.0')).toBe(-1);
    expect(c('1.0.0-beta.10', '1.0.0-beta.2')).toBe(1);
    expect(c('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(c('1.0.0-beta', '1.0.0-beta.1')).toBe(-1);
  });

  test('comparison is a total order (property)', () => {
    const version = fc
      .tuple(
        fc.nat(20),
        fc.nat(20),
        fc.nat(20),
        fc.option(fc.constantFrom('alpha', 'beta.1', 'beta.2', 'rc.1')),
      )
      .map(([a, b, c, p]) => parseVersion(`${a}.${b}.${c}${p ? `-${p}` : ''}`)!);
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        expect(Math.sign(compareVersions(a, b))).toBe(-Math.sign(compareVersions(b, a)));
        if (compareVersions(a, b) <= 0 && compareVersions(b, c) <= 0)
          expect(compareVersions(a, c)).toBeLessThanOrEqual(0);
      }),
    );
  });
});
