import { describe, expect, test } from 'vitest';
import {
  captionLines,
  compose,
  CompositionSpecSchema,
  cover,
  layout,
  outputTime,
  pan,
  trackAt,
  type Segment,
} from './compose.js';

const segments: Segment[] = [
  { start: 1000, end: 3000 },
  { start: 5000, end: 6000 },
];
const media = {
  src: 'assets/source.mp4',
  width: 1920,
  height: 1080,
  hasAudio: true,
  gsap: 'vendor/gsap.min.js',
};
const spec = (over: Record<string, unknown> = {}) =>
  CompositionSpecSchema.parse({ width: 1920, height: 1080, segments, ...over });

describe('time', () => {
  test('segments are laid end to end on the output timeline', () => {
    expect(layout(segments)).toEqual({ starts: [0, 2000], durationMs: 3000 });
    expect(outputTime(segments, 1000)).toBe(0);
    expect(outputTime(segments, 2500)).toBe(1500);
    expect(outputTime(segments, 5500)).toBe(2500);
    expect(outputTime(segments, 4000)).toBeNull(); // cut
    expect(outputTime(segments, 3000)).toBeNull(); // a segment excludes its end
  });
});

describe('captions', () => {
  const words = [
    { text: 'One', start: 1000, end: 1200 },
    { text: 'two', start: 1300, end: 1500 },
    { text: 'three.', start: 1600, end: 1900 },
    { text: 'Four', start: 2000, end: 2200 },
    { text: 'cut', start: 3500, end: 4000 },
    { text: 'five', start: 5100, end: 5300 },
    { text: 'six', start: 5400, end: 5600 },
  ];

  test('words in cut parts are dropped; lines break at sentence ends, segment ends and the word limit', () => {
    const lines = captionLines(segments, words, 2);
    expect(lines.map((l) => l.words.map((w) => w.text))).toEqual([
      ['One', 'two'],
      ['three.'],
      ['Four'],
      ['five', 'six'],
    ]);
    expect(lines.map((l) => [l.start, l.end])).toEqual([
      [0, 600], // held until 'three.' starts
      [600, 1000],
      [1000, 2000], // 'Four' ends at 1200, held 800 ms, and the next line starts at 2100
      [2100, 3000], // the last line is held to the end (less than 800 ms away)
    ]);
  });

  test('a word straddling a cut is clipped to the kept part', () => {
    const [line] = captionLines(segments, [{ text: 'edge', start: 2500, end: 3300 }], 4);
    expect(line.words[0]).toEqual({ text: 'edge', start: 1500, end: 2000 });
    // one whose middle is in the cut is dropped
    expect(captionLines(segments, [{ text: 'gone', start: 2800, end: 3400 }], 4)).toEqual([]);
  });
});

describe('framing', () => {
  test('cover scales the footage to fill the stage', () => {
    expect(cover({ width: 1080, height: 1920 }, { width: 1920, height: 1080 })).toEqual({
      width: 1920 * (1920 / 1080),
      height: 1920,
    });
  });

  test('pan puts the crop centre mid-stage and never shows the edge', () => {
    const stage = { width: 1080, height: 1920 };
    const footage = cover(stage, { width: 1920, height: 1080 });
    expect(pan(stage, footage, { x: 0.5, y: 0.5 })).toEqual({ x: 540 - footage.width / 2, y: 0 });
    expect(pan(stage, footage, { x: 0, y: 0.5 })).toEqual({ x: 0, y: 0 });
    expect(pan(stage, footage, { x: 1, y: 1 })).toEqual({ x: 1080 - footage.width, y: 0 });
  });

  test('the track interpolates and holds beyond its ends', () => {
    const track = [
      { t: 1000, x: 0.2, y: 0.5 },
      { t: 3000, x: 0.6, y: 0.5 },
    ];
    expect(trackAt(track, 0)).toEqual({ x: 0.2, y: 0.5 });
    expect(trackAt(track, 2000).x).toBeCloseTo(0.4);
    expect(trackAt(track, 9000)).toEqual({ x: 0.6, y: 0.5 });
    expect(trackAt([], 5)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe('compose', () => {
  test('one trimmed video clip per segment, on the output timeline', () => {
    const c = compose(spec(), media);
    expect(c).toMatchObject({ durationMs: 3000, clips: 2, captionLines: 0 });
    expect(c.html).toContain(
      'data-composition-id="main" data-start="0" data-duration="3" data-width="1920" data-height="1080" data-fps="30"',
    );
    expect(c.html).toContain(
      '<video id="clip-1-video" class="clip" src="assets/source.mp4" data-start="0" data-duration="2" data-media-start="1"',
    );
    expect(c.html).toContain(
      '<video id="clip-2-video" class="clip" src="assets/source.mp4" data-start="2" data-duration="1" data-media-start="5"',
    );
    expect(c.html).toContain(
      'data-media-start="5" data-has-audio="true" data-volume="1" data-track-index="1"',
    );
    // still footage is placed in CSS; a silent source is muted
    expect(c.html).toContain('<div id="clip-1" class="footage" style="left: 0px; top: 0px">');
    expect(compose(spec(), { ...media, hasAudio: false }).html).toContain(
      'data-media-start="1" muted data-track-index="1"',
    );
    expect(c.html).toContain('<script src="vendor/gsap.min.js"></script>');
    expect(c.html).toContain('window.__timelines["main"] = tl;');
  });

  test('the reframe track becomes a linear pan per clip, in output time', () => {
    const c = compose(
      spec({
        width: 1080,
        height: 1920,
        crop: [
          { t: 0, x: 0.25, y: 0.5 },
          { t: 2000, x: 0.25, y: 0.5 },
          { t: 4000, x: 0.75, y: 0.5 },
        ],
      }),
      media,
    );
    const footage = cover({ width: 1080, height: 1920 }, media);
    const at = (x: number) => pan({ width: 1080, height: 1920 }, footage, { x, y: 0.5 }).x.toFixed(2);
    // clip 1 covers source 1000–3000: still until 2000, then moves to where the track is at 3000
    expect(c.html).toContain(`tl.set("#clip-1", { x: ${at(0.25)}, y: 0.00 }, 0);`);
    expect(c.html).toContain(`tl.to("#clip-1", { x: ${at(0.5)}, y: 0.00, duration: 1, ease: "none" }, 1);`);
    // clip 2 (source 5000–6000) is past the last keyframe: nothing moves
    expect(c.html).toContain(`tl.set("#clip-2", { x: ${at(0.75)}, y: 0.00 }, 2);`);
    expect(c.html).not.toContain('tl.to("#clip-2"');
    // panned footage is placed only by the timeline (GSAP owns its transform)
    expect(c.html).toContain('<div id="clip-1" class="footage">');
  });

  test('captions are timed DOM clips; karaoke lights each word; text is escaped', () => {
    const c = compose(
      spec({
        words: [
          { text: '<b>&', start: 1000, end: 1200 },
          { text: 'two', start: 1300, end: 1500 },
        ],
        captions: { style: 'karaoke', position: 'top' },
        title: { text: 'A "title"', subtitle: 'sub', durationMs: 1000 },
      }),
      media,
    );
    expect(c.captionLines).toBe(1);
    expect(c.html).toContain(
      '<p id="cap-1" class="clip caption" data-start="0" data-duration="1.3" data-track-index="2"><span id="cap-1-1">&lt;b&gt;&amp;</span> <span id="cap-1-2">two</span></p>',
    );
    expect(c.html).toContain('tl.set("#cap-1-1", { color: ACCENT, scale: 1.08 }, 0);');
    expect(c.html).toContain('tl.set("#cap-1-2", { color: INK, scale: 1 }, 0.5);');
    expect(c.html).toContain(
      '<h1 id="title" class="clip title" data-start="0" data-duration="1" data-track-index="3">A &quot;title&quot;<small>sub</small></h1>',
    );
    expect(c.html).toContain('.caption { z-index: 2; top: 8%;');
  });
});
