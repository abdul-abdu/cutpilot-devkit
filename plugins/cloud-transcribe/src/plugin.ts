/**
 * The plugin: a `transcriber` that sends CutPilot's 16 kHz wav to ElevenLabs Scribe or
 * OpenAI whisper-1 with the user's own key, plus `test_key` for the app's "Test key" button.
 */
import {
  PluginFailure,
  type ExtraTool,
  type PluginContext,
  type PluginDefinition,
} from '@cutpilot/plugin-sdk';
import { z } from 'zod';
import {
  checkKey,
  missingKey,
  PROVIDER,
  PROVIDERS,
  transcribeWith,
  type ProviderId,
  type Transport,
} from './providers.js';

/** For tests: send every request to this origin (a local stub) instead of the provider's. */
export const ORIGIN_ENV = 'CUTPILOT_CLOUD_TRANSCRIBE_ORIGIN';

export interface Options {
  fetch?: typeof fetch;
  /** default: $CUTPILOT_CLOUD_TRANSCRIBE_ORIGIN, else the provider's own */
  origin?: string;
}

function providerOf(ctx: PluginContext, asked?: string) {
  const id = (asked ?? ctx.settings.provider ?? 'elevenlabs') as ProviderId;
  if (!PROVIDERS.includes(id))
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      `unknown provider "${String(id)}"`,
      `set Provider to ${PROVIDERS.join(' or ')} in CutPilot → Plugins → Cloud transcription → Settings`,
    );
  return PROVIDER[id];
}

export function makeDefinition(o: Options = {}): PluginDefinition {
  const transport = (ctx: PluginContext): Transport => ({
    fetch: o.fetch ?? globalThis.fetch,
    origin: o.origin ?? (process.env[ORIGIN_ENV] || undefined),
    signal: ctx.signal,
  });

  const testKey: ExtraTool = {
    description:
      'Check the API key of the cloud transcription provider (the one set in the plugin settings, or the one named) with a small request. Uploads no audio and costs nothing.',
    input: { provider: z.enum(PROVIDERS).optional() },
    handler: async (args, ctx) => {
      const p = providerOf(ctx, (args as { provider?: string }).provider);
      return checkKey(p, ctx.secret(p.secret), transport(ctx));
    },
  };

  return {
    transcribe: async (input, ctx) => {
      const p = providerOf(ctx);
      const key = ctx.secret(p.secret);
      if (!key) throw missingKey(p);
      ctx.progress(0.05, `uploading the audio to ${p.name}`);
      ctx.log(`transcribing with ${p.name} (language ${input.language})`);
      const r = await transcribeWith(p, key, input, transport(ctx), {
        model: String(ctx.settings.scribeModel ?? ''),
        keyterms: ctx.settings.keyterms === true,
      });
      ctx.progress(1, `${r.words.length} words`);
      return r;
    },
    tools: { test_key: testKey },
  };
}

export const definition = makeDefinition();
