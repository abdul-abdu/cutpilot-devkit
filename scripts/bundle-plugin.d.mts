/** Types for scripts/bundle-plugin.mjs (imported by its test). */
export function bundlePlugin(
  dir: string,
  out?: string,
  options?: { log?: (line: string) => void },
  /** `entry` is null for a data-only plugin (a language pack): copied, not bundled */
): Promise<{ dir: string; entry: string | null; bytes: number; installed: string[] }>;
