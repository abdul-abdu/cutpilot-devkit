// `npm test` builds the plugin first: testPlugin() starts dist/index.js the way CutPilot does.
import { fileURLToPath } from 'node:url';
import { formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { expect, test } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

test('the plugin passes testPlugin(): voices listed, an effect and speech made', async () => {
  // without `sound`, testPlugin() only lists the voices: making sound often needs a model
  for (const sound of [
    { kind: 'sfx', prompt: 'a short beep', durationMs: 500 },
    { kind: 'speech', text: 'Hello there' },
  ]) {
    const report = await testPlugin(root, { sound });
    expect(report.ok, formatReport(report)).toBe(true);
    expect(report.checks.map((c) => c.name)).toContain('generate_sound makes the file');
  }
}, 30_000);
