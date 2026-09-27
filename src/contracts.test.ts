import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  CONTRACT_TOOL_NAMES,
  contractTools,
  extraToolProblem,
  FindMusicOutputSchema,
  KIND_TOOLS,
  ReframeTrackInputSchema,
  ReframeTrackOutputSchema,
  TranscribeInputSchema,
  TranscribeOutputSchema,
} from './contracts.js';
import { PluginErrorSchema } from './errors.js';
import { PLUGIN_KINDS } from './manifest.js';

describe('kind contracts', () => {
  test('every kind has at least one tool, and the table covers every kind', () => {
    expect(Object.keys(KIND_TOOLS).sort()).toEqual([...PLUGIN_KINDS].sort());
    for (const k of PLUGIN_KINDS) expect(contractTools([k]).length).toBeGreaterThan(0);
    expect(contractTools(['transcriber', 'asset:music'])).toEqual(['transcribe', 'find_music', 'get_music']);
  });

  test('transcribe: words in time order, each ending at or after its start', () => {
    const ok = {
      language: 'uz',
      words: [
        { text: 'Salom,', start: 0, end: 400 },
        { text: '(laughs)', start: 400, end: 900, event: true },
      ],
    };
    expect(TranscribeOutputSchema.safeParse(ok).success).toBe(true);
    const back = { ...ok, words: [ok.words[1], ok.words[0]] };
    expect(TranscribeOutputSchema.safeParse(back).error?.issues[0]?.message).toBe('words are in time order');
    const inverted = { language: 'en', words: [{ text: 'a', start: 500, end: 100 }] };
    expect(TranscribeOutputSchema.safeParse(inverted).success).toBe(false);
    expect(TranscribeInputSchema.safeParse({ audio: '/a.wav', language: 'auto' }).success).toBe(true);
    expect(TranscribeInputSchema.safeParse({ audio: '/a.wav', language: 'English' }).success).toBe(false);
  });

  test('reframe_track: keyframe times strictly increase (property)', () => {
    const kf = fc.record({
      t: fc.nat({ max: 3_600_000 }),
      x: fc.double({ min: 0, max: 1, noNaN: true }),
      y: fc.double({ min: 0, max: 1, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(kf, { minLength: 1, maxLength: 50 }), (ks) => {
        const increasing = ks.every((k, i) => i === 0 || k.t > ks[i - 1]!.t);
        expect(ReframeTrackOutputSchema.safeParse({ keyframes: ks }).success).toBe(increasing);
      }),
    );
    const sorted = fc.uniqueArray(kf, { selector: (k) => k.t, minLength: 1, maxLength: 50 });
    fc.assert(
      fc.property(sorted, (ks) => {
        const keyframes = [...ks].sort((a, b) => a.t - b.t);
        expect(ReframeTrackOutputSchema.safeParse({ keyframes }).success).toBe(true);
      }),
    );
  });

  test('reframe_track input: known aspects and real ranges only', () => {
    const input = { source: '/v.mp4', aspect: '9:16', ranges: [{ start: 0, end: 5000 }] };
    expect(ReframeTrackInputSchema.safeParse(input).success).toBe(true);
    expect(ReframeTrackInputSchema.safeParse({ ...input, aspect: '21:9' }).success).toBe(false);
    expect(ReframeTrackInputSchema.safeParse({ ...input, ranges: [] }).success).toBe(false);
    expect(ReframeTrackInputSchema.safeParse({ ...input, ranges: [{ start: 5, end: 5 }] }).success).toBe(
      false,
    );
  });

  test('music: a track has a length and a license', () => {
    const track = {
      id: 'calm-01',
      title: 'Morning',
      moods: ['calm'],
      durationMs: 120_000,
      loopable: true,
      license: 'CC0',
    };
    expect(FindMusicOutputSchema.safeParse({ tracks: [track] }).success).toBe(true);
    expect(FindMusicOutputSchema.safeParse({ tracks: [{ ...track, durationMs: 0 }] }).success).toBe(false);
    expect(FindMusicOutputSchema.safeParse({ tracks: [{ ...track, license: '' }] }).success).toBe(false);
  });

  test('extra tools: snake_case, not a kind tool, and short enough for MCP clients', () => {
    expect(extraToolProblem('title-ideas', 'suggest_titles')).toBeNull();
    expect(extraToolProblem('title-ideas', 'suggestTitles')).toMatch(/snake_case/);
    expect(extraToolProblem('title-ideas', 'transcribe')).toMatch(/belongs to a plugin kind/);
    expect(extraToolProblem('a'.repeat(40), 'b'.repeat(23))).toMatch(/longer than 64/);
    expect(extraToolProblem('a'.repeat(40), 'b'.repeat(22))).toBeNull();
    expect(CONTRACT_TOOL_NAMES.has('get_music')).toBe(true);
  });
});

test('plugin errors: a code, one-line message and fix', () => {
  expect(
    PluginErrorSchema.safeParse({
      code: 'E_BAD_KEY',
      message: 'the API key was refused',
      fix: 'enter a new key in Plugins',
    }).success,
  ).toBe(true);
  expect(PluginErrorSchema.safeParse({ code: 'E_BAD_KEY', message: 'two\nlines', fix: 'x' }).success).toBe(
    false,
  );
  expect(PluginErrorSchema.safeParse({ code: 'bad', message: 'm', fix: 'f' }).success).toBe(false);
  expect(PluginErrorSchema.safeParse({ code: 'E_X', message: 'm' }).success).toBe(false);
});
