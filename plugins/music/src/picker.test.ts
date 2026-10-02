import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_LIMIT,
  lengthRank,
  moodRank,
  pick,
  queryScore,
  tagKey,
  tagsFor,
  type Track,
} from './picker.js';

const track = (id: string, o: Partial<Track> = {}): Track => ({
  id,
  title: id
    .split('-')
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' '),
  moods: [],
  durationMs: 60_000,
  loopable: false,
  license: 'CC0-1.0',
  file: `${id}.m4a`,
  ...o,
});

const LIB: Track[] = [
  track('still-water', { moods: ['calm'], durationMs: 53_000, loopable: true }),
  track('bright-side', { moods: ['upbeat'], durationMs: 48_000, loopable: true }),
  track('first-light', { moods: ['inspiring', 'upbeat'], durationMs: 60_000, loopable: true }),
  track('clear-plan', { moods: ['corporate', 'upbeat'], durationMs: 61_000 }),
  track('long-shadow', { moods: ['dramatic'], durationMs: 55_000, loopable: true }),
  track('rainy-desk', { moods: ['lo-fi', 'calm'], durationMs: 72_000, loopable: true }),
  track('short-sting', { moods: ['upbeat'], durationMs: 8_000 }),
];
const ids = (ts: Track[]) => ts.map((t) => t.id);

describe('tags', () => {
  test('spelling of a tag does not matter', () => {
    expect(tagKey('Lo-Fi')).toBe('lofi');
    expect(tagKey('lo fi')).toBe('lofi');
    expect(tagKey('LOFI')).toBe('lofi');
  });

  test('common words stand for the library moods', () => {
    expect(tagsFor('happy')).toContain('upbeat');
    expect(tagsFor('Epic')).toContain('dramatic');
    expect(tagsFor('chill')).toEqual(new Set(['chill', 'lofi', 'calm']));
    expect(tagsFor('calm')).toEqual(new Set(['calm']));
  });
});

describe('mood', () => {
  test('keeps only the tracks with the mood, the main mood first', () => {
    expect(ids(pick(LIB, { mood: 'calm' }))).toEqual(['still-water', 'rainy-desk']);
    expect(ids(pick(LIB, { mood: 'upbeat' }))).toEqual([
      'bright-side',
      'short-sting',
      'clear-plan',
      'first-light',
    ]);
  });

  test('lo-fi in any spelling, and synonyms', () => {
    for (const m of ['lo-fi', 'lofi', 'Lo Fi', 'chill'])
      expect(ids(pick(LIB, { mood: m }))).toContain('rainy-desk');
    expect(ids(pick(LIB, { mood: 'epic' }))).toEqual(['long-shadow']);
    expect(ids(pick(LIB, { mood: 'business' }))).toEqual(['clear-plan']);
  });

  test('an unknown mood finds nothing', () => {
    expect(pick(LIB, { mood: 'polka' })).toEqual([]);
  });

  test('moodRank: main mood 2, a later tag 1, none 0', () => {
    expect(moodRank(LIB[2]!, 'inspiring')).toBe(2);
    expect(moodRank(LIB[2]!, 'upbeat')).toBe(1);
    expect(moodRank(LIB[2]!, 'calm')).toBe(0);
  });
});

describe('query', () => {
  test('matches words of the title or the moods', () => {
    expect(ids(pick(LIB, { query: 'rainy' }))).toEqual(['rainy-desk']);
    expect(ids(pick(LIB, { query: 'something dramatic for the trailer' }))).toEqual(['long-shadow']);
    expect(ids(pick(LIB, { query: 'lo fi beats' }))).toEqual(['rainy-desk']);
  });

  test('more matching words rank higher', () => {
    expect(queryScore(LIB[5]!, 'calm rainy')).toBe(2);
    expect(ids(pick(LIB, { query: 'calm rainy' }))[0]).toBe('rainy-desk');
  });

  test('mood and query together must both match', () => {
    expect(ids(pick(LIB, { mood: 'upbeat', query: 'light' }))).toEqual(['first-light']);
    expect(pick(LIB, { mood: 'dramatic', query: 'rainy' })).toEqual([]);
  });
});

describe('length', () => {
  test('a track that covers the length comes first, then one that loops, then the rest', () => {
    const r = pick(LIB, { mood: 'upbeat', minDurationMs: 55_000 });
    // first-light (60 s) and clear-plan (61 s) cover it; bright-side loops; short-sting is too short
    expect(ids(r)).toEqual(['first-light', 'clear-plan', 'bright-side', 'short-sting']);
  });

  test('of tracks that cover it, the shortest needs the least trimming', () => {
    expect(ids(pick(LIB, { minDurationMs: 58_000 })).slice(0, 3)).toEqual([
      'first-light',
      'clear-plan',
      'rainy-desk',
    ]);
  });

  test('longer than every track: the loopable ones first, the longest of them first', () => {
    const r = pick(LIB, { minDurationMs: 600_000 });
    expect(ids(r).slice(0, 2)).toEqual(['rainy-desk', 'first-light']);
    expect(r.at(-1)!.loopable).toBe(false);
  });

  test('lengthRank', () => {
    expect(lengthRank(LIB[0]!, undefined)).toBe(2);
    expect(lengthRank(LIB[0]!, 53_000)).toBe(2);
    expect(lengthRank(LIB[0]!, 90_000)).toBe(1);
    expect(lengthRank(LIB[3]!, 90_000)).toBe(0);
  });
});

describe('limit', () => {
  test('defaults to 10 and is respected', () => {
    const many = Array.from({ length: 30 }, (_, i) => track(`t-${i}`, { moods: ['calm'] }));
    expect(pick(many, {})).toHaveLength(DEFAULT_LIMIT);
    expect(pick(many, { limit: 3 })).toHaveLength(3);
  });

  test('property: the result is a subset, without repeats, in rank order of length', () => {
    const arb = fc.array(
      fc.record({
        durationMs: fc.integer({ min: 1, max: 200_000 }),
        loopable: fc.boolean(),
        moods: fc.subarray(['calm', 'upbeat', 'lo-fi', 'dramatic']),
      }),
      { maxLength: 20 },
    );
    fc.assert(
      fc.property(
        arb,
        fc.option(fc.integer({ min: 1, max: 200_000 }), { nil: undefined }),
        fc.integer({ min: 1, max: 50 }),
        (specs, min, limit) => {
          const lib = specs.map((s, i) => track(`t-${i}`, s));
          const r = pick(lib, { minDurationMs: min, limit });
          expect(r.length).toBeLessThanOrEqual(Math.min(limit, lib.length));
          expect(new Set(ids(r)).size).toBe(r.length);
          const ranks = r.map((t) => lengthRank(t, min));
          expect([...ranks].sort((a, b) => b - a)).toEqual(ranks);
        },
      ),
    );
  });
});
