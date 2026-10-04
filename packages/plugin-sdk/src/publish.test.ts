/** What the npm packages must look like before the owner publishes them (docs/publishing-the-sdk.md). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACT_VERSION } from '@nodcut/plugin-api';
import { describe, expect, test } from 'vitest';

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));
const pkg = (name: string) => JSON.parse(readFileSync(join(PACKAGES, name, 'package.json'), 'utf8'));
const api = pkg('plugin-api');
const sdk = pkg('plugin-sdk');

describe('the npm packages', () => {
  test('are released together, the SDK depending on the same plugin-api', () => {
    expect(sdk.version).toBe(api.version);
    expect(sdk.dependencies['@nodcut/plugin-api']).toBe('workspace:*'); // pnpm publish writes the version
  });

  test('the major version is the plugin contract version (from 1.0.0 on)', () => {
    const major = Number(sdk.version.split('.')[0]);
    if (major >= 1) expect(major).toBe(CONTRACT_VERSION);
  });

  test('publish publicly, with a README, the MIT license and what they need to run', () => {
    for (const [dir, p] of [
      ['plugin-api', api],
      ['plugin-sdk', sdk],
    ] as const) {
      expect(p.publishConfig).toEqual({ access: 'public' });
      expect(p.license).toBe('MIT');
      expect(existsSync(join(PACKAGES, dir, 'README.md'))).toBe(true);
      expect(existsSync(join(PACKAGES, dir, 'LICENSE'))).toBe(true);
      expect(p.files).toContain('dist');
    }
    expect(sdk.files).toContain('template');
    expect(sdk.bin).toEqual({ 'nodcut-plugin': './dist/bin.js' });
    expect(existsSync(join(PACKAGES, 'plugin-sdk/src/bin.ts'))).toBe(true);
  });
});
