/**
 * From face samples to the crop's keyframes: who to follow (tracker.ts), where they are at each
 * moment (gaps held), and a calm camera over that: it stays put for small shifts, moves with an
 * eased start and stop at a bounded speed for large ones, and holds still while the face is
 * briefly lost. Pure: no files, no clock.
 */
import { buildTracks, centre, selectMain, type Face, type Followed, type Sample } from './tracker.js';

export interface Range {
  start: number;
  end: number;
}

export interface Keyframe {
  t: number;
  x: number;
  y: number;
}

export interface FollowOptions {
  /** the output aspect, like 9:16 */
  aspect: string;
  /** the source frame's width / height (16:9 when unknown) */
  sourceAspect?: number;
}

export interface Camera {
  /** fractions of the crop's width / height a face may drift before the camera moves */
  deadZone: number;
  /** top speed, crop widths (or heights) per second */
  maxSpeed: number;
  /** how fast it gets to that speed, crop widths per second² */
  accel: number;
  /** how quickly it closes the distance near the end of a move, 1/s (eases the stop) */
  gain: number;
  /** a move ends this close to its goal, in crop widths */
  settle: number;
  /** the face's centre sits this many face heights above the crop's centre (headroom) */
  headroom: number;
  /** keyframes at least this far apart (2 per second) */
  keyframeMs: number;
  /** the simulation step */
  stepMs: number;
}

export const CAMERA: Camera = {
  deadZone: 0.18,
  maxSpeed: 3,
  accel: 14,
  gain: 6,
  settle: 0.01,
  headroom: 0.1,
  keyframeMs: 500,
  stepMs: 20,
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round4 = (v: number) => Math.round(v * 10000) / 10000;

/** The crop's size as a fraction of the source frame. */
export function cropSize(aspect: string, sourceAspect = 16 / 9): { w: number; h: number } {
  const [a, b] = aspect.split(':').map(Number) as [number, number];
  const target = a / b;
  return target < sourceAspect ? { w: target / sourceAspect, h: 1 } : { w: 1, h: sourceAspect / target };
}

/** Sorted ranges with overlapping or touching ones merged. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  for (const r of [...ranges].sort((a, b) => a.start - b.start)) {
    const last = out.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** Where the crop should be centred for a face: its centre, the face a little above the middle. */
export function aim(f: Face, c: Camera = CAMERA) {
  const m = centre(f);
  return { x: clamp01(m.x), y: clamp01(m.y + c.headroom * f.h) };
}

export interface Target {
  t: number;
  x: number;
  y: number;
  /** whether the followed face was seen at t (else its last position is held) */
  seen: boolean;
}

/**
 * The aim at each sample: the followed face, its last position while it's lost, its first
 * position before it's first seen. Empty when no face is ever followed.
 */
export function targets(followed: readonly Followed[], c: Camera = CAMERA): Target[] {
  const first = followed.find((f) => f.box);
  if (!first) return [];
  let held = aim(first.box!, c);
  return followed.map((f) => {
    if (f.box) held = aim(f.box, c);
    return { t: f.t, ...held, seen: !!f.box };
  });
}

/** The aim in force at time t: the last target at or before it (the first before any). */
function aimAt(ts: readonly Target[], t: number): Target {
  let lo = 0;
  let hi = ts.length - 1;
  if (t < ts[0]!.t) return ts[0]!;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ts[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return ts[lo]!;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** One axis of the camera: dead zone, eased moves with a top speed. Units: fractions of the frame. */
class Axis {
  v = 0;
  goal: number | null = null;
  constructor(
    public pos: number,
    private readonly dead: number,
    private readonly maxSpeed: number,
    private readonly accel: number,
    private readonly gain: number,
    private readonly settle: number,
  ) {}

  step(target: number, dt: number) {
    if (this.goal === null && Math.abs(target - this.pos) > this.dead) this.goal = target;
    if (this.goal !== null) this.goal = target; // a move follows the face until it settles
    const dist = this.goal === null ? 0 : Math.abs(this.goal - this.pos);
    // as fast as allowed, slow enough to stop in time without overshooting, easing out at the end
    const want =
      Math.sign((this.goal ?? this.pos) - this.pos) *
      Math.min(this.maxSpeed, Math.sqrt(2 * this.accel * dist) * 0.9, dist * this.gain);
    const dv = Math.max(-this.accel * dt, Math.min(this.accel * dt, want - this.v));
    this.v += dv;
    this.pos += this.v * dt;
    if (
      this.goal !== null &&
      Math.abs(this.goal - this.pos) < this.settle &&
      Math.abs(this.v) < this.maxSpeed / 4
    ) {
      this.goal = null;
      this.v = 0;
    }
  }
}

/**
 * The camera over one range: starts on the face (the median of its first second, a cut is a
 * fine moment to jump), then follows. Returns its position every `stepMs`.
 */
export function cameraPath(
  ts: readonly Target[],
  range: Range,
  crop: { w: number; h: number },
  c: Camera = CAMERA,
) {
  const opening = ts.filter((x) => x.t >= range.start && x.t < range.start + 1000);
  const start = opening.length ? opening : [aimAt(ts, range.start)];
  const make = (pos: number, size: number) =>
    new Axis(pos, c.deadZone * size, c.maxSpeed * size, c.accel * size, c.gain, c.settle * size);
  const ax = make(median(start.map((s) => s.x)), crop.w);
  const ay = make(median(start.map((s) => s.y)), crop.h);
  const path: Keyframe[] = [];
  const dt = c.stepMs / 1000;
  for (let t = range.start; ; t = Math.min(t + c.stepMs, range.end)) {
    if (t > range.start) {
      const a = aimAt(ts, t);
      ax.step(a.x, dt);
      ay.step(a.y, dt);
    }
    path.push({ t, x: clamp01(ax.pos), y: clamp01(ay.pos) });
    if (t >= range.end) break;
  }
  return path;
}

/** Keyframes at most 2 per second, evenly spaced from the range's start to its end. */
export function keyframesOf(path: readonly Keyframe[], range: Range, c: Camera = CAMERA): Keyframe[] {
  const len = range.end - range.start;
  // a range shorter than that: the crop stays where it starts
  if (len < c.keyframeMs) {
    const { x, y } = path[0]!;
    return [range.start, range.end].map((t) => ({ t, x: round4(x), y: round4(y) }));
  }
  const n = Math.max(1, Math.floor(len / c.keyframeMs));
  const out: Keyframe[] = [];
  let j = 0;
  for (let i = 0; i <= n; i++) {
    const t = i === n ? range.end : Math.round(range.start + (i * len) / n);
    while (j + 1 < path.length && path[j + 1]!.t <= t) j++;
    out.push({ t, x: round4(path[j]!.x), y: round4(path[j]!.y) });
  }
  return out;
}

/** Drop keyframes the line between their neighbours already gives (the engine interpolates). */
export function prune(ks: readonly Keyframe[], tolerance = 0.002): Keyframe[] {
  if (ks.length <= 2) return [...ks];
  const out = [ks[0]!];
  for (let i = 1; i < ks.length - 1; i++) {
    const a = out.at(-1)!;
    const b = ks[i + 1]!;
    const f = (ks[i]!.t - a.t) / (b.t - a.t);
    const k = ks[i]!;
    if (
      Math.abs(a.x + (b.x - a.x) * f - k.x) > tolerance ||
      Math.abs(a.y + (b.y - a.y) * f - k.y) > tolerance
    )
      out.push(k);
  }
  out.push(ks.at(-1)!);
  return out;
}

export interface FollowResult {
  keyframes: Keyframe[];
  /** how sure: the share of samples the followed face was seen in, times its mean detection confidence */
  confidence: number;
}

/** The whole pipeline. */
export function follow(
  samples: readonly Sample[],
  ranges: readonly Range[],
  o: FollowOptions,
  c: Camera = CAMERA,
): FollowResult {
  const merged = mergeRanges(ranges);
  const inside = samples.filter((s) => merged.some((r) => s.t >= r.start && s.t <= r.end));
  const followed = selectMain(inside, buildTracks(inside));
  const ts = targets(followed, c);
  if (!ts.length)
    // nobody to follow: the middle of the frame, and say so
    return {
      keyframes: merged
        .flatMap((r) => [
          { t: r.start, x: 0.5, y: 0.5 },
          { t: r.end, x: 0.5, y: 0.5 },
        ])
        .filter((k, i, all) => i === 0 || k.t > all[i - 1]!.t),
      confidence: 0,
    };
  const crop = cropSize(o.aspect, o.sourceAspect);
  const keyframes = merged.flatMap((r) => prune(keyframesOf(cameraPath(ts, r, crop, c), r, c)));
  // ranges that touch were merged, so times only repeat if one range ends where the next starts
  const strictly = keyframes.filter((k, i) => i === 0 || k.t > keyframes[i - 1]!.t);
  const seenFaces = followed.filter((f) => f.box);
  const seen = seenFaces.length / followed.length;
  const meanConf = seenFaces.reduce((sum, f) => sum + f.box!.confidence, 0) / Math.max(1, seenFaces.length);
  return { keyframes: strictly, confidence: Math.round(seen * meanConf * 1000) / 1000 };
}
