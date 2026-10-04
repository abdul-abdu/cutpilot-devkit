// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way NodCut does.
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { expect, test } from 'vitest';
import { spreadWords } from './plugin.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin()', async () => {
  // testPlugin() sends a second of silence; pass fixtures: { audio, language } for a real recording
  const report = await testPlugin(root);
  expect(report.ok, formatReport(report)).toBe(true);
}, 30_000);

test('words are spread over the audio in time order', () => {
  expect(spreadWords('one two', 1000)).toEqual([
    { text: 'one', start: 0, end: 400 },
    { text: 'two', start: 500, end: 900 },
  ]);
  expect(spreadWords('one two', 0)).toEqual([]);
});
