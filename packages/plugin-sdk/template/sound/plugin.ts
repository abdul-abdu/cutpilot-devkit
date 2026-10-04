// A sound maker: sound effects and music from a description, or speech from text. NodCut puts
// the file it gets back into the edit. Return what you may hand out, with its license.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginDefinition } from '@nodcut/plugin-sdk';

const RATE = 22_050;

/** Mono 16-bit samples as a wav file. */
export function writeWav(file: string, samples: Int16Array, rate = RATE): string {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  writeFileSync(file, b);
  return file;
}

/**
 * A placeholder for a sound model: a short beep per word of speech, or a tone that falls in
 * pitch for effects and music. Replace it with your model or service.
 */
export function placeholderSound(kind: 'sfx' | 'music' | 'speech', durationMs: number): Int16Array {
  const n = Math.round((RATE * durationMs) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const on = kind !== 'speech' || (t * 1000) % 300 < 200;
    const hz = kind === 'speech' ? 440 : 660 - (220 * i) / n;
    out[i] = on ? Math.round(Math.sin(2 * Math.PI * hz * t) * 5000) : 0;
  }
  return out;
}

export const plugin: PluginDefinition = {
  listVoices: () => ({
    voices: [{ id: 'beep', name: 'Beep', languages: ['en'], description: 'a placeholder voice' }],
    languages: ['en'],
  }),
  generateSound: ({ kind, text, durationMs }) => {
    // speech: the words set the length (300 ms a word here); effects and music: what was asked
    const words = text?.split(/\s+/).filter(Boolean).length ?? 0;
    const ms = kind === 'speech' ? Math.max(1, words) * 300 : (durationMs ?? 2000);
    const file = join(tmpdir(), `sound-${randomUUID()}.wav`);
    writeWav(file, placeholderSound(kind, ms));
    return { file, durationMs: ms, sampleRate: RATE, channels: 1, license: 'CC0', model: 'placeholder' };
  },
};
