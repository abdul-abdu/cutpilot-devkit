// A footage provider: NodCut asks find_footage for candidates that match a query (thumbnails,
// pages and rights, nothing downloaded), then get_footage for the one the user picked, and
// copies that file into the project as B-roll. Return only media you may hand out, with its
// licence and the credit line it asks for; the user brings their own key for a paid service.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { PluginFailure, type PluginDefinition } from '@nodcut/plugin-sdk';

interface Item {
  id: string;
  kind: 'image' | 'video';
  title: string;
  width: number;
  height: number;
  durationMs?: number;
  /** a flat colour stands in for the picture; a real provider downloads the file */
  rgb: [number, number, number];
}

/** A placeholder catalogue, offline. Replace it with your provider's search and download. */
export const CATALOG: Item[] = [
  { id: 'blue-sky', kind: 'image', title: 'Blue sky', width: 640, height: 360, rgb: [70, 130, 220] },
  { id: 'green-field', kind: 'image', title: 'Green field', width: 640, height: 360, rgb: [60, 160, 80] },
];

const PAGE = 'https://example.com/footage/';
const rights = {
  provider: 'Example footage',
  license: 'CC0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
} as const;

/** A PNG of one flat colour (no image library needed). */
export function flatPng(file: string, w: number, h: number, [r, g, b]: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(file, png);
  return file;
}

export const plugin: PluginDefinition = {
  findFootage: ({ query, kind, limit, page }) => {
    const words = query.toLowerCase().split(/\s+/);
    // a real provider searches; the placeholder lists everything for "test" and matches titles otherwise
    const hits = CATALOG.filter(
      (x) =>
        (!kind || x.kind === kind) &&
        (query === 'test' || words.some((w) => x.title.toLowerCase().includes(w))),
    );
    const size = limit ?? 10;
    const from = ((page ?? 1) - 1) * size;
    const items = hits.slice(from, from + size).map(({ rgb: _rgb, title: _title, ...x }) => ({
      ...x,
      thumbnail: `${PAGE}${x.id}/thumbnail.png`,
      sourceUrl: `${PAGE}${x.id}`,
      ...rights,
    }));
    return { items, ...(from + size < hits.length ? { nextPage: (page ?? 1) + 1 } : {}) };
  },
  getFootage: ({ id, kind }) => {
    const x = CATALOG.find((i) => i.id === id && i.kind === kind);
    if (!x)
      throw new PluginFailure(
        'E_PLUGIN_BAD_INPUT',
        `no ${kind} ${id}`,
        'pick an id and kind that find_footage returned',
      );
    // NodCut copies the file into the project, so a temporary file is fine
    const file = flatPng(join(tmpdir(), `footage-${x.id}.png`), x.width, x.height, x.rgb);
    return { file, kind: x.kind, width: x.width, height: x.height, sourceUrl: `${PAGE}${x.id}`, ...rights };
  },
};
