/**
 * The agent harness stays true: every skill under .agents/skills has valid front matter, is
 * linked for Claude Code, is listed in AGENTS.md, names only paths that exist in this repo and
 * no path of one machine (/Users/…), and AGENTS.md itself names only paths that exist.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..');
const SKILLS = join(ROOT, '.agents/skills');
const skills = readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, 'SKILL.md')));

/** `path/like/this` in backticks that should exist, relative to the repo root. */
export function repoPaths(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(/`([^`\n]+)`/g)) {
    const t = m[1]!.trim();
    if (/[<>*{}…$ ]/.test(t)) continue;
    if (!/^(packages|plugins|scripts|docs|examples|\.agents|\.claude|\.github)\/[\w.@/-]+$/.test(t)) continue;
    out.add(t.replace(/\/$/, ''));
  }
  return [...out];
}

const frontMatter = (text: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(m, 'SKILL.md starts with front matter').toBeTruthy();
  return Object.fromEntries(
    m![1]!.split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]),
  );
};

test('there is at least one skill', () => expect(skills.length).toBeGreaterThan(0));

describe.each(skills)('skill %s', (name) => {
  const text = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');

  test('front matter: name is the folder, description fits the loaders', () => {
    const fm = frontMatter(text);
    expect(fm.name).toBe(name);
    expect(fm.description!.length).toBeGreaterThan(40);
    expect(fm.description!.length).toBeLessThanOrEqual(1024);
  });

  test('is linked for Claude Code and listed in AGENTS.md', () => {
    const link = join(ROOT, '.claude/skills', name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(resolve(join(ROOT, '.claude/skills'), readlinkSync(link))).toBe(join(SKILLS, name));
    expect(readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')).toContain(`\`${name}\``);
  });

  test('names only paths that exist, and none of one machine', () => {
    expect(text).not.toMatch(/\/Users\/|\/home\/\w+\//);
    const missing = repoPaths(text).filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });
});

test('AGENTS.md names only paths that exist', () => {
  const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  expect(text).not.toMatch(/\/Users\//);
  expect(repoPaths(text).filter((p) => !existsSync(join(ROOT, p)))).toEqual([]);
});
