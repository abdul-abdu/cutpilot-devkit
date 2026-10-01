import { readFileSync } from 'node:fs';
import { KIND_TOOLS } from '@cutpilot/plugin-sdk';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import {
  errorDetail,
  httpFailure,
  keyterms,
  ScribeResponseSchema,
  scribeForm,
  toTranscript,
  toWords,
  type ScribeResponse,
} from './elevenlabs.js';
import { reportedLanguage } from './languages.js';

const recorded = ScribeResponseSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/scribe-en.json', import.meta.url), 'utf8')),
);
const word = (text: string, start: number, end: number, type = 'word') => ({ text, start, end, type });

describe('the answer as CutPilot words', () => {
  test('the recorded answer: no spacing, ms times, punctuation on its word, the laugh as non-speech', () => {
    const t = toTranscript(recorded, 'auto');
    expect(t.language).toBe('en');
    expect(t.words.map((w) => w.text)).toEqual([
      'Um,',
      'so',
      'today',
      'I',
      'want',
      'to',
      'show',
      'you',
      'how',
      'CutPilot',
      'works.',
      '(laughter)',
      'Okay,',
      "let's",
      'go!',
    ]);
    expect(t.words[0]).toEqual({ text: 'Um,', start: 119, end: 459, confidence: Math.exp(-0.21) });
    expect(t.words.find((w) => w.text === '(laughter)')).toEqual({
      text: '(laughter)',
      start: 3199,
      end: 4019,
      event: true,
    });
    // the comma came as its own token; the word keeps its own times
    expect(t.words.find((w) => w.text === 'Okay,')).toMatchObject({ start: 4379, end: 4679 });
    expect(KIND_TOOLS.transcriber.transcribe.output.safeParse(t).success).toBe(true);
  });

  test('opening punctuation joins the word after it; a leading closing mark the first word', () => {
    const words = toWords({
      language_code: 'spa',
      words: [
        word('.', 0, 0),
        word('¿', 0.1, 0.1),
        word('Qué', 0.1, 0.3),
        word('tal', 0.35, 0.5),
        word('?', 0.5, 0.5),
      ],
    });
    expect(words.map((w) => w.text)).toEqual(['.¿Qué', 'tal?']);
  });

  test('tokens without times are left out, an end before its start is moved to the start', () => {
    const words = toWords({
      language_code: 'eng',
      words: [{ text: 'lost', type: 'word' }, word('hi', 1.2, 1.1)],
    });
    expect(words).toEqual([{ text: 'hi', start: 1200, end: 1200 }]);
  });

  test('any answer maps to words the contract accepts', () => {
    const token = fc.record({
      text: fc.oneof(fc.string({ maxLength: 6 }), fc.constantFrom(',', '.', '¿', ' ', '(music)')),
      start: fc.option(fc.double({ min: 0, max: 600, noNaN: true }), { nil: undefined }),
      end: fc.option(fc.double({ min: 0, max: 600, noNaN: true }), { nil: undefined }),
      type: fc.constantFrom('word', 'spacing', 'audio_event'),
      logprob: fc.option(fc.double({ min: -50, max: 0, noNaN: true }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(token, { maxLength: 40 }), (words) => {
        const t = toTranscript({ language_code: 'eng', words } as ScribeResponse, 'en');
        const r = KIND_TOOLS.transcriber.transcribe.output.safeParse(t);
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      }),
    );
  });
});

describe('languages', () => {
  test.each([
    ['eng', 'auto', 'en'],
    ['uzb', 'auto', 'uz'],
    ['rus', 'uz', 'ru'],
    ['cmn', 'auto', 'zh'],
    ['en', 'auto', 'en'],
    ['pt-BR', 'auto', 'pt'],
    ['yue', 'auto', 'yue'],
    ['xyz', 'uz', 'uz'],
    [null, 'auto', 'und'],
  ])('heard %s, asked %s → %s', (heard, asked, want) => {
    expect(reportedLanguage(heard, asked)).toBe(want);
  });
});

describe('the request', () => {
  test('word timestamps, audio events, the language unless auto, key terms', () => {
    const audio = new Blob([new Uint8Array(10)]);
    const f = scribeForm({
      audio,
      filename: 'a.wav',
      model: 'scribe_v2',
      language: 'uz',
      keyterms: ['CutPilot', 'Qaychi'],
    });
    expect(f.get('model_id')).toBe('scribe_v2');
    expect(f.get('timestamps_granularity')).toBe('word');
    expect(f.get('tag_audio_events')).toBe('true');
    expect(f.get('language_code')).toBe('uz');
    expect(f.getAll('keyterms')).toEqual(['CutPilot', 'Qaychi']);
    expect((f.get('file') as File).name).toBe('a.wav');
    const auto = scribeForm({ audio, filename: 'a.wav', model: 'scribe_v2', language: 'auto', keyterms: [] });
    expect(auto.has('language_code')).toBe(false);
    expect(auto.has('keyterms')).toBe(false);
  });

  test('key terms: split on commas, semicolons and lines; trimmed, unique, at most 50 characters and 100 terms', () => {
    expect(keyterms(' CutPilot, Qaychi;\nAbdul ,CutPilot,,')).toEqual(['CutPilot', 'Qaychi', 'Abdul']);
    expect(keyterms('x'.repeat(51))).toEqual([]);
    expect(keyterms(Array.from({ length: 150 }, (_, i) => `t${i}`).join(','))).toHaveLength(100);
    expect(keyterms(undefined)).toEqual([]);
  });
});

describe('errors', () => {
  const body = (status: string, message: string) => JSON.stringify({ detail: { status, message } });

  test('each HTTP error says what to do', () => {
    const cases: [number, string, string][] = [
      [401, body('invalid_api_key', 'Invalid API key'), 'E_CLOUD_TRANSCRIBE_BAD_KEY'],
      [401, body('quota_exceeded', 'This request exceeds your quota.'), 'E_CLOUD_TRANSCRIBE_QUOTA'],
      [402, '{}', 'E_CLOUD_TRANSCRIBE_QUOTA'],
      [413, 'Payload Too Large', 'E_CLOUD_TRANSCRIBE_TOO_LARGE'],
      [
        400,
        body('invalid_file', 'Audio duration exceeds the maximum of 10 hours'),
        'E_CLOUD_TRANSCRIBE_TOO_LARGE',
      ],
      [429, body('system_busy', 'busy'), 'E_CLOUD_TRANSCRIBE_BUSY'],
      [503, '<html>bad gateway</html>', 'E_CLOUD_TRANSCRIBE_UNAVAILABLE'],
      [
        422,
        JSON.stringify({ detail: [{ loc: ['body', 'model_id'], msg: 'invalid model' }] }),
        'E_CLOUD_TRANSCRIBE_REJECTED',
      ],
    ];
    for (const [status, b, code] of cases) {
      const f = httpFailure(status, b);
      expect(f.code, `${status} ${b}`).toBe(code);
      expect(f.message).not.toMatch(/\n/);
      expect(f.fix.length).toBeGreaterThan(10);
    }
    expect(httpFailure(401, body('invalid_api_key', 'Invalid API key')).message).toBe(
      'ElevenLabs refused the API key: Invalid API key',
    );
    expect(
      httpFailure(422, JSON.stringify({ detail: [{ loc: ['body', 'model_id'], msg: 'bad' }] })).message,
    ).toBe('ElevenLabs rejected the request (HTTP 422): model_id: bad');
  });

  test('error bodies of every shape become one short line', () => {
    expect(errorDetail('{"detail":"Not found"}')).toEqual({ status: '', message: 'Not found' });
    expect(errorDetail('line one\nline two')).toEqual({ status: '', message: 'line one line two' });
    expect(errorDetail('x'.repeat(500)).message).toHaveLength(200);
  });
});
