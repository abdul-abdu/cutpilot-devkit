// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way CutPilot does.
import { fileURLToPath } from 'node:url';
import { findOnPath, formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin(): templates listed, each rendered at a small size', async () => {
  // the placeholder renders with ffmpeg; without it, only list_templates is checked
  const report = await testPlugin(root, { templates: findOnPath('ffmpeg') ? 'all' : 'none' });
  expect(report.ok, formatReport(report)).toBe(true);
}, 60_000);
