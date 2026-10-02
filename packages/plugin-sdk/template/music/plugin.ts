// A music source: CutPilot asks find_music for tracks that fit a mood, then get_music for the
// file of the one it picked, and mixes it under the speech. Return only music you may hand out,
// with its license and the credit line it asks for.
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFailure, type PluginDefinition } from '@cutpilot/plugin-sdk';

interface Track {
  id: string;
  title: string;
  moods: string[];
  durationMs: number;
  loopable: boolean;
  license: string;
  /** a tone stands in for the audio; a real catalogue has files or download links */
  hz: number;
}

/** A placeholder catalogue. Replace it with your own music (files in the plugin, or an API). */
export const CATALOG: Track[] = [
  {
    id: 'calm-a',
    title: 'Calm tone in A',
    moods: ['calm'],
    durationMs: 8000,
    loopable: false,
    license: 'CC0',
    hz: 220,
  },
  {
    id: 'upbeat-e',
    title: 'Upbeat tone in E',
    moods: ['upbeat'],
    durationMs: 8000,
    loopable: false,
    license: 'CC0',
    hz: 330,
  },
];

/** A mono 16-bit wav of a soft sine tone that fades in and out. */
export function toneWav(file: string, hz: number, ms: number, rate = 22_050): string {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  const fade = rate / 2;
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade);
    b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 6000 * env), 44 + i * 2);
  }
  writeFileSync(file, b);
  return file;
}

const publicTrack = ({ hz: _hz, ...t }: Track) => t;

export const plugin: PluginDefinition = {
  findMusic: ({ mood, query, minDurationMs, limit }) => {
    const q = query?.toLowerCase();
    const tracks = CATALOG.filter(
      (t) =>
        (!mood || t.moods.includes(mood.toLowerCase())) &&
        (!q || t.title.toLowerCase().includes(q)) &&
        (!minDurationMs || t.loopable || t.durationMs >= minDurationMs),
    );
    return { tracks: tracks.slice(0, limit ?? 10).map(publicTrack) };
  },
  getMusic: ({ id }) => {
    const t = CATALOG.find((x) => x.id === id);
    if (!t)
      throw new PluginFailure('E_PLUGIN_BAD_INPUT', `no track ${id}`, 'pick an id that find_music returned');
    // CutPilot copies the file into the project, so a temporary file is fine
    const file = join(tmpdir(), `music-${t.id}.wav`);
    if (!existsSync(file)) toneWav(file, t.hz, t.durationMs);
    return { file, durationMs: t.durationMs, license: t.license };
  },
};
