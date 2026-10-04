import { describe, expect, test } from 'vitest';
import {
  catalogueCoverage,
  catalogueProblems,
  MenuCatalogueSchema,
  MessageCatalogueSchema,
  parseLanguagePack,
} from './language.js';

describe('language catalogues (P3-067)', () => {
  test('strings and plural forms by CLDR category; other is required', () => {
    const ok = MessageCatalogueSchema.safeParse({
      'Export…': 'Exportieren…',
      '{n} change': { one: '{n} Änderung', other: '{n} Änderungen' },
    });
    expect(ok.success).toBe(true);
    expect(MessageCatalogueSchema.safeParse({ '{n} change': { one: '{n} Änderung' } }).success).toBe(false);
    expect(MessageCatalogueSchema.safeParse({ x: { other: 'y', dual: 'z' } }).success).toBe(false);
    expect(MessageCatalogueSchema.safeParse({ x: 7 }).success).toBe(false);
    expect(MenuCatalogueSchema.safeParse({ File: 'Ablage' }).success).toBe(true);
    expect(MenuCatalogueSchema.safeParse({ File: { other: 'Ablage' } }).success).toBe(false);
  });

  test('placeholders: kept, except a count may drop {n}; none made up', () => {
    expect(
      catalogueProblems({
        'Open {name} again': '{name} erneut öffnen',
        '{n} minute left': { one: 'Eine Minute übrig', other: 'Noch {n} Minuten' },
      }),
    ).toEqual([]);
    expect(catalogueProblems({ 'Open {name} again': 'Erneut öffnen' })).toEqual([
      '"Open {name} again": "Erneut öffnen" drops {name}',
    ]);
    expect(catalogueProblems({ Export: 'Exportieren {file}' })).toEqual([
      '"Export": "Exportieren {file}" has {file}, which isn\'t filled',
    ]);
    // tn() fills {n} into a count's forms even when its English key is a plain sentence
    expect(catalogueProblems({ 'One clip': { one: 'Ein Clip', other: '{n} Clips' } })).toEqual([]);
  });

  test('coverage against the strings NodCut uses', () => {
    expect(catalogueCoverage({ Export: 'Exportieren', Gone: 'Weg' }, ['Export', 'Settings'])).toEqual({
      missing: ['Settings'],
      unused: ['Gone'],
    });
  });

  test('a pack from its files: both catalogues checked, the menu optional', () => {
    const de = { code: 'de', name: 'Deutsch', messages: 'de.json', menu: 'de.menu.json' };
    expect(parseLanguagePack(de, { Export: 'Exportieren' }, { File: 'Ablage' })).toEqual({
      ok: true,
      pack: { code: 'de', name: 'Deutsch', messages: { Export: 'Exportieren' }, menu: { File: 'Ablage' } },
    });
    const { menu: _m, ...noMenu } = de;
    expect(parseLanguagePack(noMenu, { Export: 'Exportieren' })).toMatchObject({
      ok: true,
      pack: { menu: {} },
    });
    expect(parseLanguagePack(de, [], { File: 1 })).toEqual({
      ok: false,
      problems: [
        'de.json: Invalid input: expected record, received array',
        'de.menu.json: File: Invalid input: expected string, received number',
      ],
    });
    expect(parseLanguagePack(de, { 'Open {name}': 'Öffnen' }, {})).toEqual({
      ok: false,
      problems: ['"Open {name}": "Öffnen" drops {name}'],
    });
  });
});
