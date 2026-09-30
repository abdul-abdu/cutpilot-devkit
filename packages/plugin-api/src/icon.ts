/**
 * A plugin's icon (P3-057): a PNG named by the manifest's `icon`, inside the plugin folder, square
 * and small. The store shows it in the list and on the plugin's page, the app next to an
 * installed plugin. Everyone who handles one (the SDK harness, the registry build, the app's
 * store client) checks it with `iconProblem` before trusting it, so a package can't smuggle
 * something else in under that name. Pure functions over bytes: no Node, no zod.
 */

export const ICON_MAX_BYTES = 64 * 1024;
export const ICON_MIN_PX = 32;
export const ICON_MAX_PX = 256;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Width and height of a PNG from its header, or null when the bytes aren't a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null;
  // the first chunk is always IHDR: length(4) "IHDR"(4) width(4) height(4), big-endian
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const u32 = (o: number) =>
    bytes[o]! * 0x1000000 + ((bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!);
  const width = u32(16);
  const height = u32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** Why these bytes can't be a plugin icon, or null when they can. */
export function iconProblem(bytes: Uint8Array): string | null {
  if (bytes.length > ICON_MAX_BYTES)
    return `the icon is ${Math.round(bytes.length / 1024)} KB; icons are at most ${ICON_MAX_BYTES / 1024} KB`;
  const size = pngSize(bytes);
  if (!size) return 'the icon is not a PNG';
  if (size.width !== size.height) return `the icon is ${size.width}×${size.height}; icons are square`;
  if (size.width < ICON_MIN_PX || size.width > ICON_MAX_PX)
    return `the icon is ${size.width} px; icons are ${ICON_MIN_PX} to ${ICON_MAX_PX} px`;
  return null;
}
