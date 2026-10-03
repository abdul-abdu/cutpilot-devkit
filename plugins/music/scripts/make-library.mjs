#!/usr/bin/env node
/**
 * Make the placeholder music library: six short loops, one per mood, synthesized from scratch
 * (sines with envelopes, noise for the drums) and encoded with ffmpeg as AAC. Everything is
 * computed here from a fixed seed, so running it again gives the same notes; the tracks are
 * our own work and released as CC0-1.0.
 *
 *   node plugins/music/scripts/make-library.mjs [--only <id>]
 *
 * Writes library/<id>.m4a and library/library.json next to them. Needs ffmpeg on PATH.
 *
 * Every note is added into the loop buffer modulo its length, so a tail that runs past the end
 * comes back in at the start, and the filters run around the loop twice: the file loops
 * without a click. These are placeholders until a licensed library replaces them.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SR = 44100;
const OUT = join(import.meta.dirname, '..', 'library');
const BITRATE = '128k'; // ffmpeg's AAC encoder at 96k overshoots on some low notes (audible clicks)

// ── building blocks ──────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32), so the noise is the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Note names to MIDI numbers: `C4` = 60, `F#3`, `Bb2`. */
function midi(name) {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  return base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12;
}
const chord = (...names) => names.map(midi);

/** A stereo loop of `seconds`, mixed into by the instruments below. */
class Loop {
  constructor(seconds) {
    this.n = Math.round(seconds * SR);
    this.l = new Float32Array(this.n);
    this.r = new Float32Array(this.n);
  }
  /** Add a mono signal (a function of the sample index from the note's start) at `start` s, panned -1..1. */
  add(start, samples, pan, fn) {
    const s0 = Math.round(start * SR);
    const gl = Math.cos(((pan + 1) * Math.PI) / 4);
    const gr = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < samples; i++) {
      const v = fn(i);
      const k = (s0 + i) % this.n;
      this.l[k] += v * gl;
      this.r[k] += v * gr;
    }
  }
}

/**
 * A tone: partials as [ratio, amplitude], an attack, then an exponential decay towards
 * `sustain` (time constant `decay` s), held for `dur` s, then a release. `vibrato` in cents.
 */
function tone(loop, start, dur, freq, o) {
  const { gain = 0.2, pan = 0, attack = 0.01, decay = 0.3, sustain = 0.6, release = 0.3 } = o;
  const partials = o.partials ?? [[1, 1]];
  const detune = o.detune ?? 0; // cents, a second voice detuned this much
  const tremolo = o.tremolo ?? 0;
  const voices = detune ? [-detune / 2, detune / 2] : [0];
  const total = Math.round((dur + release) * SR);
  const end = Math.round(dur * SR);
  const atk = Math.max(1, Math.round(attack * SR));
  const norm = gain / voices.length / partials.reduce((s, [, a]) => s + a, 0);
  const w = voices.flatMap((c) =>
    partials.map(([ratio, amp]) => [(2 * Math.PI * freq * ratio * 2 ** (c / 1200)) / SR, amp]),
  );
  const levelAt = (i) => {
    if (i < atk) return i / atk;
    const t = (i - atk) / SR;
    return sustain + (1 - sustain) * Math.exp(-t / decay);
  };
  const atEnd = levelAt(end);
  loop.add(start, total, pan, (i) => {
    let env = i < end ? levelAt(i) : atEnd * Math.exp(-((i - end) / SR) / (release / 5));
    if (tremolo) env *= 1 - tremolo * (0.5 + 0.5 * Math.sin((2 * Math.PI * 5 * i) / SR));
    let v = 0;
    for (const [dw, amp] of w) v += amp * Math.sin(dw * i);
    return v * env * norm;
  });
}

const PAD = {
  partials: [
    [1, 1],
    [2, 0.45],
    [3, 0.25],
    [4, 0.12],
    [5, 0.06],
  ],
  detune: 9,
  attack: 0.8,
  decay: 2,
  sustain: 0.85,
  release: 1.6,
};
const STRINGS = {
  partials: [
    [1, 1],
    [2, 0.6],
    [3, 0.4],
    [4, 0.25],
    [5, 0.15],
    [6, 0.08],
  ],
  detune: 12,
  attack: 1.2,
  decay: 3,
  sustain: 0.9,
  release: 2,
};
const BELL = {
  partials: [
    [1, 1],
    [2, 0.35],
    [3, 0.12],
    [4.2, 0.08],
  ],
  attack: 0.004,
  decay: 0.6,
  sustain: 0,
  release: 0.8,
};
const PLUCK = {
  partials: [
    [1, 1],
    [2, 0.5],
    [3, 0.2],
    [4, 0.1],
  ],
  attack: 0.003,
  decay: 0.18,
  sustain: 0,
  release: 0.2,
};
const PIANO = {
  partials: [
    [1, 1],
    [2, 0.4],
    [3, 0.18],
    [4, 0.08],
    [5, 0.04],
  ],
  attack: 0.004,
  decay: 0.9,
  sustain: 0.05,
  release: 0.5,
};
const EPIANO = {
  partials: [
    [1, 1],
    [2, 0.15],
    [3, 0.05],
  ],
  attack: 0.006,
  decay: 0.8,
  sustain: 0.2,
  release: 0.4,
  tremolo: 0.25,
};
const BASS = {
  partials: [
    [1, 1],
    [2, 0.3],
    [3, 0.08],
  ],
  attack: 0.01,
  decay: 0.5,
  sustain: 0.6,
  release: 0.12,
};

function kick(loop, start, gain = 0.55) {
  let phase = 0;
  loop.add(start, Math.round(0.45 * SR), 0, (i) => {
    const t = i / SR;
    phase += (2 * Math.PI * (45 + 75 * Math.exp(-t / 0.035))) / SR;
    return Math.sin(phase) * Math.exp(-t / 0.13) * gain;
  });
}

function snare(loop, start, rand, gain = 0.22, pan = 0.05) {
  loop.add(start, Math.round(0.3 * SR), pan, (i) => {
    const t = i / SR;
    const noise = (rand() * 2 - 1) * Math.exp(-t / 0.07);
    const body = Math.sin(2 * Math.PI * 185 * t) * Math.exp(-t / 0.04);
    return (0.7 * noise + 0.5 * body) * gain;
  });
}

function hat(loop, start, rand, gain = 0.06, pan = 0.3, length = 0.025) {
  let prev = 0;
  loop.add(start, Math.round(0.12 * SR), pan, (i) => {
    const n = rand() * 2 - 1;
    const v = n - prev; // a first difference: the high end of the noise
    prev = n;
    return v * Math.exp(-i / SR / length) * gain;
  });
}

function timpani(loop, start, note, gain = 0.5) {
  const f = hz(note);
  loop.add(start, Math.round(2.2 * SR), -0.1, (i) => {
    const t = i / SR;
    const v = Math.sin(2 * Math.PI * f * t) + 0.35 * Math.sin(2 * Math.PI * f * 1.5 * t) * Math.exp(-t / 0.2);
    return v * Math.exp(-t / 0.55) * Math.min(1, i / 60) * gain;
  });
}

/** Vinyl crackle: sparse clicks of random size. */
function crackle(loop, rand, perSecond = 6, gain = 0.05) {
  const count = Math.round((loop.n / SR) * perSecond);
  for (let c = 0; c < count; c++) {
    const at = rand() * (loop.n / SR);
    const size = gain * (0.3 + rand());
    const pan = rand() * 1.4 - 0.7;
    loop.add(at, 40, pan, (i) => (rand() * 2 - 1) * size * Math.exp(-i / 6));
  }
}

/** One-pole low-pass at `cutoff` Hz, run around the loop twice so the seam has no step. */
function lowpass(loop, cutoff) {
  const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
  for (const ch of [loop.l, loop.r]) {
    let y = 0;
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < ch.length; i++) {
        y += a * (ch[i] - y);
        if (pass === 1) ch[i] = y;
      }
  }
}

/** Bring the mix to about -16 dBFS RMS, soften the peaks, keep them under -1.5 dBFS (AAC overshoots a little). */
function master(loop) {
  let sum = 0;
  for (let i = 0; i < loop.n; i++) sum += loop.l[i] ** 2 + loop.r[i] ** 2;
  const rms = Math.sqrt(sum / (2 * loop.n)) || 1;
  const g = 0.158 / rms;
  let peak = 0;
  for (const ch of [loop.l, loop.r])
    for (let i = 0; i < ch.length; i++) {
      ch[i] = Math.tanh(ch[i] * g * 1.1) / 1.1;
      peak = Math.max(peak, Math.abs(ch[i]));
    }
  const limit = 0.84 / Math.max(peak, 0.84);
  for (const ch of [loop.l, loop.r]) for (let i = 0; i < ch.length; i++) ch[i] *= limit;
}

// ── the tracks ───────────────────────────────────────────────────────────────

/**
 * Each track: its facts for library.json, and `render(loop, beat)` where beat is the length of
 * a beat in seconds. `bars` × `chords` set the length.
 */
const TRACKS = [
  {
    id: 'still-water',
    title: 'Still Water',
    moods: ['calm'],
    bpm: 72,
    bars: 16,
    render(loop, beat, rand) {
      const prog = [
        chord('C3', 'G3', 'B3', 'E4'),
        chord('A2', 'E3', 'G3', 'C4'),
        chord('F2', 'C3', 'E3', 'A3'),
        chord('G2', 'D3', 'E3', 'B3'),
      ];
      for (let bar = 0; bar < 16; bar++) {
        const c = prog[Math.floor(bar / 2) % 4];
        const t = bar * 4 * beat;
        if (bar % 2 === 0) {
          for (const n of c.slice(1))
            tone(loop, t, 8 * beat, hz(n), { ...PAD, gain: 0.09, pan: rand() * 0.6 - 0.3 });
          tone(loop, t, 8 * beat, hz(c[0] - 12), { ...BASS, gain: 0.16, decay: 2, sustain: 0.5, release: 1 });
        }
        // a slow bell arpeggio over the chord, an octave up, a note now and then left out
        const arp = [c[1], c[2], c[3], c[2] + 12, c[3], c[2], c[1] + 12, c[3]];
        arp.forEach((n, k) => {
          if (rand() < 0.2) return;
          tone(loop, t + k * 0.5 * beat, 0.5 * beat, hz(n + 12), {
            ...BELL,
            gain: 0.07,
            pan: k % 2 ? 0.35 : -0.35,
          });
        });
      }
    },
  },
  {
    id: 'bright-side',
    title: 'Bright Side',
    moods: ['upbeat'],
    bpm: 118,
    bars: 24,
    render(loop, beat, rand) {
      const prog = [
        chord('G3', 'B3', 'D4'),
        chord('D3', 'F#3', 'A3'),
        chord('E3', 'G3', 'B3'),
        chord('C3', 'E3', 'G3'),
      ];
      for (let bar = 0; bar < 24; bar++) {
        const c = prog[bar % 4];
        const t = bar * 4 * beat;
        for (let b = 0; b < 4; b++) {
          kick(loop, t + b * beat, 0.5);
          if (b % 2 === 1) snare(loop, t + b * beat, rand, 0.2);
          hat(loop, t + (b + 0.5) * beat, rand, 0.07);
        }
        // eighth-note bass on the root, jumping the octave on the off-beats
        for (let e = 0; e < 8; e++)
          tone(loop, t + e * 0.5 * beat, 0.4 * beat, hz(c[0] - 12 + (e % 2 ? 12 : 0)), {
            ...BASS,
            gain: 0.17,
          });
        // a pluck arpeggio, up and back
        const arp = [c[0] + 12, c[1] + 12, c[2] + 12, c[0] + 24, c[2] + 12, c[1] + 12, c[0] + 12, c[1] + 12];
        arp.forEach((n, k) =>
          tone(loop, t + k * 0.5 * beat, 0.45 * beat, hz(n), {
            ...PLUCK,
            gain: 0.09,
            pan: k % 2 ? 0.4 : -0.4,
          }),
        );
        if (bar % 2 === 0) for (const n of c) tone(loop, t, 8 * beat, hz(n), { ...PAD, gain: 0.04 });
      }
    },
  },
  {
    id: 'first-light',
    title: 'First Light',
    moods: ['inspiring', 'upbeat'],
    bpm: 96,
    bars: 24,
    render(loop, beat, rand) {
      const prog = [
        chord('D3', 'A3', 'D4', 'F#4'),
        chord('C#3', 'A3', 'E4', 'A4'),
        chord('B2', 'F#3', 'D4', 'F#4'),
        chord('G2', 'D3', 'B3', 'G4'),
      ];
      for (let bar = 0; bar < 24; bar++) {
        const c = prog[Math.floor(bar / 2) % 4];
        const t = bar * 4 * beat;
        const built = bar >= 8; // drums and bass come in after the first pass
        if (bar % 2 === 0)
          for (const n of c.slice(1)) tone(loop, t, 8 * beat, hz(n), { ...STRINGS, gain: 0.07 });
        // piano eighths, rising through the chord
        const arp = [c[1], c[2], c[3], c[2], c[3] + 12 - 12, c[2], c[1] + 12, c[3]];
        arp.forEach((n, k) =>
          tone(loop, t + k * 0.5 * beat, 0.5 * beat, hz(n + 12), { ...PIANO, gain: 0.08, pan: -0.15 }),
        );
        if (built) {
          tone(loop, t, 4 * beat, hz(c[0] - 12), { ...BASS, gain: 0.18, decay: 1.5 });
          for (let b = 0; b < 4; b++) {
            if (b === 0 || b === 2 || (b === 3 && bar % 4 === 3)) kick(loop, t + b * beat, 0.45);
            if (b % 2 === 1) snare(loop, t + b * beat, rand, 0.15, -0.05);
            hat(loop, t + b * beat, rand, 0.04, 0.35);
            hat(loop, t + (b + 0.5) * beat, rand, 0.06, 0.35);
          }
        }
      }
    },
  },
  {
    id: 'clear-plan',
    title: 'Clear Plan',
    moods: ['corporate', 'upbeat'],
    bpm: 110,
    bars: 28,
    render(loop, beat, rand) {
      const prog = [
        chord('C4', 'E4', 'G4'),
        chord('G3', 'B3', 'D4'),
        chord('A3', 'C4', 'E4'),
        chord('F3', 'A3', 'C4'),
      ];
      for (let bar = 0; bar < 28; bar++) {
        const c = prog[bar % 4];
        const t = bar * 4 * beat;
        for (let b = 0; b < 4; b++) {
          kick(loop, t + b * beat, b % 2 ? 0.3 : 0.45);
          if (b % 2 === 1) snare(loop, t + b * beat, rand, 0.13);
          for (let s = 0; s < 4; s++)
            hat(loop, t + (b + s / 4) * beat, rand, s % 2 ? 0.025 : 0.04, -0.3, 0.015);
        }
        // short muted chords on the off-beats, a bass on the beats
        for (let e = 0; e < 8; e++) {
          if (e % 2 === 1)
            for (const n of c)
              tone(loop, t + e * 0.5 * beat, 0.2 * beat, hz(n), {
                ...PLUCK,
                gain: 0.05,
                decay: 0.08,
                pan: 0.25,
              });
          if (e % 2 === 0)
            tone(loop, t + e * 0.5 * beat, 0.45 * beat, hz(c[0] - 24 + (c[0] < 60 ? 12 : 0)), {
              ...BASS,
              gain: 0.15,
            });
        }
        // a bell line every other bar
        if (bar % 2 === 1)
          [c[2] + 12, c[1] + 12, c[0] + 12].forEach((n, k) =>
            tone(loop, t + (k + 1) * beat, beat, hz(n), { ...BELL, gain: 0.05, pan: -0.3 }),
          );
      }
    },
  },
  {
    id: 'long-shadow',
    title: 'Long Shadow',
    moods: ['dramatic'],
    bpm: 70,
    bars: 16,
    render(loop, beat, rand) {
      const prog = [
        chord('D2', 'A2', 'D3', 'F3', 'A3'),
        chord('Bb1', 'F2', 'Bb2', 'D3', 'F3'),
        chord('G1', 'D2', 'G2', 'Bb2', 'D3'),
        chord('A1', 'E2', 'A2', 'C#3', 'E3'),
      ];
      for (let bar = 0; bar < 16; bar++) {
        const c = prog[Math.floor(bar / 2) % 4];
        const t = bar * 4 * beat;
        if (bar % 2 === 0) {
          for (const n of c.slice(1))
            tone(loop, t, 8 * beat, hz(n), { ...STRINGS, gain: 0.08, pan: rand() * 0.8 - 0.4 });
          timpani(loop, t, c[0] + 12, 0.45);
        }
        if (bar % 2 === 1) timpani(loop, t + 3.5 * beat, c[0] + 12, 0.25);
        // a low ostinato: root, fifth, octave in steady eighths
        const ost = [c[0] + 12, c[1] + 12, c[0] + 24, c[1] + 12];
        for (let e = 0; e < 8; e++)
          tone(loop, t + e * 0.5 * beat, 0.45 * beat, hz(ost[e % 4]), {
            ...PLUCK,
            gain: e % 4 === 0 ? 0.11 : 0.08,
            decay: 0.25,
          });
        // a high, sparse answer on the last bar of each chord
        if (bar % 2 === 1)
          tone(loop, t + 2 * beat, 2 * beat, hz(c[4] + 12), {
            ...STRINGS,
            gain: 0.04,
            attack: 0.5,
            pan: 0.3,
          });
      }
    },
  },
  {
    id: 'rainy-desk',
    title: 'Rainy Desk',
    moods: ['lo-fi', 'calm'],
    bpm: 80,
    bars: 24,
    render(loop, beat, rand) {
      const prog = [
        chord('F3', 'A3', 'C4', 'E4'),
        chord('E3', 'G3', 'B3', 'D4'),
        chord('D3', 'F3', 'A3', 'C4'),
        chord('C3', 'E3', 'G3', 'B3'),
      ];
      const swing = 0.62; // the second eighth of each beat comes late
      for (let bar = 0; bar < 24; bar++) {
        const c = prog[bar % 4];
        const t = bar * 4 * beat;
        // electric piano: the chord on 1 and on the "and" of 2
        for (const at of [0, 1 + swing])
          for (const n of c)
            tone(loop, t + at * beat + rand() * 0.012, 1.2 * beat, hz(n), { ...EPIANO, gain: 0.06 });
        tone(loop, t, 1.5 * beat, hz(c[0] - 12), { ...BASS, gain: 0.2, decay: 0.8 });
        tone(loop, t + 2.5 * beat, 1.2 * beat, hz(c[0] - 12 + 7), { ...BASS, gain: 0.15, decay: 0.8 });
        kick(loop, t, 0.42);
        kick(loop, t + (2 + swing) * beat, 0.32);
        snare(loop, t + beat, rand, 0.12, 0.1);
        snare(loop, t + 3 * beat, rand, 0.12, 0.1);
        for (let b = 0; b < 4; b++) {
          hat(loop, t + b * beat, rand, 0.035, -0.25);
          hat(loop, t + (b + swing) * beat, rand, 0.025, -0.25);
        }
      }
      crackle(loop, rand, 7, 0.04);
      lowpass(loop, 3200);
    },
  },
];

// ── write ────────────────────────────────────────────────────────────────────

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
mkdirSync(OUT, { recursive: true });
const entries = [];
for (const [index, track] of TRACKS.entries()) {
  const beat = 60 / track.bpm;
  const seconds = track.bars * 4 * beat;
  const durationMs = Math.round(seconds * 1000);
  const file = `${track.id}.m4a`;
  entries.push({
    id: track.id,
    title: track.title,
    moods: track.moods,
    bpm: track.bpm,
    durationMs,
    loopable: true,
    license: 'CC0-1.0',
    file,
  });
  if (only && only !== track.id) continue;
  const loop = new Loop(seconds);
  track.render(loop, beat, rng(1000 + index));
  master(loop);
  const pcm = Buffer.alloc(loop.n * 8);
  for (let i = 0; i < loop.n; i++) {
    pcm.writeFloatLE(loop.l[i], i * 8);
    pcm.writeFloatLE(loop.r[i], i * 8 + 4);
  }
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'f32le',
      '-ar',
      String(SR),
      '-ac',
      '2',
      '-i',
      'pipe:0',
      '-c:a',
      'aac',
      '-b:a',
      BITRATE,
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags:a',
      '+bitexact',
      '-metadata',
      `title=${track.title}`,
      '-metadata',
      'copyright=CC0-1.0',
      '-movflags',
      '+faststart',
      join(OUT, file),
    ],
    { input: pcm, stdio: ['pipe', 'inherit', 'inherit'] },
  );
  console.error(`${file}: ${seconds.toFixed(1)} s, ${track.bpm} bpm, ${track.moods.join(', ')}`);
}
// short lists of strings on one line, the way prettier writes them
const json = JSON.stringify({ tracks: entries }, null, 2).replace(
  /\[\n\s+("[^"\n]*"(?:,\n\s+"[^"\n]*")*)\n\s+\]/g,
  (_, items) => `[${items.split(/,\n\s+/).join(', ')}]`,
);
writeFileSync(join(OUT, 'library.json'), json + '\n');
console.error(`library.json: ${entries.length} tracks`);
