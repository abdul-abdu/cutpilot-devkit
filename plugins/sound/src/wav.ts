/** Read a wav's header (RIFF/WAVE, PCM or float, also WAVE_FORMAT_EXTENSIBLE) for its facts. */
import { closeSync, openSync, readSync } from 'node:fs';

export interface WavInfo {
  sampleRate: number;
  channels: number;
  durationMs: number;
}

export function wavInfo(file: string): WavInfo {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    if (
      readSync(fd, head, 0, 12, 0) < 12 ||
      head.toString('ascii', 0, 4) !== 'RIFF' ||
      head.toString('ascii', 8, 12) !== 'WAVE'
    )
      throw new Error('not a wav file');
    let pos = 12;
    let fmt: { channels: number; sampleRate: number; blockAlign: number } | null = null;
    const chunk = Buffer.alloc(8);
    for (let i = 0; i < 64; i++) {
      if (readSync(fd, chunk, 0, 8, pos) < 8) break;
      const id = chunk.toString('ascii', 0, 4);
      const size = chunk.readUInt32LE(4);
      if (id === 'fmt ') {
        const b = Buffer.alloc(16);
        if (readSync(fd, b, 0, 16, pos + 8) < 16) throw new Error('short fmt chunk');
        fmt = { channels: b.readUInt16LE(2), sampleRate: b.readUInt32LE(4), blockAlign: b.readUInt16LE(12) };
      } else if (id === 'data') {
        if (!fmt) throw new Error('data before fmt');
        if (!fmt.blockAlign || !fmt.sampleRate) throw new Error('bad fmt chunk');
        const frames = Math.floor(size / fmt.blockAlign);
        return {
          sampleRate: fmt.sampleRate,
          channels: fmt.channels,
          durationMs: Math.round((frames * 1000) / fmt.sampleRate),
        };
      }
      pos += 8 + size + (size % 2);
    }
    throw new Error('no data chunk');
  } finally {
    closeSync(fd);
  }
}
