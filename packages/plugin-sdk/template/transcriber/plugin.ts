// A transcriber: CutPilot sends a 16 kHz mono wav and gets timed words back, in milliseconds.
// The SDK checks the answer against the transcriber contract before it leaves the plugin.
import { statSync } from 'node:fs';
import type { PluginDefinition } from '@cutpilot/plugin-sdk';

const PLACEHOLDER = 'This placeholder transcript comes from your new plugin.';

/** How long a wav from CutPilot is (16 kHz, mono, 16-bit: 32 000 bytes a second after the header). */
export function wavDurationMs(file: string): number {
  return Math.max(0, Math.round(((statSync(file).size - 44) / 32_000) * 1000));
}

/** The words of `text` spread evenly over `durationMs`, each taking most of its slot. */
export function spreadWords(
  text: string,
  durationMs: number,
): { text: string; start: number; end: number }[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || durationMs <= 0) return [];
  const slot = durationMs / words.length;
  return words.map((w, i) => ({
    text: w,
    start: Math.round(i * slot),
    end: Math.round(i * slot + slot * 0.8),
  }));
}

export const plugin: PluginDefinition = {
  // Replace the placeholder with real speech recognition: run a model on `audio`, or send it to
  // a service (declare its host in permissions.network and its key in permissions.secrets).
  transcribe: ({ audio, language }, ctx) => {
    ctx.log(`transcribing ${audio} (${language})`);
    return {
      language: language === 'auto' ? 'en' : language,
      words: spreadWords(PLACEHOLDER, wavDurationMs(audio)),
    };
  },
};
