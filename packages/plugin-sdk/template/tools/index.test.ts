// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way NodCut does.
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { expect, test } from 'vitest';
import { suggestTitles } from './plugin.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin()', async () => {
  const report = await testPlugin(root);
  expect(report.ok, formatReport(report)).toBe(true);
}, 30_000);

test('suggest_titles builds titles around the words said most', () => {
  const titles = suggestTitles(
    'Coffee at home: better coffee, cheaper coffee. Grinders matter; grinders!',
    3,
  );
  expect(titles).toEqual([
    'Coffee: what you need to know',
    'Coffee: why it matters',
    'Coffee and grinders, explained',
  ]);
  expect(suggestTitles('a an it')).toEqual(['Untitled video']);
  expect(suggestTitles('Bread, bread.', 5)).toEqual([
    'Bread: what you need to know',
    'Bread: why it matters',
    'The truth about bread',
  ]);
});
