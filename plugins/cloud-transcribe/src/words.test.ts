import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscribeOutputSchema } from '@nodcut/plugin-sdk';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { toIso1 } from './languages.js';
import {
  attachPunctuation,
  confidenceOf,
  ElevenLabsResponseSchema,
  fromElevenLabs,
  fromOpenAI,
  OpenAIResponseSchema,
  punctuateFromText,
  tidyTimes,
  type Word,
} from './words.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

describe('ElevenLabs Scribe (recorded response)', () => {
  const words = fromElevenLabs(ElevenLabsResponseSchema.parse(fixture('elevenlabs.json')));

  test('spacing dropped, punctuation on the words, the laugh an event', () => {
    expect(words.map((w) => w.text)).toEqual([
      'Hello,',
      'everyone.',
      '(laughs)',
      'Welcome',
      'back',
      'to',
      'the',
      'channel!',
      'Today:',
      '"three"',
      'quick',
      'tips.',
    ]);
    expect(words.filter((w) => w.event).map((w) => w.text)).toEqual(['(laughs)']);
    expect(words[2]).not.toHaveProperty('confidence');
  });

  test('integer milliseconds; a mark stretches its word; confidence from logprob', () => {
    expect(words[0]).toEqual({ text: 'Hello,', start: 119, end: 519, confidence: 0.96 });
    expect(words[2]).toEqual({ text: '(laughs)', start: 1299, end: 2059, event: true });
    expect(words[7]).toMatchObject({ text: 'channel!', start: 3039, end: 3499 });
    expect(words[9]).toMatchObject({ text: '"three"', start: 4579, end: 4899 });
    for (const w of words) {
      expect(Number.isInteger(w.start) && Number.isInteger(w.end)).toBe(true);
      expect(w.end).toBeGreaterThanOrEqual(w.start);
    }
  });

  test('passes the transcribe contract', () => {
    expect(TranscribeOutputSchema.safeParse({ language: 'en', words }).success).toBe(true);
  });
});

describe('OpenAI whisper-1 (recorded response)', () => {
  const r = OpenAIResponseSchema.parse(fixture('openai.json'));
  const words = fromOpenAI(r);

  test('punctuation from the text goes back on the words', () => {
    expect(words.map((w) => w.text)).toEqual([
      'Hello,',
      'everyone.',
      'Welcome',
      'back',
      'to',
      'the',
      'channel!',
      'Today:',
      '"three"',
      'quick',
      'tips',
      "it's",
      'well-',
      'known',
      'stuff.',
    ]);
  });

  test('integer milliseconds, no events, no confidence; passes the contract', () => {
    expect(words[0]).toEqual({ text: 'Hello,', start: 0, end: 500 });
    expect(words[2]).toEqual({ text: 'Welcome', start: 2180, end: 2540 });
    expect(TranscribeOutputSchema.safeParse({ language: toIso1(r.language), words }).success).toBe(true);
  });

  test('a word the text lacks stays as it is; the rest still match', () => {
    const out = punctuateFromText(
      [
        { word: 'Hi', start: 0, end: 0.2 },
        { word: 'zzz', start: 0.2, end: 0.3 },
        { word: 'there', start: 0.3, end: 0.6 },
      ],
      'Hi, there?',
    );
    expect(out.map((w) => w.text)).toEqual(['Hi,', 'zzz', 'there?']);
  });

  test('a repeated word is matched in order', () => {
    const out = punctuateFromText(
      [
        { word: 'no', start: 0, end: 0.2 },
        { word: 'no', start: 0.2, end: 0.4 },
        { word: 'NO', start: 0.4, end: 0.6 },
      ],
      'No, no. NO!',
    );
    expect(out.map((w) => w.text)).toEqual(['No,', 'no.', 'NO!']);
  });

  test('Cyrillic and a quote that opens the text', () => {
    const out = punctuateFromText(
      [
        { word: 'Привет', start: 0, end: 0.4 },
        { word: 'мир', start: 0.4, end: 0.8 },
      ],
      '«Привет, мир»!',
    );
    expect(out.map((w) => w.text)).toEqual(['«Привет,', 'мир»!']);
  });
});

describe('attachPunctuation', () => {
  const w = (text: string, start: number, end: number, event?: boolean): Word => ({
    text,
    start,
    end,
    ...(event ? { event } : {}),
  });

  test('a closing mark joins the word before, an opening one the word after', () => {
    expect(
      attachPunctuation([w('Wait', 0, 100), w('?!', 100, 120), w('¿', 130, 130), w('Qué', 130, 300)]),
    ).toEqual([w('Wait?!', 0, 120), w('¿Qué', 130, 300)]);
  });

  test('after an event the mark still goes on the last word, which keeps its end', () => {
    expect(attachPunctuation([w('So', 0, 100), w('(laughs)', 100, 900, true), w('.', 900, 910)])).toEqual([
      w('So.', 0, 100),
      w('(laughs)', 100, 900, true),
    ]);
  });

  test('a mark with no word before goes on the next; blank tokens are dropped', () => {
    expect(attachPunctuation([w('—', 0, 0), w(' ', 0, 10), w('Yes', 10, 200)])).toEqual([w('—Yes', 10, 200)]);
  });
});

describe('tidyTimes', () => {
  test('starts never go back and ends never come before starts', () => {
    expect(
      tidyTimes([
        { text: 'a', start: 100, end: 50 },
        { text: 'b', start: 90, end: 200 },
      ]),
    ).toEqual([
      { text: 'a', start: 100, end: 100 },
      { text: 'b', start: 100, end: 200 },
    ]);
  });

  test('property: any provider output becomes contract-valid words', () => {
    const token = fc.record({
      text: fc.oneof(
        fc.constantFrom(' ', ',', '.', '"', '¿', '(applause)'),
        fc.string({ minLength: 1, maxLength: 8 }),
      ),
      start: fc.double({ min: 0, max: 100, noNaN: true }),
      end: fc.double({ min: 0, max: 100, noNaN: true }),
      type: fc.constantFrom('word', 'spacing', 'audio_event'),
      logprob: fc.option(fc.double({ min: -20, max: 0, noNaN: true }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.array(token, { maxLength: 40 }), (ws) => {
        const words = fromElevenLabs({ language_code: 'en', text: '', words: ws });
        const r = TranscribeOutputSchema.safeParse({ language: 'en', words });
        expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
      }),
    );
  });
});

describe('languages and confidence', () => {
  test('names, ISO 639-3 and tags become ISO 639-1', () => {
    expect(toIso1('english')).toBe('en');
    expect(toIso1('Russian')).toBe('ru');
    expect(toIso1('uzbek')).toBe('uz');
    expect(toIso1('eng')).toBe('en');
    expect(toIso1('rus')).toBe('ru');
    expect(toIso1('uzb')).toBe('uz');
    expect(toIso1('cmn')).toBe('zh');
    expect(toIso1('en')).toBe('en');
    expect(toIso1('pt-BR')).toBe('pt');
    expect(toIso1('yue')).toBe('yue');
    expect(toIso1('klingon')).toBeNull();
    expect(toIso1(null)).toBeNull();
  });

  test('confidence is exp(logprob) within 0..1', () => {
    expect(confidenceOf(0)).toBe(1);
    expect(confidenceOf(Math.log(0.5))).toBe(0.5);
    expect(confidenceOf(3)).toBe(1);
    expect(confidenceOf(undefined)).toBeUndefined();
  });
});
