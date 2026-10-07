// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way NodCut does.
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin(): find_footage, then get_footage of the first candidate', async () => {
  const report = await testPlugin(root);
  expect(report.ok, formatReport(report)).toBe(true);
  expect(report.checks.map((c) => c.name)).toContain('get_footage answers per contract');
}, 30_000);
