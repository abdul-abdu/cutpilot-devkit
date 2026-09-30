import { describe, expect, test } from 'vitest';
import { ICON_MAX_BYTES, iconProblem, pngSize } from './icon.js';

/** The first 24 bytes of a PNG (signature + IHDR width and height), followed by whatever. */
export function pngHeader(width: number, height: number, total = 64): Uint8Array {
  const b = new Uint8Array(Math.max(24, total));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('icon', () => {
  test('pngSize reads the header; anything else is null', () => {
    expect(pngSize(pngHeader(128, 64))).toEqual({ width: 128, height: 64 });
    expect(pngSize(pngHeader(70000, 70000))).toEqual({ width: 70000, height: 70000 });
    expect(pngSize(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(pngSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    const notIhdr = pngHeader(64, 64);
    notIhdr.set([0x49, 0x44, 0x41, 0x54], 12); // IDAT first: not a well-formed PNG
    expect(pngSize(notIhdr)).toBeNull();
    expect(pngSize(pngHeader(0, 64))).toBeNull();
  });

  test.each([
    [pngHeader(128, 128), null],
    [pngHeader(32, 32), null],
    [pngHeader(256, 256), null],
    [new TextEncoder().encode('GIF89a'), 'the icon is not a PNG'],
    [pngHeader(128, 64), 'the icon is 128×64; icons are square'],
    [pngHeader(16, 16), 'the icon is 16 px; icons are 32 to 256 px'],
    [pngHeader(512, 512), 'the icon is 512 px; icons are 32 to 256 px'],
    [pngHeader(128, 128, ICON_MAX_BYTES + 1), 'the icon is 64 KB; icons are at most 64 KB'],
  ])('iconProblem case %#', (bytes, want) => {
    expect(iconProblem(bytes)).toBe(want);
  });
});
