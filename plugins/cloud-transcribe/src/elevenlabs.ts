/**
 * ElevenLabs Scribe: the request (`POST /v1/speech-to-text`, multipart, the key in `xi-api-key`),
 * the answer mapped to CutPilot's transcriber contract, and its HTTP errors as PluginFailures.
 */
import { PluginFailure } from '@cutpilot/plugin-sdk';
import { z } from 'zod';
import { reportedLanguage } from './languages.js';

export const SCRIBE_URL = 'https://api.elevenlabs.io/v1/speech-to-text';
export const DEFAULT_MODEL = 'scribe_v2';

/** What ElevenLabs takes: 10 hours of audio; a 16 kHz mono 16-bit wav is 32,000 bytes a second. */
export const MAX_AUDIO_MS = 10 * 3600 * 1000;
export const WAV_BYTES_PER_SECOND = 32_000;

const SETTINGS = 'CutPilot → Plugins → Cloud Transcribe';

// only what the mapping reads; ElevenLabs adds fields (speaker_id, characters, …) freely
const ScribeWordSchema = z.object({
  text: z.string(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  /** word, spacing or audio_event */
  type: z.string(),
  logprob: z.number().nullish(),
});
export const ScribeResponseSchema = z.object({
  language_code: z.string().nullish(),
  words: z.array(ScribeWordSchema),
});
export type ScribeResponse = z.infer<typeof ScribeResponseSchema>;

export interface Word {
  text: string;
  start: number;
  end: number;
  confidence?: number;
  event?: boolean;
}

const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;
/** punctuation that belongs to the word after it */
const OPENING = /^[¿¡«“‘„([{]+$/u;

const ms = (seconds: number) => Math.max(0, Math.round(seconds * 1000));

/**
 * Scribe's tokens → CutPilot's words. Spacing goes; times become integer ms; punctuation that
 * comes as its own token joins its word (`Hello` `,` → `Hello,`, `¿` `Qué` → `¿Qué`) without
 * moving the word's times; audio events like `(laughter)` stay, marked as non-speech; logprob
 * becomes a 0..1 confidence. Words are returned in time order.
 */
export function toWords(res: ScribeResponse): Word[] {
  const out: Word[] = [];
  let prefix = '';
  let lastSpoken: Word | undefined;
  for (const t of res.words) {
    if (t.type === 'spacing') continue;
    const text = t.text.trim();
    if (!text) continue;
    if (t.type !== 'audio_event' && PUNCTUATION_ONLY.test(text)) {
      if (OPENING.test(text) || !lastSpoken) prefix += text;
      else lastSpoken.text += text;
      continue;
    }
    if (t.start == null || t.end == null) continue;
    const start = ms(t.start);
    const word: Word = { text, start, end: Math.max(start, ms(t.end)) };
    if (t.type === 'audio_event') {
      word.event = true;
      out.push(word);
      continue;
    }
    word.text = prefix + text;
    prefix = '';
    if (t.logprob != null && Number.isFinite(t.logprob))
      word.confidence = Math.min(1, Math.max(0, Math.exp(t.logprob)));
    out.push(word);
    lastSpoken = word;
  }
  if (prefix && lastSpoken) lastSpoken.text += prefix;
  return out.sort((a, b) => a.start - b.start);
}

export function toTranscript(res: ScribeResponse, asked: string): { language: string; words: Word[] } {
  return { language: reportedLanguage(res.language_code, asked), words: toWords(res) };
}

/** The project's expected words (`prompt`: names, jargon) as Scribe key terms: at most 100, 50 characters each. */
export function keyterms(prompt: string | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of (prompt ?? '').split(/[,;\n]+/)) {
    const term = raw.trim();
    if (term && term.length <= 50) seen.add(term);
    if (seen.size === 100) break;
  }
  return [...seen];
}

export interface ScribeRequest {
  audio: Blob;
  filename: string;
  model: string;
  /** ISO 639-1 or `auto` */
  language: string;
  keyterms: string[];
}

export function scribeForm(r: ScribeRequest): FormData {
  const form = new FormData();
  form.set('model_id', r.model);
  form.set('file', r.audio, r.filename);
  form.set('timestamps_granularity', 'word');
  form.set('tag_audio_events', 'true');
  form.set('diarize', 'false');
  if (r.language !== 'auto') form.set('language_code', r.language);
  for (const k of r.keyterms) form.append('keyterms', k);
  return form;
}

const oneLine = (s: string, max = 200) => {
  const line = s.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** ElevenLabs' error body: `{ detail: { status, message } }`, `{ detail: "…" }` or a validation list. */
export function errorDetail(body: string): { status: string; message: string } {
  let detail: unknown;
  try {
    detail = (JSON.parse(body) as { detail?: unknown }).detail;
  } catch {
    return { status: '', message: oneLine(body) };
  }
  if (typeof detail === 'string') return { status: '', message: oneLine(detail) };
  if (Array.isArray(detail))
    return {
      status: 'validation_error',
      message: oneLine(
        detail
          .map((d: { loc?: unknown[]; msg?: string }) =>
            [d.loc?.slice(1).join('.'), d.msg].filter(Boolean).join(': '),
          )
          .join('; '),
      ),
    };
  const d = (detail ?? {}) as { status?: unknown; message?: unknown };
  return {
    status: typeof d.status === 'string' ? d.status : '',
    message: oneLine(typeof d.message === 'string' ? d.message : body),
  };
}

const TOO_LARGE_FIX = 'cut the video shorter, or transcribe it on this computer with whisper';

/** An HTTP error from ElevenLabs as a failure the user (or their AI) can act on. */
export function httpFailure(status: number, body: string): PluginFailure {
  const d = errorDetail(body);
  const said = d.message ? `: ${d.message}` : '';
  if (d.status === 'quota_exceeded' || status === 402 || d.status === 'payment_required')
    return new PluginFailure(
      'E_CLOUD_TRANSCRIBE_QUOTA',
      `your ElevenLabs credits are used up${said}`,
      'add credits or upgrade at elevenlabs.io, or transcribe on this computer with whisper',
    );
  if (status === 401 || status === 403)
    return new PluginFailure(
      'E_CLOUD_TRANSCRIBE_BAD_KEY',
      `ElevenLabs refused the API key${said}`,
      `check ELEVENLABS_API_KEY in ${SETTINGS}; the key needs speech-to-text access`,
    );
  if (status === 413 || /too (large|long)|exceeds|maximum (file|duration)/i.test(d.message))
    return new PluginFailure(
      'E_CLOUD_TRANSCRIBE_TOO_LARGE',
      `ElevenLabs won't take audio this long${said}`,
      TOO_LARGE_FIX,
    );
  if (status === 429)
    return new PluginFailure(
      'E_CLOUD_TRANSCRIBE_BUSY',
      `ElevenLabs is busy or limiting requests${said}`,
      'wait a minute and try again',
    );
  if (status >= 500)
    return new PluginFailure(
      'E_CLOUD_TRANSCRIBE_UNAVAILABLE',
      `ElevenLabs failed (HTTP ${status})${said}`,
      'try again in a few minutes, or transcribe on this computer with whisper',
    );
  return new PluginFailure(
    'E_CLOUD_TRANSCRIBE_REJECTED',
    `ElevenLabs rejected the request (HTTP ${status})${said}`,
    `try the language "auto", or check the model in ${SETTINGS} (default ${DEFAULT_MODEL})`,
  );
}

export function tooLong(audioMs: number): PluginFailure {
  const hours = (audioMs / 3_600_000).toFixed(1);
  return new PluginFailure(
    'E_CLOUD_TRANSCRIBE_TOO_LARGE',
    `the audio is ${hours} h long; ElevenLabs takes at most ${MAX_AUDIO_MS / 3_600_000} h`,
    TOO_LARGE_FIX,
  );
}

export function networkFailure(e: unknown): PluginFailure {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  const why = err.cause?.code ?? err.cause?.message ?? err.message ?? String(e);
  return new PluginFailure(
    'E_CLOUD_TRANSCRIBE_NETWORK',
    `can't reach api.elevenlabs.io: ${oneLine(why)}`,
    'check the internet connection (and any proxy or firewall), then try again',
  );
}
