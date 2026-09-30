/** Types for scripts/bundle-plugin.mjs (imported by its test). */
export function bundlePlugin(
  dir: string,
  out?: string,
  options?: { log?: (line: string) => void },
): Promise<{ dir: string; entry: string; bytes: number; installed: string[] }>;
