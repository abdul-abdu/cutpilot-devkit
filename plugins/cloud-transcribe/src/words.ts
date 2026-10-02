/**
 * From a provider's answer to CutPilot's words: integer milliseconds, punctuation on the word
 * it belongs to, non-speech events marked, times in order. Pure functions, no network.
 */
import { z } from 'zod';

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  event?: boolean;
}

/** a token that is punctuation only, like `,` or `?!` or `»` */
const PUNCT_ONLY = /^[\p{P}\p{S}]+$/u;
/** punctuation that opens: it goes on the next word */
const OPENING = /^[([{«“‘„‚¿¡"'‹]+$/u;

const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

/**
 * Put punctuation-only tokens on their neighbours: a closing mark on the word before it, an
 * opening one on the word after it. An event (laughter) never takes punctuation.
 */
export function attachPunctuation(tokens: readonly Word[]): Word[] {
  const out: Word[] = [];
  let pending = ''; // opening marks waiting for the next word
  for (const t of tokens) {
    const text = t.text.trim();
    if (!text) continue;
    if (!t.event && PUNCT_ONLY.test(text)) {
      const prev = out.findLast((w) => !w.event);
      if (OPENING.test(text) || !prev) pending += text;
      else {
        prev.text += text;
        // it stretches the word only when nothing came between them
        if (prev === out.at(-1)) prev.end = Math.max(prev.end, t.end);
      }
      continue;
    }
    out.push({ ...t, text: t.event ? text : pending + text });
    if (!t.event) pending = '';
  }
  // opening marks at the very end have no word to go on
  if (pending) {
    const prev = out.findLast((w) => !w.event);
    if (prev) prev.text += pending;
  }
  return out;
}

/** Times as the contract wants them: starts never go back, an end is never before its start. */
export function tidyTimes(words: readonly Word[]): Word[] {
  let last = 0;
  return words.map((w) => {
    const start = Math.max(w.start, last);
    last = start;
    return { ...w, start, end: Math.max(w.end, start) };
  });
}

/** exp(logprob), within 0..1; undefined without one */
export const confidenceOf = (logprob: number | null | undefined) =>
  typeof logprob === 'number' && Number.isFinite(logprob)
    ? Math.round(Math.min(1, Math.max(0, Math.exp(logprob))) * 1000) / 1000
    : undefined;

// ── ElevenLabs Scribe ────────────────────────────────────────────────────────

export const ElevenLabsResponseSchema = z.object({
  language_code: z.string().nullish(),
  text: z.string().nullish(),
  words: z.array(
    z.object({
      text: z.string(),
      start: z.number().nullish(),
      end: z.number().nullish(),
      type: z.string(),
      logprob: z.number().nullish(),
    }),
  ),
});
export type ElevenLabsResponse = z.infer<typeof ElevenLabsResponseSchema>;

export function fromElevenLabs(r: ElevenLabsResponse): Word[] {
  const tokens: Word[] = [];
  for (const w of r.words) {
    if (w.type === 'spacing') continue;
    if (w.type !== 'word' && w.type !== 'audio_event') continue;
    const start = ms(w.start ?? 0);
    const confidence = w.type === 'word' ? confidenceOf(w.logprob) : undefined;
    tokens.push({
      text: w.text,
      start,
      end: ms(w.end ?? w.start ?? 0),
      ...(confidence !== undefined ? { confidence } : {}),
      ...(w.type === 'audio_event' ? { event: true } : {}),
    });
  }
  return tidyTimes(attachPunctuation(tokens));
}

// ── OpenAI whisper-1 ─────────────────────────────────────────────────────────

export const OpenAIResponseSchema = z.object({
  language: z.string().nullish(),
  text: z.string().nullish(),
  words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).nullish(),
});
export type OpenAIResponse = z.infer<typeof OpenAIResponseSchema>;

const leadingPunct = (s: string) => /^[\p{P}\p{S}]*/u.exec(s)![0];
const trailingPunct = (s: string) => /[\p{P}\p{S}]*$/u.exec(s)![0];

/**
 * whisper-1's timed words come without punctuation; the full text has it. Find each word in
 * the text in order, and give it the marks right after it (up to the next space) and the
 * marks right before it (back to the previous space). A word the text doesn't have stays as
 * it is.
 */
export function punctuateFromText(
  words: readonly { word: string; start: number; end: number }[],
  text: string,
) {
  const lower = text.toLowerCase();
  let cursor = 0;
  const spans = words.map((w) => {
    const needle = w.word.trim().toLowerCase();
    const at = needle ? lower.indexOf(needle, cursor) : -1;
    // a word far ahead is more likely a different occurrence: accept it only within reach
    if (at < 0 || at - cursor > 80) return null;
    cursor = at + needle.length;
    return [at, cursor] as const;
  });
  return words.map((w, i) => {
    const span = spans[i];
    let out = w.word.trim();
    if (span) {
      const prevEnd = spans.slice(0, i).findLast((s) => s)?.[1] ?? 0;
      const nextStart = spans.slice(i + 1).find((s) => s)?.[0] ?? text.length;
      const before = text.slice(prevEnd, span[0]);
      const after = text.slice(span[1], nextStart);
      // marks after the last space before the word; marks before the first space after it
      const lead = /\s/.test(before) || i === 0 ? trailingPunct(before.split(/\s/).at(-1)!) : '';
      const trail = leadingPunct(after.split(/\s/)[0]!);
      out = lead + text.slice(span[0], span[1]) + trail;
    }
    return { text: out, start: ms(w.start), end: ms(w.end) };
  });
}

export function fromOpenAI(r: OpenAIResponse): Word[] {
  const words = r.words ?? [];
  return tidyTimes(punctuateFromText(words, r.text ?? '').filter((w) => w.text.trim()));
}
