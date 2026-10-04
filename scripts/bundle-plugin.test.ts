/** A bundled plugin stands alone: no links, and it passes the SDK harness (needs `pnpm build`). */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testPlugin } from '../packages/plugin-sdk/src/index.js';
import { afterAll, describe, expect, test } from 'vitest';
import { bundlePlugin } from './bundle-plugin.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HYPERFRAMES = join(ROOT, 'plugins/hyperframes');
const tmp = mkdtempSync(join(tmpdir(), 'cp-bundle-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

test('a language pack is copied, not bundled: the files its manifest names (P3-067)', async () => {
  const src = join(ROOT, 'packages/plugin-sdk/fixtures/language');
  const r = await bundlePlugin(src, join(tmp, 'lang'));
  expect(r).toMatchObject({ entry: null, installed: [] });
  expect(readdirSync(r.dir).sort()).toEqual(['cutpilot-plugin.json', 'de.json', 'de.menu.json']);
  expect((await testPlugin(r.dir)).ok).toBe(true);
});

describe.skipIf(!existsSync(join(HYPERFRAMES, 'dist/index.js')))('bundle-plugin', () => {
  test('refuses a plugin that is not started with node', async () => {
    const dir = join(tmp, 'py');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'cutpilot-plugin.json'),
      JSON.stringify({ id: 'py', command: 'python3', args: ['main.py'] }),
    );
    writeFileSync(join(dir, 'package.json'), '{}');
    await expect(bundlePlugin(dir, join(tmp, 'x'))).rejects.toThrow(/started with "node <file>"/);
  });

  // npm installs hyperframes and gsap from the registry: about a minute. Opt in with HYPERFRAMES_E2E=1.
  test.skipIf(!process.env.HYPERFRAMES_E2E)(
    'hyperframes: the SDK is bundled, hyperframes and gsap are installed, the harness passes',
    async () => {
      const lines: string[] = [];
      const r = await bundlePlugin(HYPERFRAMES, join(tmp, 'hyperframes'), { log: (l) => lines.push(l) });
      expect(r.installed).toEqual(['gsap', 'hyperframes']);
      const js = readFileSync(join(r.dir, 'dist/index.js'), 'utf8');
      expect(js).toMatch(/PluginFailure = class/); // the SDK is inside
      expect(js).not.toMatch(/from ["']@cutpilot\//);
      expect(existsSync(join(r.dir, 'node_modules/hyperframes/bin/hyperframes.mjs'))).toBe(true);
      expect(existsSync(join(r.dir, 'node_modules/gsap/dist/gsap.min.js'))).toBe(true);
      expect(existsSync(join(r.dir, 'icon.png'))).toBe(true);
      expect(JSON.parse(readFileSync(join(r.dir, 'package.json'), 'utf8')).dependencies).toEqual({
        gsap: expect.any(String),
        hyperframes: expect.any(String),
      });
      const report = await testPlugin(r.dir);
      expect(report.checks.filter((c) => c.result === 'fail')).toEqual([]);
    },
    300_000,
  );
});
