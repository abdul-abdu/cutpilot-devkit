import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  CONTRACT_TOOL_NAMES,
  contractTools,
  extraToolProblem,
  FindFootageInputSchema,
  FindFootageOutputSchema,
  FootageCandidateSchema,
  GetFootageInputSchema,
  GetFootageOutputSchema,
  FindMusicOutputSchema,
  GenerateSoundInputSchema,
  GenerateSoundOutputSchema,
  ListVoicesOutputSchema,
  GenerateInputSchema,
  GenerateOutputSchema,
  ListTemplatesOutputSchema,
  KIND_TOOLS,
  ReframeTrackInputSchema,
  ReframeTrackOutputSchema,
  TranscribeInputSchema,
  TranscribeOutputSchema,
} from './contracts.js';
import { PluginErrorSchema } from './errors.js';
import { PLUGIN_KINDS } from './manifest.js';

describe('kind contracts', () => {
  test('every kind but the data-only language has a tool, and the table covers every kind', () => {
    expect(Object.keys(KIND_TOOLS).sort()).toEqual([...PLUGIN_KINDS].sort());
    for (const k of PLUGIN_KINDS) expect(contractTools([k]).length > 0, k).toBe(k !== 'language');
    expect(contractTools(['transcriber', 'asset:music'])).toEqual(['transcribe', 'find_music', 'get_music']);
  });

  test('generator: templates with a params schema and sane lengths; clips at even sizes', () => {
    const t = {
      id: 'title-card',
      name: 'Title card',
      description: 'A big title',
      params: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
      defaultDurationMs: 3000,
      minDurationMs: 1000,
      maxDurationMs: 10000,
    };
    const ok = ListTemplatesOutputSchema.parse({ templates: [t] });
    expect(ok.templates[0]).toMatchObject({ example: {}, aspects: [] });
    const problem = (x: unknown) =>
      ListTemplatesOutputSchema.safeParse(x).error?.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    expect(problem({ templates: [t, t] })).toEqual(['templates.1.id: template title-card is listed twice']);
    expect(problem({ templates: [{ ...t, id: 'Title Card' }] })).toEqual([
      'templates.0.id: template ids are kebab-case, like title-card',
    ]);
    expect(problem({ templates: [{ ...t, params: { type: 'string' } }] })).toEqual([
      'templates.0.params: params is a JSON Schema with "type": "object"',
    ]);
    expect(problem({ templates: [{ ...t, defaultDurationMs: 20000 }] })).toEqual([
      'templates.0.defaultDurationMs: defaultDurationMs is between minDurationMs and maxDurationMs',
    ]);
    expect(problem({ templates: [{ ...t, minDurationMs: 11000 }] })).toEqual([
      'templates.0.minDurationMs: minDurationMs is at most maxDurationMs',
    ]);

    const input = { template: 'title-card', width: 1080, height: 1920, fps: 30 };
    expect(GenerateInputSchema.parse(input)).toEqual({ ...input, params: {} });
    expect(GenerateInputSchema.safeParse({ ...input, width: 1081 }).error?.issues[0]?.message).toBe(
      'sizes are even numbers of pixels',
    );
    expect(GenerateInputSchema.safeParse({ ...input, durationMs: 0 }).success).toBe(false);
    const out = { file: '/tmp/x.mp4', durationMs: 3000, width: 1080, height: 1920, hasAudio: false };
    expect(GenerateOutputSchema.safeParse(out).success).toBe(true);
    expect(GenerateOutputSchema.safeParse({ ...out, file: '' }).success).toBe(false);
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

  test('sound: a prompt for effects and music, text for speech; the file has a length and a license', () => {
    const ok = (a: unknown) => GenerateSoundInputSchema.safeParse(a).success;
    expect(ok({ kind: 'sfx', prompt: 'a door creaks', durationMs: 3000 })).toBe(true);
    expect(ok({ kind: 'music', prompt: 'calm piano', durationMs: 20_000, seed: 7 })).toBe(true);
    expect(ok({ kind: 'speech', text: 'Hello there', language: 'en', voice: 'F1' })).toBe(true);
    expect(ok({ kind: 'sfx', text: 'a door creaks' })).toBe(false); // effects take a prompt
    expect(ok({ kind: 'speech', prompt: 'warmly' })).toBe(false); // speech takes text
    expect(ok({ kind: 'speech', text: '  ' })).toBe(false);
    expect(ok({ kind: 'speech', text: 'Hi', language: 'English' })).toBe(false);
    expect(ok({ kind: 'music', prompt: 'x', durationMs: 0 })).toBe(false);
    expect(ok({ kind: 'noise', prompt: 'x' })).toBe(false);
    const out = {
      file: '/tmp/a.wav',
      durationMs: 3000,
      sampleRate: 44100,
      channels: 2,
      license: 'Apache-2.0',
    };
    expect(GenerateSoundOutputSchema.safeParse(out).success).toBe(true);
    expect(GenerateSoundOutputSchema.safeParse({ ...out, channels: 6 }).success).toBe(false);
    expect(GenerateSoundOutputSchema.safeParse({ ...out, durationMs: 0 }).success).toBe(false);
    expect(GenerateSoundOutputSchema.safeParse({ ...out, license: '' }).success).toBe(false);
    expect(
      ListVoicesOutputSchema.safeParse({
        voices: [{ id: 'F1', name: 'Female 1' }],
        languages: ['en', 'pt-br'],
      }).success,
    ).toBe(true);
    expect(ListVoicesOutputSchema.safeParse({ voices: [{ id: '', name: 'x' }] }).success).toBe(false);
    expect(contractTools(['asset:sound'])).toEqual(['list_voices', 'generate_sound']);
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

describe('asset:footage (BR1-061)', () => {
  const candidate = {
    id: '123',
    kind: 'video' as const,
    width: 1920,
    height: 1080,
    durationMs: 12_000,
    thumbnail: 'https://images.example.com/123.jpg',
    provider: 'Example Stock',
    sourceUrl: 'https://example.com/video/123',
    creator: 'Ana',
    creatorUrl: 'https://example.com/@ana',
    license: 'Example License',
    licenseUrl: 'https://example.com/license',
    attribution: 'Video by Ana on Example Stock',
  };

  test('find_footage and get_footage are the kind’s tools', () => {
    expect(contractTools(['asset:footage'])).toEqual(['find_footage', 'get_footage']);
    expect(CONTRACT_TOOL_NAMES.has('find_footage')).toBe(true);
  });

  test('a bounded search: a query, an optional kind and shape, at most 30 per page', () => {
    expect(
      FindFootageInputSchema.safeParse({
        query: 'hands typing',
        kind: 'video',
        orientation: 'portrait',
        minDurationMs: 4000,
        limit: 10,
      }).success,
    ).toBe(true);
    expect(FindFootageInputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(FindFootageInputSchema.safeParse({ query: 'x', limit: 31 }).success).toBe(false);
    expect(FindFootageInputSchema.safeParse({ query: 'x', page: 0 }).success).toBe(false);
  });

  test('candidates: stills and videos with thumbnail, source page and rights', () => {
    expect(FindFootageOutputSchema.safeParse({ items: [candidate], nextPage: 2 }).success).toBe(true);
    const still = { ...candidate, id: 'p1', kind: 'image', durationMs: undefined };
    expect(FootageCandidateSchema.safeParse(still).success).toBe(true);
    const problems = (x: unknown) =>
      FootageCandidateSchema.safeParse(x).error?.issues.map((i) => i.message) ?? [];
    expect(problems({ ...candidate, durationMs: undefined })).toContain('a video has a durationMs');
    expect(problems({ ...still, durationMs: 3000 })).toContain('a picture has no durationMs');
    expect(problems({ ...candidate, license: undefined }).length).toBeGreaterThan(0);
    expect(problems({ ...candidate, sourceUrl: 'javascript:alert(1)' }).length).toBeGreaterThan(0);
    expect(problems({ ...candidate, thumbnail: 'file:///etc/passwd' }).length).toBeGreaterThan(0);
    expect(problems({ ...candidate, id: '' }).length).toBeGreaterThan(0);
    expect(problems({ ...candidate, width: 0 }).length).toBeGreaterThan(0);
    expect(
      FindFootageOutputSchema.safeParse({ items: Array.from({ length: 31 }, () => candidate) }).success,
    ).toBe(false);
  });

  test('retrieval: a local file with the same provenance and rights', () => {
    const { thumbnail: _t, id: _i, ...rest } = candidate;
    expect(
      GetFootageInputSchema.safeParse({ id: '123', kind: 'video', maxWidth: 1080, maxHeight: 1920 }).success,
    ).toBe(true);
    expect(GetFootageOutputSchema.safeParse({ file: '/tmp/x/123.mp4', ...rest }).success).toBe(true);
    expect(GetFootageOutputSchema.safeParse({ file: '/tmp/x/123.mp4', ...rest, license: '' }).success).toBe(
      false,
    );
    expect(GetFootageOutputSchema.safeParse({ file: '', ...rest }).success).toBe(false);
  });
});
