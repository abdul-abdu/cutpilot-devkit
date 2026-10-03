/**
 * The plugin: an `analyzer:reframe-track` that runs the face helper over the kept ranges of
 * the edit and turns its faces into a calm crop path that follows the main speaker.
 */
import type { PluginDefinition } from '@cutpilot/plugin-sdk';
import { follow, mergeRanges } from './follow.js';
import { detectFaces, helperPath } from './helper.js';

/** Frames per second the helper looks at, unless CutPilot asks for another rate. */
export const DEFAULT_FPS = 5;

export interface Options {
  /** the helper to run; default: helperPath() ($CUTPILOT_FACE_HELPER, else bin/face-helper on a Mac) */
  helper?: string;
}

export function makeDefinition(o: Options = {}): PluginDefinition {
  return {
    reframeTrack: async (input, ctx) => {
      const helper = o.helper ?? helperPath();
      const ranges = mergeRanges(input.ranges);
      const fps = input.sampleFps ?? DEFAULT_FPS;
      ctx.progress(0, 'finding faces');
      const found = await detectFaces(helper, input.source, ranges, fps, {
        signal: ctx.signal,
        onProgress: (f) => ctx.progress(f * 0.95, 'finding faces'),
      });
      const r = follow(found.samples, ranges, { aspect: input.aspect, sourceAspect: found.sourceAspect });
      ctx.log(
        `${found.samples.length} samples, ${r.keyframes.length} keyframes, confidence ${r.confidence} (${input.aspect})`,
      );
      ctx.progress(1);
      return r;
    },
  };
}

export const definition = makeDefinition();
