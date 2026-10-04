/**
 * The first-party language packs (P3-067) are complete and well-formed against the strings the
 * app shows (`strings/strings.json`, written by the app's `pnpm strings`): every string
 * translated, every placeholder kept, nothing CutPilot no longer uses.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { StringsSchema, validatePluginFolder } from '../packages/plugin-sdk/src/index.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const strings = StringsSchema.parse(JSON.parse(readFileSync(join(ROOT, 'strings/strings.json'), 'utf8')));
const packs = readdirSync(join(ROOT, 'plugins'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith('language-'))
  .map((d) => d.name);

describe('language packs', () => {
  test('there are packs to check', () => expect(packs).toEqual(['language-ru', 'language-uz']));

  test.each(packs)('%s: valid, every string translated, nothing stale', (pack) => {
    const r = validatePluginFolder(join(ROOT, 'plugins', pack), { strings });
    expect(r.checks.filter((c) => c.result !== 'pass')).toEqual([]);
    expect(r.checks.at(-1)?.detail).toBe('every string');
  });
});
