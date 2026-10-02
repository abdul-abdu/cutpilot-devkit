/**
 * The Python example passes testPlugin() like any other plugin. Skipped when uv isn't on PATH;
 * `uv sync` runs first with this environment (proxy settings included), since testPlugin()
 * starts the plugin with only PATH, HOME, LANG and TMPDIR, as CutPilot does.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findOnPath, formatReport, testPlugin } from '../packages/plugin-sdk/src/index.js';
import { beforeAll, describe, expect, test } from 'vitest';

const DIR = fileURLToPath(new URL('./python-plugin/', import.meta.url));
const uv = findOnPath('uv');

describe.skipIf(!uv)('examples/python-plugin (needs uv)', () => {
  beforeAll(() => {
    const r = spawnSync(uv!, ['sync', '--frozen', '--quiet'], { cwd: DIR, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  }, 180_000);

  test('passes testPlugin(): starts with uv run and offers word_stats', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['starts and answers', 'pass'],
      ['extra tool word_stats', 'pass'],
    ]);
  }, 60_000);

  test("word_stats' own unit tests pass", () => {
    const r = spawnSync(uv!, ['run', '--frozen', '--quiet', 'python', '-m', 'unittest'], {
      cwd: DIR,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
  }, 60_000);
});
