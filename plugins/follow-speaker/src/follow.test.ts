/** The crop path on synthetic face tracks: calm on a steady speaker, follows a move, ignores passers-by. */
import { KeyframeSchema, ReframeTrackOutputSchema } from '@nodcut/plugin-sdk';
import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { cropSize, follow, mergeRanges, prune, type Keyframe, type Range } from './follow.js';
import { buildTracks, iou, selectMain, type Face, type Sample } from './tracker.js';

/** a deterministic PRNG (mulberry32) */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A face centred at (cx, cy). */
const face = (cx: number, cy = 0.4, w = 0.1, h = 0.18, confidence = 0.97): Face => ({
  x: cx - w / 2,
  y: cy - h / 2,
  w,
  h,
  confidence,
});

/** Samples every 200 ms (5 fps) from 0 to `ms`, with the faces `at(t)` gives. */
function samples(ms: number, at: (t: number) => Face[], fps = 5): Sample[] {
  const out: Sample[] = [];
  for (let t = 0; t <= ms; t += 1000 / fps) out.push({ t: Math.round(t), faces: at(Math.round(t)) });
  return out;
}

/** The crop centre at t, as the engine plays it: linear between keyframes. */
function cropAt(ks: readonly Keyframe[], t: number): number {
  if (t <= ks[0]!.t) return ks[0]!.x;
  for (let i = 1; i < ks.length; i++)
    if (t <= ks[i]!.t) {
      const a = ks[i - 1]!;
      const b = ks[i]!;
      return a.x + ((b.x - a.x) * (t - a.t)) / (b.t - a.t);
    }
  return ks.at(-1)!.x;
}

const VERTICAL = { aspect: '9:16', sourceAspect: 16 / 9 };
const CROP_W = cropSize('9:16', 16 / 9).w; // 0.316 of the frame's width

describe('a steady speaker', () => {
  test('at x ≈ 0.74 with detection jitter: every keyframe within ±0.03', () => {
    const r = rng(1);
    const s = samples(20_000, () => [face(0.74 + (r() - 0.5) * 0.04, 0.4 + (r() - 0.5) * 0.02)]);
    const out = follow(s, [{ start: 0, end: 20_000 }], VERTICAL);
    for (const k of out.keyframes) expect(Math.abs(k.x - 0.74), `t ${k.t}`).toBeLessThanOrEqual(0.03);
    // still: the jitter is inside the dead zone, so there's nothing to move for
    expect(new Set(out.keyframes.map((k) => k.x)).size).toBe(1);
    expect(out.confidence).toBeGreaterThan(0.9);
  });

  test('the face sits a little above the middle of the crop (headroom)', () => {
    const out = follow(
      samples(3000, () => [face(0.5, 0.4, 0.1, 0.2)]),
      [{ start: 0, end: 3000 }],
      {
        aspect: '1:1',
        sourceAspect: 9 / 16,
      },
    );
    expect(out.keyframes[0]!.y).toBeCloseTo(0.42, 3);
  });
});

describe('a speaker who moves', () => {
  test('walking left to right midway: the crop arrives within 1 s and never loses the face', () => {
    // 0.3 until 5 s, walks to 0.7 by 7 s, stays
    const xAt = (t: number) => (t < 5000 ? 0.3 : t < 7000 ? 0.3 + ((t - 5000) / 2000) * 0.4 : 0.7);
    const s = samples(14_000, (t) => [face(xAt(t))]);
    const out = follow(s, [{ start: 0, end: 14_000 }], VERTICAL);
    for (let t = 8000; t <= 14_000; t += 100)
      expect(Math.abs(cropAt(out.keyframes, t) - 0.7), `t ${t}`).toBeLessThan(0.03);
    // the whole face stays inside the crop: its centre within half a crop minus half a face
    for (let t = 0; t <= 14_000; t += 50)
      expect(Math.abs(cropAt(out.keyframes, t) - xAt(t)), `t ${t}`).toBeLessThanOrEqual(CROP_W / 2 - 0.05);
  });

  test('a jump (they stepped across between samples): there within 1 s, without overshooting', () => {
    const s = samples(10_000, (t) => [face(t < 5000 ? 0.3 : 0.7)]);
    const out = follow(s, [{ start: 0, end: 10_000 }], VERTICAL);
    expect(Math.abs(cropAt(out.keyframes, 6000) - 0.7)).toBeLessThan(0.03);
    expect(Math.max(...out.keyframes.map((k) => k.x))).toBeLessThanOrEqual(0.7 + 0.005);
    // and before the jump it stood still
    for (const k of out.keyframes.filter((k) => k.t < 5000)) expect(k.x).toBeCloseTo(0.3, 3);
  });

  test('a small step stays inside the dead zone: no move', () => {
    const s = samples(10_000, (t) => [face(t < 5000 ? 0.5 : 0.54)]);
    const out = follow(s, [{ start: 0, end: 10_000 }], VERTICAL);
    expect(new Set(out.keyframes.map((k) => k.x))).toEqual(new Set([0.5]));
  });
});

describe('other faces and lost detections', () => {
  test('a brief face in the background does not steal the crop', () => {
    const s = samples(10_000, (t) => [
      face(0.6, 0.4, 0.12, 0.2),
      ...(t >= 3000 && t < 4600 ? [face(0.15, 0.3, 0.05, 0.08, 0.8)] : []),
    ]);
    const out = follow(s, [{ start: 0, end: 10_000 }], VERTICAL);
    for (const k of out.keyframes) expect(Math.abs(k.x - 0.6), `t ${k.t}`).toBeLessThanOrEqual(0.03);
  });

  test('nor when it shows up while the speaker is briefly lost: the crop holds', () => {
    const s = samples(10_000, (t) => [
      ...(t >= 3000 && t < 4000 ? [] : [face(0.6, 0.4, 0.12, 0.2)]),
      ...(t >= 3000 && t < 4000 ? [face(0.15, 0.3, 0.05, 0.08, 0.8)] : []),
    ]);
    const out = follow(s, [{ start: 0, end: 10_000 }], VERTICAL);
    for (const k of out.keyframes) expect(Math.abs(k.x - 0.6), `t ${k.t}`).toBeLessThanOrEqual(0.03);
  });

  test('dropouts hold the last position', () => {
    const s = samples(10_000, (t) => (t >= 4000 && t < 5400 ? [] : [face(t < 4000 ? 0.35 : 0.36)]));
    const out = follow(s, [{ start: 0, end: 10_000 }], VERTICAL);
    for (const k of out.keyframes) expect(k.x).toBeCloseTo(0.35, 3);
    expect(out.confidence).toBeLessThan(0.97);
  });

  test('a large speaker who is there most of the time wins over a smaller one there all the time', () => {
    const s = samples(10_000, (t) => [
      face(0.25, 0.4, 0.05, 0.09),
      ...(t >= 1000 ? [face(0.7, 0.4, 0.14, 0.24)] : []),
    ]);
    const tracks = buildTracks(s);
    expect(tracks).toHaveLength(2);
    const followed = selectMain(s, tracks);
    // it started with the only face there, and the speaker took over once there
    expect(followed[0]!.box!.x + followed[0]!.box!.w / 2).toBeCloseTo(0.25);
    expect(followed.at(-1)!.box!.x + followed.at(-1)!.box!.w / 2).toBeCloseTo(0.7);
  });

  test('nobody: the middle of the frame, confidence 0', () => {
    const out = follow(
      samples(3000, () => []),
      [{ start: 0, end: 3000 }],
      VERTICAL,
    );
    expect(out).toEqual({
      keyframes: [
        { t: 0, x: 0.5, y: 0.5 },
        { t: 3000, x: 0.5, y: 0.5 },
      ],
      confidence: 0,
    });
  });
});

describe('keyframes', () => {
  const r = rng(7);
  const s = samples(30_000, (t) => [face(0.3 + 0.4 * Math.sin(t / 3000) ** 2 + (r() - 0.5) * 0.01)]);

  test('strictly increasing integer times inside the ranges, at most 2 per second in each (a shorter range holds still)', () => {
    const ranges: Range[] = [
      { start: 1000, end: 6000 },
      { start: 9000, end: 12_500 },
      { start: 12_500, end: 13_000 }, // touches the one before: merged
      { start: 20_000, end: 20_300 },
    ];
    const out = follow(s, ranges, VERTICAL);
    expect(ReframeTrackOutputSchema.safeParse(out).success).toBe(true);
    const merged = mergeRanges(ranges);
    expect(merged).toHaveLength(3);
    for (const k of out.keyframes) {
      expect(KeyframeSchema.parse(k)).toEqual(k);
      expect(Number.isInteger(k.t)).toBe(true);
      expect(
        merged.some((m) => k.t >= m.start && k.t <= m.end),
        `t ${k.t}`,
      ).toBe(true);
    }
    for (const m of merged) {
      const inside = out.keyframes.filter((k) => k.t >= m.start && k.t <= m.end);
      expect(inside[0]!.t).toBe(m.start);
      expect(inside.at(-1)!.t).toBe(m.end);
      if (m.end - m.start < 500) expect(inside.map((k) => k.x)).toEqual([inside[0]!.x, inside[0]!.x]);
      else
        for (let i = 1; i < inside.length; i++)
          expect(inside[i]!.t - inside[i - 1]!.t).toBeGreaterThanOrEqual(500);
    }
  });

  test('property: any ranges give contract-valid keyframes', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc
            .tuple(fc.integer({ min: 0, max: 29_000 }), fc.integer({ min: 1, max: 6000 }))
            .map(([start, len]) => ({
              start,
              end: start + len,
            })),
          { minLength: 1, maxLength: 6 },
        ),
        (ranges) => {
          const out = follow(s, ranges, VERTICAL);
          const parsed = ReframeTrackOutputSchema.safeParse(out);
          expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });

  test('prune drops points on the line between their neighbours', () => {
    const ks = [0, 500, 1000, 1500, 2000].map((t) => ({ t, x: 0.3 + t / 10_000, y: 0.5 }));
    expect(prune(ks).map((k) => k.t)).toEqual([0, 2000]);
    const bent = [...ks.slice(0, 3), { t: 1500, x: 0.2, y: 0.5 }, ks[4]!];
    expect(prune(bent).map((k) => k.t)).toEqual([0, 1000, 1500, 2000]);
  });
});

describe('geometry', () => {
  test('iou', () => {
    const a = { x: 0, y: 0, w: 0.2, h: 0.2 };
    expect(iou(a, a)).toBe(1);
    expect(iou(a, { x: 0.1, y: 0, w: 0.2, h: 0.2 })).toBeCloseTo(1 / 3);
    expect(iou(a, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 })).toBe(0);
  });

  test('crop sizes', () => {
    expect(cropSize('9:16', 16 / 9).w).toBeCloseTo(0.3164, 4);
    expect(cropSize('9:16', 16 / 9).h).toBe(1);
    expect(cropSize('1:1', 16 / 9).w).toBeCloseTo(0.5625, 4);
    expect(cropSize('16:9', 9 / 16)).toEqual({ w: 1, h: expect.closeTo(0.3164, 4) });
  });

  test('a fast mover stays one track; a face far away starts another', () => {
    const s: Sample[] = [
      { t: 0, faces: [face(0.3)] },
      { t: 200, faces: [face(0.42)] }, // no overlap, but close for its size
      { t: 400, faces: [face(0.5), face(0.9, 0.2, 0.04, 0.07)] },
    ];
    const tracks = buildTracks(s);
    expect(tracks.map((t) => t.detections.length)).toEqual([3, 1]);
  });
});
