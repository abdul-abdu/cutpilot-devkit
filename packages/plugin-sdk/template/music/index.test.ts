// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way CutPilot does.
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin(): find_music, then get_music of the first track', async () => {
  const report = await testPlugin(root);
  expect(report.ok, formatReport(report)).toBe(true);
  expect(report.checks.map((c) => c.name)).toContain('get_music answers per contract');
}, 30_000);
