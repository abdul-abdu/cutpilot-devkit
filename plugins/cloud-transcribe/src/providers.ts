/**
 * The two providers: how to send them the audio, how to check a key, and what their errors
 * mean. Each request goes through `fetch` (injectable for tests) and every failure becomes a
 * PluginFailure with a fix the user or their AI can act on.
 */
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { PluginFailure } from '@cutpilot/plugin-sdk';
import { toIso1 } from './languages.js';
import {
  ElevenLabsResponseSchema,
  fromElevenLabs,
  fromOpenAI,
  OpenAIResponseSchema,
  type Word,
} from './words.js';

export const PROVIDERS = ['elevenlabs', 'openai'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export interface Provider {
  id: ProviderId;
  name: string;
  secret: string;
  origin: string;
  /** the largest file it takes, in bytes */
  maxBytes: number;
  /** the longest audio it takes, in ms, when shorter than maxBytes of CutPilot's wav */
  maxMs?: number;
  /** where the user gets a key */
  keysUrl: string;
}

const MB = 1024 * 1024;

export const PROVIDER: Record<ProviderId, Provider> = {
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    secret: 'ELEVENLABS_API_KEY',
    origin: 'https://api.elevenlabs.io',
    maxBytes: 3 * 1024 * MB,
    maxMs: 10 * 3600 * 1000,
    keysUrl: 'elevenlabs.io/app/settings/api-keys',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    secret: 'OPENAI_API_KEY',
    origin: 'https://api.openai.com',
    maxBytes: 25 * MB,
    keysUrl: 'platform.openai.com/api-keys',
  },
};

/** Where the user enters keys and picks the provider. */
export const KEYS_PLACE = 'CutPilot → Plugins → Cloud transcription → Keys';
export const SETTINGS_PLACE = 'CutPilot → Plugins → Cloud transcription → Settings';

export interface Transport {
  fetch: typeof fetch;
  /** every request goes to this origin instead of the provider's (tests) */
  origin?: string;
  signal?: AbortSignal;
}

export interface Transcript {
  language: string;
  words: Word[];
}

/** CutPilot's wav: 16 kHz mono 16-bit, so 32,000 bytes a second after a 44-byte header. */
export const WAV_BYTES_PER_SECOND = 32_000;
export const wavMs = (bytes: number) => Math.round((Math.max(0, bytes - 44) / WAV_BYTES_PER_SECOND) * 1000);

/** Scribe's model when the setting is blank. */
export const DEFAULT_SCRIBE_MODEL = 'scribe_v1';

/**
 * The project's expected words (`prompt`: names, jargon, separated by commas, semicolons or
 * lines) as Scribe key terms: each at most 50 characters, at most 100, no repeats.
 */
export function keyterms(prompt: string | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of (prompt ?? '').split(/[,;\n]+/)) {
    const term = raw.trim();
    if (term && term.length <= 50) seen.add(term);
    if (seen.size === 100) break;
  }
  return [...seen];
}

const firstLine = (s: string) => s.split(/\r?\n/)[0]!.trim().slice(0, 300);

export function missingKey(p: Provider): PluginFailure {
  const other = PROVIDER[p.id === 'elevenlabs' ? 'openai' : 'elevenlabs'];
  return new PluginFailure(
    'E_PLUGIN_NEEDS_SECRET',
    `no ${p.name} API key yet (${p.secret})`,
    `get one at ${p.keysUrl} and enter it as ${p.secret} in ${KEYS_PLACE}, or set Provider to ${other.name} in ${SETTINGS_PLACE}`,
  );
}

/** What a provider said went wrong, from its JSON error body (or the raw text). */
export function providerMessage(body: string): { message: string; status?: string } {
  try {
    const j = JSON.parse(body) as Record<string, unknown>;
    // ElevenLabs: { detail: { status, message } } or { detail: "…" }; OpenAI: { error: { message, code, type } }
    const detail = j.detail as Record<string, unknown> | string | undefined;
    if (typeof detail === 'string') return { message: detail };
    // a validation error: { detail: [{ loc, msg }] }
    if (Array.isArray(detail))
      return { message: detail.map((d: { msg?: string }) => d?.msg ?? JSON.stringify(d)).join('; ') };
    if (detail && typeof detail === 'object')
      return {
        message: String(detail.message ?? JSON.stringify(detail)),
        status: detail.status ? String(detail.status) : undefined,
      };
    const error = j.error as Record<string, unknown> | string | undefined;
    if (typeof error === 'string') return { message: error };
    if (error && typeof error === 'object')
      return {
        message: String(error.message ?? JSON.stringify(error)),
        status: String(error.code ?? error.type ?? '') || undefined,
      };
    return { message: body };
  } catch {
    return { message: body };
  }
}

const QUOTA = /quota|billing|credits|payment/i;

/** An HTTP error from a provider as a failure with a fix. */
export function httpFailure(p: Provider, status: number, body: string): PluginFailure {
  const { message, status: code } = providerMessage(body);
  const said = firstLine(message) || `HTTP ${status}`;
  const quota = QUOTA.test(code ?? '') || QUOTA.test(said);
  if (status === 413) return tooLarge(p, `${p.name} refused the file as too large (${said})`);
  if (quota || status === 402)
    return new PluginFailure(
      'E_STT_QUOTA',
      `${p.name}: the account is out of credits or quota (${said})`,
      `add credits or upgrade the plan at ${p.id === 'openai' ? 'platform.openai.com/settings/organization/billing' : 'elevenlabs.io/app/subscription'}, or switch Provider in ${SETTINGS_PLACE}`,
    );
  if (status === 429)
    return new PluginFailure(
      'E_STT_RATE_LIMITED',
      `${p.name} is limiting requests right now (${said})`,
      'wait a minute and transcribe again',
    );
  if (status === 401 || status === 403)
    return new PluginFailure(
      'E_STT_BAD_KEY',
      `${p.name} didn't accept the API key (${said})`,
      `check ${p.secret} in ${KEYS_PLACE} (make a new key at ${p.keysUrl}); a restricted key needs speech-to-text access`,
    );
  return new PluginFailure(
    'E_STT_PROVIDER',
    `${p.name} answered HTTP ${status}: ${said}`,
    status >= 500
      ? `${p.name} has a problem on its side; try again in a few minutes`
      : `if the message doesn't say what to change, transcribe with another provider or the local transcriber`,
  );
}

function tooLarge(p: Provider, message: string): PluginFailure {
  return new PluginFailure(
    'E_STT_FILE_TOO_LARGE',
    message,
    p.id === 'openai'
      ? `OpenAI takes up to 25 MB, about 13 minutes of CutPilot's audio: set Provider to ElevenLabs in ${SETTINGS_PLACE}, or transcribe a shorter clip`
      : `transcribe a shorter clip, or use the local transcriber`,
  );
}

async function send(p: Provider, t: Transport, path: string, init: RequestInit): Promise<Response> {
  const url = `${t.origin ?? p.origin}${path}`;
  try {
    return await t.fetch(url, { ...init, signal: t.signal });
  } catch (e) {
    const err = e as Error & { cause?: { code?: string; message?: string } };
    if (err.name === 'AbortError' || t.signal?.aborted)
      throw new PluginFailure(
        'E_STT_CANCELLED',
        'the transcription was cancelled',
        'start it again when you want it',
      );
    const why = err.cause?.code ?? err.cause?.message ?? err.message;
    throw new PluginFailure(
      'E_STT_NETWORK',
      `couldn't reach ${new URL(url).host} (${firstLine(String(why))})`,
      `check the internet connection (and a proxy or firewall that may block ${new URL(p.origin).host}), then try again`,
    );
  }
}

async function json(p: Provider, res: Response): Promise<unknown> {
  const body = await res.text();
  if (!res.ok) throw httpFailure(p, res.status, body);
  try {
    return JSON.parse(body);
  } catch {
    throw badResponse(p, `not JSON: ${firstLine(body).slice(0, 80)}`);
  }
}

const badResponse = (p: Provider, why: string) =>
  new PluginFailure(
    'E_STT_BAD_RESPONSE',
    `${p.name} answered with something this plugin can't read (${why})`,
    'update the Cloud transcription plugin; if it keeps happening, report it to its publisher',
  );

export interface TranscribeRequest {
  audio: string;
  language: string;
  prompt?: string;
}

/** The ElevenLabs settings: the Scribe model, and whether the prompt goes as key terms. */
export interface ScribeOptions {
  model?: string;
  keyterms?: boolean;
}

/** Upload the audio to the provider and map its words. */
export async function transcribeWith(
  p: Provider,
  key: string,
  req: TranscribeRequest,
  t: Transport,
  scribe: ScribeOptions = {},
): Promise<Transcript> {
  let size: number;
  try {
    size = statSync(req.audio).size;
  } catch (e) {
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `can't read the audio ${req.audio}: ${(e as Error).message}`,
      'CutPilot passes a wav it made; try again, and update CutPilot if it keeps failing',
    );
  }
  if (size > p.maxBytes)
    throw tooLarge(
      p,
      `the audio is ${Math.round(size / MB)} MB; ${p.name} takes up to ${Math.round(p.maxBytes / MB)} MB`,
    );
  if (p.maxMs && wavMs(size) > p.maxMs)
    throw tooLarge(
      p,
      `the audio is ${(wavMs(size) / 3_600_000).toFixed(1)} h long; ${p.name} takes up to ${p.maxMs / 3_600_000} h`,
    );

  const form = new FormData();
  form.append('file', await openAsBlob(req.audio, { type: 'audio/wav' }), basename(req.audio));
  const hint = req.language === 'auto' ? null : req.language;

  if (p.id === 'elevenlabs') {
    form.append('model_id', scribe.model?.trim() || DEFAULT_SCRIBE_MODEL);
    if (hint) form.append('language_code', hint);
    form.append('timestamps_granularity', 'word');
    form.append('tag_audio_events', 'true');
    if (scribe.keyterms) for (const k of keyterms(req.prompt)) form.append('keyterms', k);
    const res = await send(p, t, '/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    });
    const r = ElevenLabsResponseSchema.safeParse(await json(p, res));
    if (!r.success) throw badResponse(p, r.error.issues[0]?.message ?? 'unexpected shape');
    return { language: toIso1(r.data.language_code) ?? hint ?? 'und', words: fromElevenLabs(r.data) };
  }

  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (hint) form.append('language', hint);
  if (req.prompt) form.append('prompt', req.prompt);
  const res = await send(p, t, '/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}` },
    body: form,
  });
  const r = OpenAIResponseSchema.safeParse(await json(p, res));
  if (!r.success) throw badResponse(p, r.error.issues[0]?.message ?? 'unexpected shape');
  return { language: toIso1(r.data.language) ?? hint ?? 'und', words: fromOpenAI(r.data) };
}

export interface KeyCheck {
  ok: boolean;
  provider: string;
  message: string;
  fix?: string;
}

/** A cheap authenticated request: is the key good? */
export async function checkKey(p: Provider, key: string | undefined, t: Transport): Promise<KeyCheck> {
  const result = (f: PluginFailure): KeyCheck => ({
    ok: false,
    provider: p.name,
    message: f.message,
    fix: f.fix,
  });
  if (!key) return result(missingKey(p));
  try {
    const res =
      p.id === 'elevenlabs'
        ? await send(p, t, '/v1/user', { headers: { 'xi-api-key': key } })
        : await send(p, t, '/v1/models', { headers: { authorization: `Bearer ${key}` } });
    const body = await res.text();
    if (res.ok) return { ok: true, provider: p.name, message: `${p.name} accepted the key` };
    // a restricted ElevenLabs key may not read the account, and still transcribe
    if (p.id === 'elevenlabs' && providerMessage(body).status === 'missing_permissions')
      return {
        ok: true,
        provider: p.name,
        message: `${p.name} accepted the key (it can't read account details, which transcription doesn't need)`,
      };
    return result(httpFailure(p, res.status, body));
  } catch (e) {
    if (e instanceof PluginFailure) return result(e);
    throw e;
  }
}
