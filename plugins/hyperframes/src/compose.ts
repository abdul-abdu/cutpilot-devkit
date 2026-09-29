/**
 * A CutPilot edit as a HyperFrames composition. Pure: takes the edit and what ffprobe said about
 * the source, returns the HTML. HyperFrames times are seconds on the OUTPUT timeline; CutPilot's
 * are integer milliseconds in SOURCE time, so every time here goes through the segment map.
 *
 * The mapping, which is what this research plugin is about:
 * - each kept segment is a <video class="clip"> of the untouched source, trimmed with
 *   data-media-start and placed at its output time;
 * - the reframe track (crop centres over source time) becomes a GSAP timeline that pans the
 *   footage inside the stage, so a 9:16 cut of 16:9 footage follows the speaker;
 * - words become caption lines: timed DOM clips, optionally with the spoken word lit up;
 * - a title card is a DOM clip too.
 * Nothing is fetched at render time: gsap is copied into the project, fonts are the system's.
 */
import { z } from 'zod';

const Ms = z.number().int().nonnegative();
const Fraction = z.number().min(0).max(1);

export const SegmentSchema = z
  .object({ start: Ms, end: Ms })
  .refine((s) => s.end > s.start, 'a segment ends after it starts');
export type Segment = z.infer<typeof SegmentSchema>;

export const WordSchema = z.object({ text: z.string().min(1), start: Ms, end: Ms });
export type Word = z.infer<typeof WordSchema>;

export const CaptionsSchema = z.object({
  /** lines: a few words at a time; karaoke: the same, with the spoken word lit up */
  style: z.enum(['lines', 'karaoke']).default('lines'),
  wordsPerLine: z.number().int().min(1).max(12).default(4),
  position: z.enum(['top', 'center', 'bottom']).default('bottom'),
});

export const KeyframeSchema = z.object({ t: Ms, x: Fraction, y: Fraction });
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const TitleSchema = z.object({
  text: z.string().min(1).max(120),
  subtitle: z.string().min(1).max(200).optional(),
  durationMs: z.number().int().min(500).max(15000).default(2500),
});

export const CompositionSpecSchema = z.object({
  /** the HyperFrames composition id */
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, 'ids are kebab-case')
    .default('main'),
  width: z.number().int().min(16).max(7680),
  height: z.number().int().min(16).max(7680),
  fps: z.number().int().min(1).max(120).default(30),
  /** the kept parts of the source in the order they play (source ms) */
  segments: z.array(SegmentSchema).min(1),
  /** the transcript (source ms); only words inside a kept part are shown */
  words: z.array(WordSchema).default([]),
  captions: CaptionsSchema.optional(),
  /** the reframe track: crop centres as fractions of the source frame, over source time */
  crop: z.array(KeyframeSchema).optional(),
  title: TitleSchema.optional(),
});
export type CompositionSpec = z.infer<typeof CompositionSpecSchema>;

/** The source as the project sees it. */
export interface Media {
  /** project-relative path of the footage */
  src: string;
  width: number;
  height: number;
  /** whether the footage's sound is used (a silent source is marked muted, as the linter wants) */
  hasAudio: boolean;
  /** project-relative path of gsap.min.js */
  gsap: string;
}

export interface Composition {
  html: string;
  durationMs: number;
  clips: number;
  captionLines: number;
}

// ── time ─────────────────────────────────────────────────────────────────────

/** Where each segment starts on the output timeline (ms), and the output length. */
export function layout(segments: readonly Segment[]): { starts: number[]; durationMs: number } {
  const starts: number[] = [];
  let t = 0;
  for (const s of segments) {
    starts.push(t);
    t += s.end - s.start;
  }
  return { starts, durationMs: t };
}

/** The segment a source moment falls in (a segment includes its start, not its end), or -1. */
export function segmentAt(segments: readonly Segment[], sourceMs: number): number {
  return segments.findIndex((s) => sourceMs >= s.start && sourceMs < s.end);
}

/** Source ms → output ms, or null when that moment is cut. */
export function outputTime(segments: readonly Segment[], sourceMs: number): number | null {
  const i = segmentAt(segments, sourceMs);
  if (i < 0) return null;
  return layout(segments).starts[i] + (sourceMs - segments[i].start);
}

const sec = (ms: number) => (Math.round(ms) / 1000).toString();

// ── captions ─────────────────────────────────────────────────────────────────

export interface PlacedWord {
  text: string;
  /** output ms */
  start: number;
  end: number;
}
export interface CaptionLine {
  start: number;
  end: number;
  words: PlacedWord[];
}

/** A line stays up until the next one comes, but not longer than this after its last word. */
const HOLD_MS = 800;
/** A silence this long starts a new line. */
const GAP_MS = 1200;

/** Words in output time, grouped into lines. A word is shown when its middle is in a kept part. */
export function captionLines(
  segments: readonly Segment[],
  words: readonly Word[],
  wordsPerLine: number,
): CaptionLine[] {
  const { starts, durationMs } = layout(segments);
  const placed: (PlacedWord & { seg: number })[] = [];
  for (const w of words) {
    const seg = segmentAt(segments, (w.start + w.end) / 2);
    if (seg < 0) continue;
    const s = segments[seg];
    const clamp = (t: number) => Math.min(Math.max(t, s.start), s.end) - s.start + starts[seg];
    placed.push({
      text: w.text,
      seg,
      start: clamp(w.start),
      end: Math.max(clamp(w.end), clamp(w.start) + 1),
    });
  }

  const lines: (CaptionLine & { seg: number })[] = [];
  let line: (CaptionLine & { seg: number }) | null = null;
  for (const w of placed) {
    if (line && (line.words.length >= wordsPerLine || line.seg !== w.seg || w.start - line.end > GAP_MS))
      line = null;
    if (!line) {
      line = { seg: w.seg, start: w.start, end: w.end, words: [] };
      lines.push(line);
    }
    line.words.push({ text: w.text, start: w.start, end: w.end });
    line.end = Math.max(line.end, w.end);
    if (/[.!?…]["')]*$/.test(w.text)) line = null;
  }
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1]?.start ?? durationMs;
    lines[i].end = Math.min(Math.max(lines[i].end, Math.min(next, lines[i].end + HOLD_MS)), durationMs);
  }
  return lines.map(({ start, end, words }) => ({ start, end, words }));
}

// ── framing ──────────────────────────────────────────────────────────────────

export interface Size {
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

/** The footage scaled to cover the stage (like object-fit: cover). */
export function cover(stage: Size, source: Size): Size {
  const scale = Math.max(stage.width / source.width, stage.height / source.height);
  return { width: source.width * scale, height: source.height * scale };
}

/** Where the (covering) footage's top-left goes so the crop centre (x, y) sits mid-stage. */
export function pan(stage: Size, footage: Size, centre: Point): Point {
  const clamp = (v: number, min: number) => Math.min(0, Math.max(min, v));
  return {
    x: clamp(stage.width / 2 - centre.x * footage.width, stage.width - footage.width),
    y: clamp(stage.height / 2 - centre.y * footage.height, stage.height - footage.height),
  };
}

/** The crop centre at a source time: linear between keyframes, held beyond the ends. */
export function trackAt(track: readonly Keyframe[], t: number): Point {
  if (!track.length) return { x: 0.5, y: 0.5 };
  if (t <= track[0].t) return { x: track[0].x, y: track[0].y };
  const last = track[track.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };
  const i = track.findIndex((k) => k.t > t);
  const a = track[i - 1];
  const b = track[i];
  const f = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ── html ─────────────────────────────────────────────────────────────────────

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const js = (s: string) => JSON.stringify(s);

export function compose(spec: CompositionSpec, media: Media): Composition {
  const stage = { width: spec.width, height: spec.height };
  const footage = cover(stage, media);
  const track = [...(spec.crop ?? [])].sort((a, b) => a.t - b.t);
  const { starts, durationMs } = layout(spec.segments);
  const body: string[] = [];
  const timeline: string[] = [];

  // Footage: one clip per kept part, in a wrapper each so the pan animates the wrapper, not the
  // video. Still footage is placed with left/top; panned footage only by the timeline, since
  // GSAP owns an element's transform once it tweens x/y (the linter checks this).
  const sound = media.hasAudio ? 'data-has-audio="true" data-volume="1"' : 'muted';
  spec.segments.forEach((s, i) => {
    const id = `clip-${i + 1}`;
    const at = (t: number) => pan(stage, footage, trackAt(track, t));
    const first = at(s.start);
    const place = track.length ? '' : ` style="left: ${px(first.x)}; top: ${px(first.y)}"`;
    body.push(
      `    <div id="${id}" class="footage"${place}>`,
      `      <video id="${id}-video" class="clip" src="${esc(media.src)}" data-start="${sec(starts[i])}" data-duration="${sec(s.end - s.start)}" data-media-start="${sec(s.start)}" ${sound} data-track-index="1" preload="auto" playsinline></video>`,
      `    </div>`,
    );
    if (!track.length) return;
    const times = [s.start, ...track.map((k) => k.t).filter((t) => t > s.start && t < s.end), s.end];
    timeline.push(
      `  tl.set("#${id}", { x: ${first.x.toFixed(2)}, y: ${first.y.toFixed(2)} }, ${sec(starts[i])});`,
    );
    for (let k = 1; k < times.length; k++) {
      const p = at(times[k]);
      const prev = at(times[k - 1]);
      if (p.x === prev.x && p.y === prev.y) continue;
      timeline.push(
        `  tl.to("#${id}", { x: ${p.x.toFixed(2)}, y: ${p.y.toFixed(2)}, duration: ${sec(times[k] - times[k - 1])}, ease: "none" }, ${sec(starts[i] + times[k - 1] - s.start)});`,
      );
    }
  });

  // Title card: one element (the linter wants timed elements flat), centred by GSAP (yPercent)
  // because GSAP also fades it in with a small rise.
  if (spec.title) {
    const d = Math.min(spec.title.durationMs, durationMs);
    const sub = spec.title.subtitle ? `<small>${esc(spec.title.subtitle)}</small>` : '';
    body.push(
      `    <h1 id="title" class="clip title" data-start="0" data-duration="${sec(d)}" data-track-index="3">${esc(spec.title.text)}${sub}</h1>`,
    );
    timeline.push(
      `  tl.fromTo("#title", { opacity: 0, yPercent: -50, y: 24 }, { opacity: 1, yPercent: -50, y: 0, duration: 0.4, ease: "power2.out" }, 0);`,
      `  tl.to("#title", { opacity: 0, duration: 0.3, ease: "none" }, ${sec(Math.max(0, d - 300))});`,
    );
  }

  // Captions: a timed <p> per line; karaoke lights the spoken word with the timeline.
  const captions = spec.captions ?? CaptionsSchema.parse({});
  const lines = spec.words.length ? captionLines(spec.segments, spec.words, captions.wordsPerLine) : [];
  lines.forEach((line, i) => {
    const id = `cap-${i + 1}`;
    const words = line.words.map((w, k) => `<span id="${id}-${k + 1}">${esc(w.text)}</span>`).join(' ');
    body.push(
      `    <p id="${id}" class="clip caption" data-start="${sec(line.start)}" data-duration="${sec(line.end - line.start)}" data-track-index="2">${words}</p>`,
    );
    if (captions.style === 'karaoke')
      line.words.forEach((w, k) => {
        const sel = `#${id}-${k + 1}`;
        timeline.push(
          `  tl.set(${js(sel)}, { color: ACCENT, scale: 1.08 }, ${sec(w.start)});`,
          `  tl.set(${js(sel)}, { color: INK, scale: 1 }, ${sec(w.end)});`,
        );
      });
  });

  const captionPlace = {
    top: 'top: 8%;',
    center: 'top: 50%; transform: translateY(-50%);',
    bottom: 'bottom: 8%;',
  }[captions.position];
  const fontPx = Math.round(Math.min(spec.width, spec.height) / 16);
  const font = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${spec.width}, height=${spec.height}" />
    <title>CutPilot edit</title>
    <script src="${esc(media.gsap)}"></script>
    <style>
      :root { --ink: #ffffff; --accent: #ffd400; }
      body { margin: 0; background: #000; }
      #root { position: relative; width: ${spec.width}px; height: ${spec.height}px; overflow: hidden; background: #000; }
      .footage { position: absolute; left: 0; top: 0; width: ${px(footage.width)}; height: ${px(footage.height)}; will-change: transform; }
      .footage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; }
      .clip { position: absolute; }
      .caption, .title { margin: 0; left: 8%; right: 8%; text-align: center; color: var(--ink); font-family: ${font}; text-wrap: balance; }
      .caption { z-index: 2; ${captionPlace} font-size: ${fontPx}px; font-weight: 700; line-height: 1.25; }
      .caption span { display: inline-block; padding: 0.1em 0.3em; border-radius: 0.3em; background: rgba(0, 0, 0, 0.55); }
      .title { z-index: 3; top: 50%; font-size: ${Math.round(fontPx * 1.6)}px; font-weight: 800; line-height: 1.1; text-shadow: 0 2px 12px rgba(0, 0, 0, 0.6); }
      .title small { display: block; margin-top: 0.4em; font-size: ${Math.round(fontPx * 0.7)}px; font-weight: 400; opacity: 0.85; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="${spec.id}" data-start="0" data-duration="${sec(durationMs)}" data-width="${spec.width}" data-height="${spec.height}" data-fps="${spec.fps}">
${body.join('\n')}
    </div>
    <script>
      // Seekable: HyperFrames scrubs this timeline to each frame's time and captures it.
      window.__timelines = window.__timelines || {};
      (function () {
        var INK = "#ffffff", ACCENT = "#ffd400";
        var tl = gsap.timeline({ paused: true });
${timeline.length ? timeline.map((l) => `      ${l.trim()}`).join('\n') : '      // nothing animates'}
        window.__timelines[${js(spec.id)}] = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, durationMs, clips: spec.segments.length, captionLines: lines.length };
}
