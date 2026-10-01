/**
 * The plugin: a `transcriber`. transcribe uploads the engine's 16 kHz wav to ElevenLabs Scribe
 * with the user's key and the project's language (or none, for auto), and maps the answer to
 * timed words. Nothing is kept on disk; the key goes only to api.elevenlabs.io.
 */
import { openAsBlob, statSync } from 'node:fs';
import { basename } from 'node:path';
import { PluginFailure, type PluginDefinition } from '@cutpilot/plugin-sdk';
import {
  DEFAULT_MODEL,
  httpFailure,
  keyterms,
  MAX_AUDIO_MS,
  networkFailure,
  SCRIBE_URL,
  ScribeResponseSchema,
  scribeForm,
  toTranscript,
  tooLong,
  WAV_BYTES_PER_SECOND,
} from './elevenlabs.js';

export const SECRET = 'ELEVENLABS_API_KEY';

export interface Options {
  /** default: the global fetch (tests pass a recorded one) */
  fetch?: typeof fetch;
  url?: string;
}

const cancelled = () =>
  new PluginFailure(
    'E_CLOUD_TRANSCRIBE_CANCELLED',
    'the transcription was cancelled',
    'start it again when you want the transcript',
  );

export function cloudTranscribe(opts: Options = {}): PluginDefinition {
  const send = opts.fetch ?? fetch;
  const url = opts.url ?? SCRIBE_URL;
  return {
    async transcribe(input, ctx) {
      const key = ctx.requireSecret(SECRET);
      let bytes: number;
      try {
        bytes = statSync(input.audio).size;
      } catch {
        throw new PluginFailure(
          'E_PLUGIN_BAD_INPUT',
          `the audio ${input.audio} doesn't exist`,
          'CutPilot makes the audio before it calls transcribe; open the video again',
        );
      }
      const audioMs = Math.round((Math.max(0, bytes - 44) / WAV_BYTES_PER_SECOND) * 1000);
      if (audioMs > MAX_AUDIO_MS) throw tooLong(audioMs);

      const model = String(ctx.settings.model || DEFAULT_MODEL);
      const terms = ctx.settings.keyterms === false ? [] : keyterms(input.prompt);
      const form = scribeForm({
        audio: await openAsBlob(input.audio, { type: 'audio/wav' }),
        filename: basename(input.audio),
        model,
        language: input.language,
        keyterms: terms,
      });
      ctx.log(
        `uploading ${(bytes / 1e6).toFixed(1)} MB (${Math.round(audioMs / 1000)} s) to ElevenLabs, ` +
          `model ${model}, language ${input.language}, ${terms.length} key terms`,
      );
      ctx.progress(0, 'uploading to ElevenLabs');

      let res: Response;
      try {
        res = await send(url, {
          method: 'POST',
          headers: { 'xi-api-key': key, accept: 'application/json' },
          body: form,
          signal: ctx.signal,
        });
      } catch (e) {
        if (ctx.signal.aborted) throw cancelled();
        throw networkFailure(e);
      }
      const body = await res.text().catch((e: unknown) => {
        if (ctx.signal.aborted) throw cancelled();
        throw networkFailure(e);
      });
      ctx.log(`ElevenLabs answered HTTP ${res.status} (request ${res.headers.get('request-id') ?? '?'})`);
      if (!res.ok) throw httpFailure(res.status, body);

      ctx.progress(0.9, 'reading the transcript');
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        json = undefined;
      }
      const parsed = ScribeResponseSchema.safeParse(json);
      if (!parsed.success)
        throw new PluginFailure(
          'E_CLOUD_TRANSCRIBE_UNEXPECTED',
          `ElevenLabs answered in a form this plugin doesn't know: ${body.slice(0, 120).replace(/\s+/g, ' ')}`,
          'update the Cloud Transcribe plugin; if it is up to date, report this to its publisher',
        );
      const transcript = toTranscript(parsed.data, input.language);
      ctx.progress(1, `${transcript.words.length} words`);
      return transcript;
    },
  };
}

export const definition = cloudTranscribe();
