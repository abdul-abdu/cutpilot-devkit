/**
 * Language packs: a `language` plugin translates NodCut's interface (P3-067). It is data
 * only, so NodCut never starts it: the manifest's `languages` names, per language, a catalogue
 * of the window's strings and one of the menu bar's labels, both keyed by the English text.
 */
import { z } from 'zod';

/** A language code: `de`, `pt-BR`, `uz-Cyrl`. English is the source, not a pack. */
export const LanguageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'language codes look like de, pt-BR or uz-Cyrl')
  .refine((c) => c !== 'en' && !c.startsWith('en-'), 'English is built in; a pack translates it');

/** A JSON file inside the plugin folder. */
const CatalogueFileSchema = z
  .string()
  .min(1)
  .refine((p) => /\.json$/i.test(p), 'a catalogue is a .json file, like ru.json')
  .refine(
    (p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'),
    'a catalogue is a path inside the plugin folder',
  );

/** One language in a pack, as the manifest's `languages` lists it. */
export const LanguageSchema = z
  .object({
    code: LanguageCodeSchema,
    /** the language's name in itself, shown in Settings: Русский, O'zbekcha */
    name: z.string().min(1).max(40),
    /** the window's strings: a `MessageCatalogue` */
    messages: CatalogueFileSchema,
    /** the menu bar's labels: a `MenuCatalogue`; without one the menus stay English */
    menu: CatalogueFileSchema.optional(),
  })
  .strict();
export type Language = z.infer<typeof LanguageSchema>;

/** a catalogue file this big is refused before it is read */
export const CATALOGUE_MAX_BYTES = 2 * 1024 * 1024;

const Text = z.string().max(2000);

/** A count's forms by `Intl.PluralRules` category; `other` is the one every language has. */
export const PluralFormsSchema = z
  .object({
    zero: Text.optional(),
    one: Text.optional(),
    two: Text.optional(),
    few: Text.optional(),
    many: Text.optional(),
    other: Text,
  })
  .strict();

/**
 * The window's strings. A key is the English text (`Export…`, `Cut {n} words`), or for a count
 * its English singular (`{n} change`) with the forms as the value. `{name}` placeholders are
 * filled in by NodCut; a key may start with a context, `workspace|Review`, that English hides.
 */
export const MessageCatalogueSchema = z.record(
  z.string().min(1).max(2000),
  z.union([Text, PluralFormsSchema]),
);
export type MessageCatalogue = z.infer<typeof MessageCatalogueSchema>;

/** The menu bar's labels, keyed by the English label (`Export…`, `Quit NodCut`). */
export const MenuCatalogueSchema = z.record(z.string().min(1).max(200), z.string().max(200));
export type MenuCatalogue = z.infer<typeof MenuCatalogueSchema>;

/** A language a pack offers, with its catalogues read and checked. */
export interface LanguagePack {
  code: string;
  name: string;
  messages: MessageCatalogue;
  menu: MenuCatalogue;
}

const placeholders = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!));

/**
 * What is wrong with a catalogue's translations, one line each: a form that drops a placeholder
 * of the English (`{n}` may go, "one minute"), or adds one the English doesn't fill.
 */
export function catalogueProblems(catalogue: MessageCatalogue | MenuCatalogue): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(catalogue)) {
    const want = placeholders(key);
    const forms = typeof value === 'string' ? [value] : Object.values(value).filter((v) => v !== undefined);
    for (const form of forms) {
      const have = placeholders(form);
      const lost = [...want].filter((p) => p !== 'n' && !have.has(p));
      const extra = [...have].filter((p) => !want.has(p) && !(p === 'n' && typeof value !== 'string'));
      if (lost.length)
        out.push(`${JSON.stringify(key)}: ${JSON.stringify(form)} drops {${lost.join('}, {')}}`);
      if (extra.length)
        out.push(
          `${JSON.stringify(key)}: ${JSON.stringify(form)} has {${extra.join('}, {')}}, which isn't filled`,
        );
    }
  }
  return out;
}

/**
 * How a catalogue compares with the strings NodCut uses (its published list for a version):
 * the ones it lacks show in English; the ones NodCut no longer uses are ignored.
 */
export function catalogueCoverage(
  catalogue: Record<string, unknown>,
  strings: readonly string[],
): { missing: string[]; unused: string[] } {
  const used = new Set(strings);
  return {
    missing: strings.filter((s) => !(s in catalogue)),
    unused: Object.keys(catalogue).filter((k) => !used.has(k)),
  };
}

export type LanguagePackResult = { ok: true; pack: LanguagePack } | { ok: false; problems: string[] };

const issueLines = (file: string, e: z.ZodError) =>
  e.issues.slice(0, 5).map((i) => `${file}: ${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);

/**
 * One language of a pack from its parsed files (`menu` undefined when the manifest names none).
 * The engine and `nodcut-plugin validate` both judge a pack with this, so they agree.
 */
export function parseLanguagePack(language: Language, messages: unknown, menu?: unknown): LanguagePackResult {
  const m = MessageCatalogueSchema.safeParse(messages);
  const n = language.menu ? MenuCatalogueSchema.safeParse(menu) : null;
  const problems = [
    ...(m.success ? catalogueProblems(m.data) : issueLines(language.messages, m.error)),
    ...(!n ? [] : n.success ? catalogueProblems(n.data) : issueLines(language.menu!, n.error)),
  ];
  if (problems.length || !m.success || (n && !n.success)) return { ok: false, problems };
  return {
    ok: true,
    pack: { code: language.code, name: language.name, messages: m.data, menu: n?.data ?? {} },
  };
}

/**
 * The strings a NodCut version shows, published with each release for pack authors
 * (`nodcut-plugin validate --strings strings.json` reports what a pack lacks).
 */
export const StringsSchema = z
  .object({
    /** the NodCut version these are from */
    nodcut: z.string(),
    /** the window's: `MessageCatalogue` keys (a count by its English singular) */
    messages: z.array(z.string()),
    /** the menu bar's: `MenuCatalogue` keys */
    menu: z.array(z.string()),
  })
  .strict();
export type Strings = z.infer<typeof StringsSchema>;
