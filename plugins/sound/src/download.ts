/**
 * Fetch a pinned file to disk (streamed, SHA-256 and size checked, `.part` until it is whole)
 * and unpack an archive with the OS's tar (bsdtar on macOS and Windows 10+, GNU tar on Linux;
 * all three read .tar.gz and .zip).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PluginFailure } from '@nodcut/plugin-sdk';
import type { Download } from './catalog.js';

export interface DownloadOptions {
  signal?: AbortSignal;
  /** bytes so far, of `size` (a resumed download starts above zero) */
  onProgress?: (bytes: number) => void;
  fetch?: typeof fetch;
}

const sizeOf = async (p: string) => (await stat(p).catch(() => null))?.size ?? 0;

const fail = (what: string, detail: string) =>
  new PluginFailure(
    'E_SOUND_DOWNLOAD',
    `couldn't download ${what}: ${detail}`,
    'check the connection and try sound__setup again; the file is fetched from its publisher and checked by SHA-256',
  );

/**
 * Download `d` to `to`. An interrupted download (Stop, a lost connection) leaves `to.part`
 * and the next call continues from it with a Range request; a wrong hash or size leaves
 * nothing behind.
 */
export async function download(
  what: string,
  d: Download,
  to: string,
  o: DownloadOptions = {},
): Promise<void> {
  const f = o.fetch ?? fetch;
  await mkdir(join(to, '..'), { recursive: true });
  const part = `${to}.part`;
  let have = await sizeOf(part);
  if (have >= d.size) have = 0; // a leftover that can't be right: start over
  const resumedHash = createHash('sha256');
  if (have) for await (const chunk of createReadStream(part)) resumedHash.update(chunk as Buffer);
  let res: Response;
  try {
    res = await f(d.url, {
      signal: o.signal ?? null,
      redirect: 'follow',
      ...(have ? { headers: { range: `bytes=${have}-` } } : {}),
    });
  } catch (e) {
    throw fail(what, (e as Error).message);
  }
  if (!res.ok || !res.body) throw fail(what, `HTTP ${res.status}`);
  // a server that ignores the range (200) sends the whole file: the part is replaced
  const resumed = have > 0 && res.status === 206;
  const hash = resumed ? resumedHash : createHash('sha256');
  let bytes = resumed ? have : 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > d.size) return cb(new Error(`more than the ${d.size} bytes published`));
      hash.update(chunk);
      o.onProgress?.(bytes);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as never, { signal: o.signal }),
      count,
      createWriteStream(part, resumed ? { flags: 'a' } : {}),
    );
    if (bytes !== d.size) throw new Error(`${bytes} bytes, the publisher lists ${d.size}`);
    const got = hash.digest('hex');
    if (got !== d.sha256) throw new Error(`SHA-256 ${got.slice(0, 12)}…, expected ${d.sha256.slice(0, 12)}…`);
    await rename(part, to);
  } catch (e) {
    // an interruption keeps the part for next time; a wrong file is deleted
    if ((e as Error).name === 'AbortError') throw e;
    if (/SHA-256|publisher lists|more than/.test((e as Error).message)) await rm(part, { force: true });
    throw fail(what, (e as Error).message);
  }
}

/** Unpack `archive` into `dir` and return the path of `exe` inside it (made executable). */
export async function unpack(archive: string, dir: string, exe: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) =>
    execFile('tar', ['-xf', archive, '-C', dir], { windowsHide: true }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim().split('\n')[0] || err.message)) : resolve(),
    ),
  );
  const found = await find(dir, exe, 2);
  if (!found) throw new Error(`${exe} is not in the archive`);
  if (process.platform !== 'win32') await chmod(found, 0o755);
  return found;
}

async function find(dir: string, name: string, depth: number): Promise<string | null> {
  const direct = join(dir, name);
  if (
    await stat(direct).then(
      (s) => s.isFile(),
      () => false,
    )
  )
    return direct;
  if (depth === 0) return null;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => []))
    if (e.isDirectory()) {
      const hit = await find(join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  return null;
}
