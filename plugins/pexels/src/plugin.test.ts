/**
 * The Pexels plugin against a local HTTP stub that answers like Pexels' API (made-up items,
 * no real media): search, key checks, limits, rate limits, retrieval of the picked rendition,
 * reuse, cancellation and partial downloads; then the plugin as NodCut starts it through
 * testPlugin() (needs `pnpm build`). No key, no network.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { definePlugin, formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeDefinition, ORIGIN_ENV } from './plugin.js';
import { photoRendition, videoRendition, type Photo, type Video } from './pexels.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'cp-pexels-'));

/** what the stub answers: per-test switches */
const stub = {
  status: 200 as number,
  /** the next media download stops after this many bytes */
  cut: null as number | null,
  /** hold the next media download until released */
  hold: null as null | (() => void),
  calls: [] as { path: string; auth: string | undefined }[],
  origin: '',
};
let server: Server;

const photo = (id: number, origin: string) => ({
  id,
  width: 4000,
  height: 3000,
  url: `https://www.pexels.com/photo/test-${id}/`,
  photographer: 'Ana Example',
  photographer_url: 'https://www.pexels.com/@ana',
  alt: 'test',
  src: {
    original: `${origin}/media/photo-${id}.jpeg`,
    large2x: `${origin}/media/photo-${id}-l2.jpeg`,
    large: `${origin}/media/photo-${id}-l.jpeg`,
    medium: `${origin}/media/photo-${id}-m.jpeg`,
  },
});
const video = (id: number, origin: string, seconds = 12) => ({
  id,
  width: 3840,
  height: 2160,
  duration: seconds,
  url: `https://www.pexels.com/video/test-${id}/`,
  image: `${origin}/media/video-${id}.jpg`,
  user: { name: 'Bo Example', url: 'https://www.pexels.com/@bo' },
  video_files: [
    {
      id: 1,
      quality: 'hd',
      file_type: 'video/mp4',
      width: 1280,
      height: 720,
      link: `${origin}/media/video-${id}-720.mp4`,
    },
    {
      id: 2,
      quality: 'hd',
      file_type: 'video/mp4',
      width: 1920,
      height: 1080,
      link: `${origin}/media/video-${id}-1080.mp4`,
    },
    {
      id: 3,
      quality: 'uhd',
      file_type: 'video/mp4',
      width: 3840,
      height: 2160,
      link: `${origin}/media/video-${id}-2160.mp4`,
    },
    {
      id: 4,
      quality: null,
      file_type: 'application/x-mpegURL',
      width: null,
      height: null,
      link: `${origin}/media/video-${id}.m3u8`,
    },
  ],
});

function answer(req: IncomingMessage, res: ServerResponse) {
  const u = new URL(req.url ?? '/', stub.origin);
  stub.calls.push({ path: `${u.pathname}${u.search}`, auth: req.headers.authorization });
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (u.pathname.startsWith('/media/')) {
    const body = Buffer.alloc(64 * 1024, 7);
    const type = u.pathname.endsWith('.mp4') ? 'video/mp4' : 'image/jpeg';
    res.writeHead(200, { 'content-type': type, 'content-length': String(body.length) });
    const send = () => {
      if (stub.cut !== null) {
        const cut = stub.cut;
        stub.cut = null;
        res.flushHeaders();
        res.write(body.subarray(0, cut), () => setTimeout(() => res.destroy(), 20));
      } else res.end(body);
    };
    if (stub.hold) {
      const release = send;
      stub.hold = () => release();
    } else send();
    return;
  }
  if (req.headers.authorization !== 'good-key') return json(401, { error: 'Unauthorized' });
  if (stub.status === 429)
    return json(429, { error: 'Rate limit exceeded' }, { 'x-ratelimit-reset': '1790000000' });
  if (stub.status !== 200) return json(stub.status, { error: 'nope' });
  const page = Number(u.searchParams.get('page') ?? 1);
  const per = Number(u.searchParams.get('per_page') ?? 15);
  if (u.pathname === '/v1/search' || u.pathname === '/v1/curated') {
    const photos = Array.from({ length: per }, (_, i) => photo(1000 + (page - 1) * per + i, stub.origin));
    return json(200, { page, per_page: per, photos, ...(page < 3 ? { next_page: 'more' } : {}) });
  }
  if (u.pathname === '/videos/search') {
    const min = Number(u.searchParams.get('min_duration') ?? 0);
    // one too-short video among them, which the plugin drops when a minimum was asked
    const videos = Array.from({ length: per }, (_, i) =>
      video(2000 + (page - 1) * per + i, stub.origin, i === 0 && min ? Math.max(1, min - 1) : 12),
    );
    return json(200, { page, per_page: per, videos });
  }
  const p = /^\/v1\/photos\/(\d+)$/.exec(u.pathname);
  if (p)
    return Number(p[1]) === 404
      ? json(404, { error: 'Not found' })
      : json(200, photo(Number(p[1]), stub.origin));
  const v = /^\/videos\/videos\/(\d+)$/.exec(u.pathname);
  if (v) return json(200, video(Number(v[1]), stub.origin));
  json(404, { error: 'no route' });
}

beforeAll(async () => {
  server = createServer(answer);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  stub.origin = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(tmp, { recursive: true, force: true });
});

const clients: Client[] = [];
afterAll(async () => Promise.all(clients.map((c) => c.close())));

async function connect(key: string | null = 'good-key', dir = join(tmp, `d${clients.length}`)) {
  const env = key ? { NODCUT_SECRET_PEXELS_API_KEY: key } : {};
  const plugin = definePlugin({ ...makeDefinition({ origin: stub.origin, dir }), manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return { client, dir };
}
const call = async (c: Client, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
  const r = (await c.callTool(
    { name, arguments: args },
    undefined,
    signal ? { signal } : {},
  )) as CallToolResult;
  const text = r.content.map((x) => ('text' in x ? x.text : '')).join(' ');
  return {
    error: r.isError
      ? ((r.structuredContent as { error?: { code: string; message: string; fix: string } } | undefined)
          ?.error ?? {
          code: 'E_SCHEMA',
          message: text,
          fix: '',
        })
      : null,
    data: r.structuredContent as Record<string, unknown>,
  };
};

describe('find_footage', () => {
  test('photos and videos interleaved, one bounded page, with source pages, creators and the licence', async () => {
    stub.calls.length = 0;
    const { client } = await connect();
    const r = await call(client, 'find_footage', {
      query: 'ocean waves',
      limit: 6,
      orientation: 'landscape',
    });
    expect(r.error).toBeNull();
    const items = r.data.items as Record<string, unknown>[];
    expect(items).toHaveLength(6);
    expect(items.map((i) => i.kind)).toEqual(['video', 'image', 'video', 'image', 'video', 'image']);
    expect(items[0]).toMatchObject({
      id: '2000',
      kind: 'video',
      width: 3840,
      height: 2160,
      durationMs: 12_000,
      thumbnail: `${stub.origin}/media/video-2000.jpg`,
      provider: 'Pexels',
      sourceUrl: 'https://www.pexels.com/video/test-2000/',
      creator: 'Bo Example',
      creatorUrl: 'https://www.pexels.com/@bo',
      license: 'Pexels License',
      licenseUrl: 'https://www.pexels.com/license/',
      attribution: 'Video by Bo Example on Pexels',
    });
    expect(items[1]).toMatchObject({
      id: '1000',
      kind: 'image',
      attribution: 'Photo by Ana Example on Pexels',
      thumbnail: `${stub.origin}/media/photo-1000-m.jpeg`,
    });
    expect(items[1]).not.toHaveProperty('durationMs');
    expect(r.data.nextPage).toBe(2);
    // two API requests, three each, with the key; no media downloaded
    expect(stub.calls.map((c) => c.path.split('?')[0]).sort()).toEqual(['/v1/search', '/videos/search']);
    expect(
      stub.calls.every(
        (c) => c.auth === 'good-key' && /per_page=3/.test(c.path) && /orientation=landscape/.test(c.path),
      ),
    ).toBe(true);
    expect(stub.calls.some((c) => c.path.startsWith('/media/'))).toBe(false);
  });

  test('one kind, a page, a minimum length; at most 30', async () => {
    stub.calls.length = 0;
    const { client } = await connect();
    const r = await call(client, 'find_footage', {
      query: 'city',
      kind: 'video',
      minDurationMs: 8000,
      page: 2,
      limit: 5,
    });
    expect(r.error).toBeNull();
    const items = r.data.items as { id: string; durationMs: number }[];
    // the stub's too-short first video is dropped
    expect(items.map((i) => i.id)).toEqual(['2006', '2007', '2008', '2009']);
    expect(items.every((i) => i.durationMs >= 8000)).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.path).toMatch(/^\/videos\/search\?/);
    expect(stub.calls[0]!.path).toMatch(/min_duration=8/);
    expect(stub.calls[0]!.path).toMatch(/page=2/);
    const tooMany = await call(client, 'find_footage', { query: 'x', limit: 31 });
    // refused before the plugin runs: the contract caps a page at 30
    expect(tooMany.error).not.toBeNull();
  });

  test('a missing key, a wrong key and a used-up limit each say what to do', async () => {
    const none = await connect(null);
    expect((await call(none.client, 'find_footage', { query: 'x' })).error).toMatchObject({
      code: 'E_PLUGIN_NEEDS_SECRET',
    });
    const wrong = await connect('bad-key');
    expect((await call(wrong.client, 'find_footage', { query: 'x' })).error).toMatchObject({
      code: 'E_PEXELS_BAD_KEY',
      fix: expect.stringContaining('Keys'),
    });
    const { client } = await connect();
    stub.status = 429;
    try {
      expect((await call(client, 'find_footage', { query: 'x' })).error).toMatchObject({
        code: 'E_PEXELS_RATE_LIMITED',
        message: expect.stringContaining('2026-09'),
        fix: expect.stringContaining('wait'),
      });
      stub.status = 500;
      expect((await call(client, 'find_footage', { query: 'x' })).error).toMatchObject({
        code: 'E_PEXELS_FAILED',
      });
    } finally {
      stub.status = 200;
    }
  });

  test('test_key: works with a good key, says so with a bad one, downloads nothing', async () => {
    stub.calls.length = 0;
    const { client } = await connect();
    const ok = (await client.callTool({ name: 'test_key', arguments: {} })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    expect(stub.calls).toEqual([expect.objectContaining({ path: '/v1/curated?per_page=1' })]);
    const bad = await connect('bad-key');
    const no = (await bad.client.callTool({ name: 'test_key', arguments: {} })) as CallToolResult;
    expect(no.isError).toBe(true);
  });
});

describe('get_footage', () => {
  test('a video: the smallest MP4 that covers the output, downloaded once and reused', async () => {
    stub.calls.length = 0;
    const { client, dir } = await connect();
    const r = await call(client, 'get_footage', {
      id: '2001',
      kind: 'video',
      maxWidth: 1920,
      maxHeight: 1080,
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({
      kind: 'video',
      width: 1920,
      height: 1080,
      durationMs: 12_000,
      provider: 'Pexels',
      sourceUrl: 'https://www.pexels.com/video/test-2001/',
      creator: 'Bo Example',
      license: 'Pexels License',
      attribution: 'Video by Bo Example on Pexels',
    });
    expect(existsSync(r.data.file as string)).toBe(true);
    expect(stub.calls.map((c) => c.path)).toEqual(['/videos/videos/2001', '/media/video-2001-1080.mp4']);
    // the media request carries no key
    expect(stub.calls[1]!.auth).toBeUndefined();
    stub.calls.length = 0;
    const again = await call(client, 'get_footage', {
      id: '2001',
      kind: 'video',
      maxWidth: 1920,
      maxHeight: 1080,
    });
    expect(again.data.file).toBe(r.data.file);
    expect(stub.calls.map((c) => c.path)).toEqual(['/videos/videos/2001']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  test('a photo: fitted inside the output by Pexels, never larger than the original', async () => {
    const { client } = await connect();
    const r = await call(client, 'get_footage', {
      id: '1001',
      kind: 'image',
      maxWidth: 1080,
      maxHeight: 1920,
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({
      kind: 'image',
      width: 1080,
      height: 810,
      attribution: 'Photo by Ana Example on Pexels',
    });
    expect(r.data).not.toHaveProperty('durationMs');
  });

  test('a stale id, a partial download and a cancel leave nothing behind', async () => {
    const { client, dir } = await connect();
    expect((await call(client, 'get_footage', { id: '404', kind: 'image' })).error).toMatchObject({
      code: 'E_PEXELS_NOT_FOUND',
    });
    stub.cut = 1000;
    const partial = await call(client, 'get_footage', {
      id: '2002',
      kind: 'video',
      maxWidth: 1280,
      maxHeight: 720,
    });
    expect(partial.error?.code).toBe('E_PEXELS_FAILED');
    expect(readdirSync(dir).filter((f) => f.endsWith('.mp4') || f.endsWith('.part'))).toEqual([]);
    stub.hold = () => {};
    const ctl = new AbortController();
    const pending = call(
      client,
      'get_footage',
      { id: '2003', kind: 'video', maxWidth: 1280, maxHeight: 720 },
      ctl.signal,
    ).catch((e: Error) => ({ error: { code: 'aborted', message: e.message, fix: '' }, data: {} }));
    await new Promise((r) => setTimeout(r, 100));
    ctl.abort();
    expect((await pending).error).not.toBeNull();
    stub.hold?.();
    stub.hold = null;
    await new Promise((r) => setTimeout(r, 100));
    expect(readdirSync(dir).filter((f) => f.endsWith('.part'))).toEqual([]);
  });

  test('renditions are bounded: a stream playlist is never chosen; the largest when none covers', () => {
    const v = video(1, 'https://videos.pexels.com') as Video;
    expect(videoRendition(v, 1080, 1920)).toMatchObject({ width: 1920, height: 1080, ext: 'mp4' });
    expect(videoRendition(v, 7680, 4320)).toMatchObject({ width: 3840, height: 2160 });
    expect(videoRendition(v)).toMatchObject({ width: 1280, height: 720 });
    expect(() => videoRendition({ ...v, video_files: v.video_files.slice(3) }, 1920, 1080)).toThrow(/no MP4/);
    const p = photo(1, 'https://images.pexels.com') as Photo;
    expect(photoRendition(p)).toMatchObject({
      width: 4000,
      height: 3000,
      url: 'https://images.pexels.com/media/photo-1.jpeg',
    });
    expect(photoRendition(p, 8000, 8000)).toMatchObject({ width: 4000 });
    expect(photoRendition(p, 640, 360).url).toMatch(/w=480&h=360$/);
  });

  test('a file Pexels points at on another host is refused before downloading', async () => {
    const { download } = await import('./pexels.js');
    await expect(
      download(
        { fetch: globalThis.fetch, dir: join(tmp, 'host') },
        { url: 'https://evil.example.com/x.mp4', width: 1, height: 1, ext: 'mp4' },
      ),
    ).rejects.toMatchObject({ code: 'E_PEXELS_UNEXPECTED_HOST' });
  });
});

describe('as NodCut starts it', () => {
  const built = existsSync(join(DIR, 'dist/index.js'));
  test.skipIf(!built)('without a key: it starts and offers its tools; the calls are skipped', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.find((c) => c.name === 'find_footage answers per contract')?.result).toBe('skip');
  });
  /**
   * The harness gives a plugin only its settings and secrets, so to point it at the stub this
   * starts the built plugin from a copy of the folder whose entry sets the origin first.
   */
  test.skipIf(!built)(
    'with a key, against the stub: a search, then the first candidate downloaded',
    async () => {
      const dir = mkdtempSync(join(tmp, 'harness-'));
      writeFileSync(join(dir, 'nodcut-plugin.json'), JSON.stringify({ ...manifest, args: ['start.mjs'] }));
      writeFileSync(
        join(dir, 'start.mjs'),
        `process.env.${ORIGIN_ENV} = ${JSON.stringify(stub.origin)};\nawait import(${JSON.stringify(pathToFileURL(join(DIR, 'dist/index.js')).href)});\n`,
      );
      const report = await testPlugin(dir, { secrets: { PEXELS_API_KEY: 'good-key' } });
      expect(report.ok, formatReport(report)).toBe(true);
      expect(report.checks.find((c) => c.name === 'get_footage answers per contract')?.result).toBe('pass');
    },
    30_000,
  );
});
