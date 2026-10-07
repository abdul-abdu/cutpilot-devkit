/**
 * Pexels' API as the footage contract wants it: search photos and videos (bounded, nothing
 * downloaded), look one item up again by id, pick the rendition that covers the output, and
 * download it to a local file. Every request goes through `fetch` (injectable for tests) with the
 * user's own key, and every failure becomes a PluginFailure with a fix the user can act on.
 * Docs: https://www.pexels.com/api/documentation/ (terms and limits change; the README links them).
 */
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PluginFailure } from '@nodcut/plugin-sdk';
import { z } from 'zod';

export const API = 'https://api.pexels.com';
export const LICENSE = 'Pexels License';
export const LICENSE_URL = 'https://www.pexels.com/license/';
export const KEYS_URL = 'https://www.pexels.com/api/';
export const KEYS_PLACE = 'NodCut → Plugins → Pexels stock footage → Keys';
/** where media files may come from: the manifest's hosts other than the API */
export const MEDIA_HOSTS = ['images.pexels.com', 'videos.pexels.com'];
/** the largest file it downloads (a 4K clip is far smaller); a bigger one is refused */
export const MAX_BYTES = 1024 * 1024 * 1024;

export interface Transport {
  fetch: typeof fetch;
  /** every request goes to this origin instead of Pexels' (a local stub in tests) */
  origin?: string;
  signal?: AbortSignal;
  /** where downloads are kept (default: a folder in the system's temp folder) */
  dir?: string;
}

// ── Pexels' answers (only what is used; Pexels may add fields) ───────────────

const PhotoSchema = z.object({
  id: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string().url(),
  photographer: z.string(),
  photographer_url: z.string().url().optional(),
  alt: z.string().optional(),
  src: z.object({
    original: z.string().url(),
    large2x: z.string().url(),
    large: z.string().url(),
    medium: z.string().url(),
    small: z.string().url().optional(),
    tiny: z.string().url().optional(),
  }),
});
export type Photo = z.infer<typeof PhotoSchema>;

const VideoFileSchema = z.object({
  id: z.number().int(),
  quality: z.string().nullable().optional(),
  file_type: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  link: z.string().url(),
});
const VideoSchema = z.object({
  id: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** whole seconds */
  duration: z.number().nonnegative(),
  url: z.string().url(),
  image: z.string().url(),
  user: z.object({ name: z.string(), url: z.string().url().optional() }),
  video_files: z.array(VideoFileSchema),
});
export type Video = z.infer<typeof VideoSchema>;

const PhotoPageSchema = z.object({ photos: z.array(PhotoSchema), next_page: z.string().optional() });
const VideoPageSchema = z.object({ videos: z.array(VideoSchema), next_page: z.string().optional() });

// ── requests ─────────────────────────────────────────────────────────────────

export const missingKey = () =>
  new PluginFailure(
    'E_PLUGIN_NEEDS_SECRET',
    'no Pexels API key',
    `make a free key at ${KEYS_URL}, then enter it in ${KEYS_PLACE}`,
  );

async function failure(res: Response): Promise<PluginFailure> {
  if (res.status === 401 || res.status === 403)
    return new PluginFailure(
      'E_PEXELS_BAD_KEY',
      `Pexels refused the API key (HTTP ${res.status})`,
      `check the key in ${KEYS_PLACE}, or make a new one at ${KEYS_URL}`,
    );
  if (res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    const when =
      Number.isFinite(reset) && reset > 0 ? ` (it resets at ${new Date(reset * 1000).toISOString()})` : '';
    return new PluginFailure(
      'E_PEXELS_RATE_LIMITED',
      `Pexels' request limit for this key is used up${when}`,
      'wait until it resets, then search again; Pexels can raise the limit for an approved app (see the plugin README)',
    );
  }
  if (res.status === 404)
    return new PluginFailure(
      'E_PEXELS_NOT_FOUND',
      'Pexels has no such item any more',
      'search again and pick another one',
    );
  return new PluginFailure(
    'E_PEXELS_FAILED',
    `Pexels answered HTTP ${res.status}`,
    'try again in a minute; if it keeps failing, check status.pexels.com',
  );
}

async function get<T>(t: Transport, key: string, path: string, schema: z.ZodType<T>): Promise<T> {
  const url = `${t.origin ?? API}${path}`;
  let res: Response;
  try {
    res = await t.fetch(url, { headers: { Authorization: key }, ...(t.signal ? { signal: t.signal } : {}) });
  } catch (e) {
    if (t.signal?.aborted)
      throw new PluginFailure('E_PEXELS_CANCELLED', 'cancelled', 'ask again when you need it');
    throw new PluginFailure(
      'E_PEXELS_OFFLINE',
      `could not reach Pexels: ${(e as Error).message}`,
      'check the internet connection and try again',
    );
  }
  if (!res.ok) throw await failure(res);
  const parsed = schema.safeParse(await res.json().catch(() => null));
  if (!parsed.success)
    throw new PluginFailure(
      'E_PEXELS_FAILED',
      'Pexels answered in a shape this plugin does not know',
      'update the plugin; if it is current, report it',
    );
  return parsed.data;
}

// ── search ───────────────────────────────────────────────────────────────────

export interface Search {
  query: string;
  kind?: 'image' | 'video' | undefined;
  orientation?: 'landscape' | 'portrait' | 'square' | undefined;
  minDurationMs?: number | undefined;
  page?: number | undefined;
  limit?: number | undefined;
}

const credit = (kind: 'image' | 'video', name: string) =>
  `${kind === 'video' ? 'Video' : 'Photo'} by ${name} on Pexels`;

export const fromPhoto = (p: Photo) => ({
  id: String(p.id),
  kind: 'image' as const,
  width: p.width,
  height: p.height,
  thumbnail: p.src.medium,
  provider: 'Pexels',
  sourceUrl: p.url,
  creator: p.photographer,
  ...(p.photographer_url ? { creatorUrl: p.photographer_url } : {}),
  license: LICENSE,
  licenseUrl: LICENSE_URL,
  attribution: credit('image', p.photographer),
});

export const fromVideo = (v: Video) => ({
  id: String(v.id),
  kind: 'video' as const,
  width: v.width,
  height: v.height,
  durationMs: Math.max(1, Math.round(v.duration * 1000)),
  thumbnail: v.image,
  provider: 'Pexels',
  sourceUrl: v.url,
  creator: v.user.name,
  ...(v.user.url ? { creatorUrl: v.user.url } : {}),
  license: LICENSE,
  licenseUrl: LICENSE_URL,
  attribution: credit('video', v.user.name),
});

/** One page of candidates: photos, videos, or both interleaved; at most `limit` (default 10). */
export async function search(t: Transport, key: string, s: Search) {
  const limit = Math.min(30, s.limit ?? 10);
  const page = s.page ?? 1;
  const both = !s.kind;
  // asking both kinds splits the page between them, so one search stays one bounded page
  const per = both ? Math.max(1, Math.ceil(limit / 2)) : limit;
  const q = (extra: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams({ query: s.query, per_page: String(per), page: String(page) });
    if (s.orientation) p.set('orientation', s.orientation);
    for (const [k, v] of Object.entries(extra)) if (v !== undefined) p.set(k, String(v));
    return p.toString();
  };
  const [photos, videos] = await Promise.all([
    s.kind === 'video' ? null : get(t, key, `/v1/search?${q({})}`, PhotoPageSchema),
    s.kind === 'image'
      ? null
      : get(
          t,
          key,
          `/videos/search?${q({ min_duration: s.minDurationMs ? Math.ceil(s.minDurationMs / 1000) : undefined })}`,
          VideoPageSchema,
        ),
  ]);
  const a = (photos?.photos ?? []).map(fromPhoto);
  const b = (videos?.videos ?? [])
    .filter((v) => !s.minDurationMs || v.duration * 1000 >= s.minDurationMs)
    .map(fromVideo);
  const items: (ReturnType<typeof fromPhoto> | ReturnType<typeof fromVideo>)[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (b[i]) items.push(b[i]!);
    if (a[i]) items.push(a[i]!);
  }
  const more = !!(photos?.next_page || videos?.next_page);
  return { items: items.slice(0, limit), ...(more && page < 100 ? { nextPage: page + 1 } : {}) };
}

/** A key check that downloads nothing and costs nothing: one curated photo's details. */
export async function checkKey(t: Transport, key: string | undefined) {
  if (!key) throw missingKey();
  await get(t, key, '/v1/curated?per_page=1', PhotoPageSchema);
  return { ok: true, text: 'The Pexels API key works.' };
}

// ── retrieval ────────────────────────────────────────────────────────────────

export interface Rendition {
  url: string;
  width: number;
  height: number;
  ext: 'jpg' | 'mp4';
}

/**
 * The photo file worth fetching: Pexels resizes on request, so ask for the original fitted
 * inside the output size (never larger than the original).
 */
export function photoRendition(p: Photo, maxWidth?: number, maxHeight?: number): Rendition {
  const k = Math.min(1, maxWidth ? maxWidth / p.width : 1, maxHeight ? maxHeight / p.height : 1);
  const width = Math.max(1, Math.round(p.width * k));
  const height = Math.max(1, Math.round(p.height * k));
  if (k === 1) return { url: p.src.original, width: p.width, height: p.height, ext: 'jpg' };
  const u = new URL(p.src.original);
  u.searchParams.set('auto', 'compress');
  u.searchParams.set('cs', 'tinysrgb');
  u.searchParams.set('w', String(width));
  u.searchParams.set('h', String(height));
  return { url: u.toString(), width, height, ext: 'jpg' };
}

/**
 * The video file worth fetching: an MP4 (not a stream playlist) that covers the output, the
 * smallest that does; the largest when none does. Sizes are compared on the long and short
 * sides, so a portrait output can use a landscape file Fill will crop.
 */
export function videoRendition(v: Video, maxWidth?: number, maxHeight?: number): Rendition {
  const mp4 = v.video_files.filter((f) => f.file_type === 'video/mp4' && f.width && f.height);
  if (!mp4.length)
    throw new PluginFailure(
      'E_PEXELS_NO_FILE',
      `Pexels video ${v.id} has no MP4 file to download`,
      'pick another video',
    );
  const area = (f: (typeof mp4)[number]) => f.width! * f.height!;
  const covers = (f: (typeof mp4)[number]) =>
    (!maxWidth || Math.max(f.width!, f.height!) >= Math.max(maxWidth, maxHeight ?? 0)) &&
    (!maxHeight || Math.min(f.width!, f.height!) >= Math.min(maxWidth ?? Infinity, maxHeight));
  const big = [...mp4].sort((a, b) => area(a) - area(b));
  const f = big.find(covers) ?? big[big.length - 1]!;
  return { url: f.link, width: f.width!, height: f.height!, ext: 'mp4' };
}

export const lookUp = (t: Transport, key: string, kind: 'image' | 'video', id: string) =>
  kind === 'image'
    ? get(t, key, `/v1/photos/${encodeURIComponent(id)}`, PhotoSchema)
    : get(t, key, `/videos/videos/${encodeURIComponent(id)}`, VideoSchema);

/** A downloaded rendition, named by what it is, so the same pick downloads once. */
export async function download(
  t: Transport,
  r: Rendition,
): Promise<{ file: string; sha256: string; reused: boolean }> {
  const url = new URL(r.url);
  const allowed = t.origin
    ? new URL(t.origin).host === url.host
    : MEDIA_HOSTS.includes(url.hostname) && url.protocol === 'https:';
  if (!allowed)
    throw new PluginFailure(
      'E_PEXELS_UNEXPECTED_HOST',
      `Pexels pointed at a file on ${url.hostname}`,
      'nothing was downloaded; report it if it keeps happening',
    );
  const dir = t.dir ?? join(tmpdir(), 'nodcut-pexels');
  mkdirSync(dir, { recursive: true });
  const name = createHash('sha256').update(r.url).digest('hex').slice(0, 24);
  const file = join(dir, `${name}.${r.ext}`);
  const sum = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
  if (existsSync(file) && statSync(file).size > 0) return { file, sha256: sum(file), reused: true };
  let res: Response;
  try {
    res = await t.fetch(r.url, t.signal ? { signal: t.signal } : {});
  } catch (e) {
    if (t.signal?.aborted)
      throw new PluginFailure(
        'E_PEXELS_CANCELLED',
        'the download was cancelled',
        'pick it again to download it',
      );
    throw new PluginFailure(
      'E_PEXELS_OFFLINE',
      `could not download from Pexels: ${(e as Error).message}`,
      'check the internet connection and try again',
    );
  }
  if (!res.ok || !res.body) throw await failure(res);
  const type = res.headers.get('content-type') ?? '';
  if (!(r.ext === 'mp4' ? /^video\//.test(type) : /^image\//.test(type)))
    throw new PluginFailure(
      'E_PEXELS_FAILED',
      `Pexels sent ${type || 'no type'} instead of ${r.ext === 'mp4' ? 'a video' : 'a picture'}`,
      'pick it again; if it keeps happening, pick another item',
    );
  const length = Number(res.headers.get('content-length'));
  if (length > MAX_BYTES)
    throw new PluginFailure(
      'E_PEXELS_TOO_BIG',
      `the file is ${Math.round(length / 1e6)} MB`,
      'pick a smaller rendition or another item',
    );
  // a random part name next to the target, renamed only once the whole file is there
  const part = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.part`;
  try {
    let seen = 0;
    const counted = Readable.fromWeb(res.body as never).on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_BYTES) counted.destroy(new Error('too big'));
    });
    await pipeline(counted, createWriteStream(part), t.signal ? { signal: t.signal } : {});
    if (length && seen !== length)
      throw new PluginFailure(
        'E_PEXELS_FAILED',
        `the download stopped at ${seen} of ${length} bytes`,
        'pick it again to download it',
      );
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    if (e instanceof PluginFailure) throw e;
    if (t.signal?.aborted)
      throw new PluginFailure(
        'E_PEXELS_CANCELLED',
        'the download was cancelled',
        'pick it again to download it',
      );
    throw new PluginFailure(
      'E_PEXELS_FAILED',
      `the download failed: ${(e as Error).message}`,
      'pick it again to download it',
    );
  }
  return { file, sha256: sum(file), reused: false };
}
