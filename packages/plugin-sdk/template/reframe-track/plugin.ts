// A reframe analyzer: for a 9:16 (or other) crop of a wider video, where the crop's centre should
// be over time. NodCut sends the source video and the parts of it the edit keeps; the plugin
// answers with keyframes (source time in ms, x and y as fractions of the frame).
import type { Keyframe, PluginDefinition } from '@nodcut/plugin-sdk';

/**
 * A placeholder: the centre of the frame at the start of every kept range. Replace it with your
 * own tracking: read frames of `source` (ffmpeg, OpenCV…) and follow what matters.
 */
export function centreKeyframes(ranges: { start: number; end: number }[]): Keyframe[] {
  const times = [...new Set(ranges.map((r) => r.start))].sort((a, b) => a - b);
  return times.map((t) => ({ t, x: 0.5, y: 0.5 }));
}

export const plugin: PluginDefinition = {
  reframeTrack: ({ source, aspect, ranges }, ctx) => {
    ctx.log(`reframing ${source} to ${aspect}`);
    return { keyframes: centreKeyframes(ranges), confidence: 0.1 };
  },
};
