/**
 * The plugin: an `asset:footage` provider for Pexels with the user's own key. find_footage is
 * one bounded search page and downloads nothing; get_footage looks the picked item up again
 * (so a stale id fails instead of downloading something else), picks the rendition that covers
 * the output, and downloads exactly that file. `test_key` checks the key for the app's button.
 */
import { type ExtraTool, type PluginContext, type PluginDefinition } from '@nodcut/plugin-sdk';
import {
  checkKey,
  download,
  fromPhoto,
  fromVideo,
  lookUp,
  photoRendition,
  search,
  videoRendition,
  type Photo,
  type Transport,
  type Video,
} from './pexels.js';

/** For tests: send every request to this origin (a local stub) instead of Pexels'. */
export const ORIGIN_ENV = 'NODCUT_PEXELS_ORIGIN';
export const SECRET = 'PEXELS_API_KEY';

export interface Options {
  fetch?: typeof fetch;
  /** default: $NODCUT_PEXELS_ORIGIN, else Pexels' own */
  origin?: string;
  /** where downloads go (default: a temp folder) */
  dir?: string;
}

export function makeDefinition(o: Options = {}): PluginDefinition {
  const transport = (ctx: PluginContext): Transport => ({
    fetch: o.fetch ?? globalThis.fetch,
    ...((o.origin ?? process.env[ORIGIN_ENV]) ? { origin: o.origin ?? process.env[ORIGIN_ENV]! } : {}),
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    ...(o.dir ? { dir: o.dir } : {}),
  });

  const testKey: ExtraTool = {
    description: 'Check the Pexels API key with one small request. Downloads no media and costs nothing.',
    input: {},
    handler: async (_args, ctx) => checkKey(transport(ctx), ctx.secret(SECRET)),
  };

  return {
    findFootage: async (input, ctx) => {
      const key = ctx.requireSecret(SECRET);
      ctx.log(`searching Pexels for ${JSON.stringify(input.query)}${input.kind ? ` (${input.kind})` : ''}`);
      return search(transport(ctx), key, input);
    },
    getFootage: async (input, ctx) => {
      const key = ctx.requireSecret(SECRET);
      const t = transport(ctx);
      ctx.progress(0.05, 'looking it up on Pexels');
      const item = await lookUp(t, key, input.kind, input.id);
      const r =
        input.kind === 'image'
          ? photoRendition(item as Photo, input.maxWidth, input.maxHeight)
          : videoRendition(item as Video, input.maxWidth, input.maxHeight);
      ctx.progress(0.1, `downloading ${r.width}×${r.height}`);
      const got = await download(t, r);
      ctx.log(
        `${got.reused ? 'reused' : 'downloaded'} ${input.kind} ${input.id} (${got.sha256.slice(0, 12)})`,
      );
      ctx.progress(1, 'done');
      const {
        id: _id,
        thumbnail: _thumbnail,
        width: _w,
        height: _h,
        ...provenance
      } = input.kind === 'image' ? fromPhoto(item as Photo) : fromVideo(item as Video);
      return { file: got.file, width: r.width, height: r.height, ...provenance };
    },
    tools: { test_key: testKey },
  };
}

export const definition = makeDefinition();
