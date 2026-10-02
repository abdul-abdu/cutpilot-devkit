/**
 * Faces into tracks, and the main speaker among them. Pure functions over the helper's samples.
 *
 * - Tracking: a face in one sample continues the track whose last box overlaps it most (IoU),
 *   or, when a person moves fast between samples, whose last box is close enough for its size.
 *   A track that isn't seen for `maxGapMs` ends; a face after that starts a new one.
 * - Main speaker: each track scores the sum of its box areas times their confidence, so a face
 *   that is large and there most of the time beats a small one in the background or a passer-by.
 * - Who is followed at each sample: the best-scoring face present. Once followed, a face is kept
 *   while it's there (unless one present scores twice as much). When it is lost, a face that
 *   scores at least half as much takes over at once (often the same person, seen again after a
 *   jump); a lesser one only after `holdMs`, and until then the last position is held, so a short
 *   loss of detection doesn't hand the crop to someone in the background.
 */

export interface Box {
  /** top-left corner and size, fractions of the frame, y from the top */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Face extends Box {
  confidence: number;
}

export interface Sample {
  /** source time, ms */
  t: number;
  faces: Face[];
}

export interface Detection {
  t: number;
  box: Face;
}

export interface Track {
  id: number;
  detections: Detection[];
  score: number;
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

export const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export interface TrackOptions {
  /** least overlap to continue a track */
  minIou: number;
  /** or: centres closer than this many face widths */
  maxJump: number;
  maxGapMs: number;
}

export const TRACKING: TrackOptions = { minIou: 0.2, maxJump: 1.5, maxGapMs: 2000 };

/** How well a face continues a track: IoU, or a little less for a close but non-overlapping box. */
function affinity(last: Box, face: Box, o: TrackOptions): number {
  const overlap = iou(last, face);
  if (overlap >= o.minIou) return 1 + overlap;
  const a = centre(last);
  const b = centre(face);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const size = Math.max(last.w, face.w);
  const similar = Math.min(last.w, face.w) / size > 0.6;
  return similar && dist <= o.maxJump * size ? 1 - dist / (o.maxJump * size) : 0;
}

export function buildTracks(samples: readonly Sample[], o: TrackOptions = TRACKING): Track[] {
  const tracks: Track[] = [];
  const open: Track[] = [];
  for (const s of [...samples].sort((a, b) => a.t - b.t)) {
    // close the tracks not seen for too long
    for (let i = open.length - 1; i >= 0; i--)
      if (s.t - open[i]!.detections.at(-1)!.t > o.maxGapMs) open.splice(i, 1);
    // greedy matching, best pairs first
    const pairs: { track: Track; face: number; a: number }[] = [];
    s.faces.forEach((f, face) => {
      for (const track of open) {
        const a = affinity(track.detections.at(-1)!.box, f, o);
        if (a > 0) pairs.push({ track, face, a });
      }
    });
    pairs.sort((p, q) => q.a - p.a);
    const usedTracks = new Set<Track>();
    const usedFaces = new Set<number>();
    for (const p of pairs) {
      if (usedTracks.has(p.track) || usedFaces.has(p.face)) continue;
      usedTracks.add(p.track);
      usedFaces.add(p.face);
      p.track.detections.push({ t: s.t, box: s.faces[p.face]! });
    }
    s.faces.forEach((f, face) => {
      if (usedFaces.has(face)) return;
      const track: Track = { id: tracks.length, detections: [{ t: s.t, box: f }], score: 0 };
      tracks.push(track);
      open.push(track);
    });
  }
  for (const t of tracks)
    t.score = t.detections.reduce((sum, d) => sum + d.box.w * d.box.h * Math.max(0.05, d.box.confidence), 0);
  return tracks;
}

export interface Followed {
  t: number;
  /** the face followed at this sample, or null when it is held or there is none yet */
  box: Face | null;
  track: number | null;
}

export interface SelectOptions {
  holdMs: number;
  /** a face present takes over from the followed one when it scores this many times more */
  takeover: number;
}

export const SELECTING: SelectOptions = { holdMs: 1500, takeover: 2 };

/** The face to follow at each sample time. */
export function selectMain(
  samples: readonly Sample[],
  tracks: readonly Track[],
  o: SelectOptions = SELECTING,
): Followed[] {
  // where each track was at each time
  const at = new Map<number, Map<number, Face>>();
  for (const tr of tracks)
    for (const d of tr.detections) {
      if (!at.has(d.t)) at.set(d.t, new Map());
      at.get(d.t)!.set(tr.id, d.box);
    }
  const score = (id: number) => tracks[id]!.score;
  let current: number | null = null;
  let lastSeen = -Infinity;
  return [...samples]
    .sort((a, b) => a.t - b.t)
    .map((s) => {
      const present = at.get(s.t) ?? new Map<number, Face>();
      const best = [...present.keys()].sort((a, b) => score(b) - score(a))[0];
      if (current !== null && present.has(current)) {
        if (best !== undefined && best !== current && score(best) > o.takeover * score(current))
          current = best;
      } else if (
        current === null ||
        s.t - lastSeen > o.holdMs ||
        // the speaker reappearing elsewhere (a jump the tracker couldn't bridge) is followed at once;
        // a face that matters less waits until the hold is over
        (best !== undefined && score(best) * o.takeover >= score(current))
      ) {
        current = best ?? current;
      }
      const box = current !== null ? (present.get(current) ?? null) : null;
      if (box) lastSeen = s.t;
      return { t: s.t, box, track: box ? current : null };
    });
}
