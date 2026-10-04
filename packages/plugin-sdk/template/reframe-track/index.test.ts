// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way NodCut does.
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@nodcut/plugin-sdk';
import { expect, test } from 'vitest';
import { centreKeyframes } from './plugin.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin()', async () => {
  // The placeholder never opens the video, so an empty stand-in will do. Once your plugin reads
  // frames, point TEST_VIDEO at a short clip.
  const video = process.env.TEST_VIDEO ?? join(tmpdir(), 'reframe-stand-in.mp4');
  if (!process.env.TEST_VIDEO) writeFileSync(video, '');
  const report = await testPlugin(root, { fixtures: { video } });
  expect(report.ok, formatReport(report)).toBe(true);
}, 30_000);

test('one centred keyframe per range start, in time order', () => {
  expect(
    centreKeyframes([
      { start: 5000, end: 8000 },
      { start: 0, end: 3000 },
    ]),
  ).toEqual([
    { t: 0, x: 0.5, y: 0.5 },
    { t: 5000, x: 0.5, y: 0.5 },
  ]);
});
