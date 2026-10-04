import { describe, expect, test } from 'vitest';
import {
  addedPermissions,
  isNewer,
  latestCompatible,
  noPermissions,
  RegistryIndexSchema,
  resolveHref,
  sortedVersions,
  type RegistryPlugin,
} from './registry.js';

const version = (v: string, over: Record<string, unknown> = {}) => ({
  version: v,
  cutpilot: '>=0.1 <1',
  contract: 1,
  kinds: ['transcriber'],
  permissions: { network: ['api.elevenlabs.io'], secrets: ['ELEVENLABS_API_KEY'], reads: ['audio'] },
  url: `packages/cloud-transcribe/${v}/cloud-transcribe-${v}.cutpilot-plugin`,
  sha256: 'a'.repeat(64),
  bytes: 12_345,
  published: '2026-09-27T12:00:00Z',
  ...over,
});
const plugin = (over: Record<string, unknown> = {}) => ({
  id: 'cloud-transcribe',
  name: 'Cloud transcription',
  publisher: { name: 'CutPilot', verified: true },
  description: 'Transcribe with ElevenLabs Scribe or OpenAI, using your own API key.',
  categories: ['transcription'],
  license: 'MIT',
  readme: '# Cloud transcription\n\nFast.',
  versions: [version('1.0.0'), version('1.1.0'), version('2.0.0', { cutpilot: '>=0.5' })],
  ...over,
});
const index = (plugins: unknown[]) => ({ schema: 1, generated: '2026-09-27T12:00:00Z', plugins });

describe('registry index', () => {
  test('a well-formed index parses, with defaults filled in', () => {
    const r = RegistryIndexSchema.safeParse(index([plugin({ categories: undefined, readme: undefined })]));
    expect(r.success).toBe(true);
    expect(r.data!.plugins[0]).toMatchObject({ categories: [], readme: '', publisher: { verified: true } });
  });

  test.each([
    [{ schema: 2, generated: 'x'.repeat(10), plugins: [] }, 'schema'],
    [index([plugin(), plugin()]), 'plugin cloud-transcribe is listed twice'],
    [index([plugin({ versions: [version('1.0.0'), version('1.0.0')] })]), 'version 1.0.0 is listed twice'],
    [
      index([plugin({ versions: [version('1.0.0', { url: 'http://x.io/p.zip' })] })]),
      'an https URL or a path relative to the index',
    ],
    [
      index([plugin({ versions: [version('1.0.0', { url: '../../etc/passwd' })] })]),
      'an https URL or a path relative to the index',
    ],
    [index([plugin({ versions: [version('1.0.0', { sha256: 'ABC' })] })]), 'a lowercase hex SHA-256'],
    [index([plugin({ versions: [version('1.0.0', { bytes: 500 * 1024 * 1024 })] })]), 'versions.0.bytes'],
    [index([plugin({ homepage: 'javascript:alert(1)' })]), 'an https URL'],
    [index([plugin({ versions: [] })]), 'versions'],
  ])('refuses %#', (x, want) => {
    const r = RegistryIndexSchema.safeParse(x);
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')).toContain(want);
  });

  test('the newest version this engine can run', () => {
    const p = RegistryIndexSchema.parse(index([plugin()])).plugins[0] as RegistryPlugin;
    expect(sortedVersions(p).map((v) => v.version)).toEqual(['2.0.0', '1.1.0', '1.0.0']);
    expect(latestCompatible(p, '0.3.0')?.version).toBe('1.1.0');
    expect(latestCompatible(p, '0.5.0')?.version).toBe('2.0.0');
    expect(latestCompatible(p, '0.0.9')).toBeNull();
    const other = RegistryIndexSchema.parse(
      index([plugin({ versions: [version('3.0.0', { contract: 2 })] })]),
    ).plugins[0]!;
    expect(latestCompatible(other, '0.3.0')).toBeNull();
  });

  test("a kind this CutPilot doesn't know: the catalog still reads, that version is passed over (P3-067)", () => {
    const r = RegistryIndexSchema.safeParse(
      index([
        plugin(),
        plugin({
          id: 'teleport',
          versions: [version('1.0.0'), version('2.0.0', { kinds: ['analyzer:teleport'], permissions: {} })],
        }),
      ]),
    );
    expect(r.success).toBe(true);
    const p = r.data!.plugins[1] as RegistryPlugin;
    expect(latestCompatible(p, '0.3.0')?.version).toBe('1.0.0');
  });

  test('newer, URLs, and what an update asks for in addition', () => {
    expect(isNewer('1.1.0', '1.0.0')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true);
    expect(
      resolveHref('https://cutpilot.app/plugins/v1/index.json', 'packages/a/1.0.0/a.cutpilot-plugin'),
    ).toBe('https://cutpilot.app/plugins/v1/packages/a/1.0.0/a.cutpilot-plugin');
    expect(
      resolveHref('https://cutpilot.app/plugins/v1/index.json', 'https://github.com/x/y.cutpilot-plugin'),
    ).toBe('https://github.com/x/y.cutpilot-plugin');
    const before = { network: ['a.io'], secrets: [], reads: ['audio' as const] };
    const after = { network: ['a.io', 'b.io'], secrets: ['KEY'], reads: ['audio' as const] };
    expect(addedPermissions(before, after)).toEqual({ network: ['b.io'], secrets: ['KEY'], reads: [] });
    expect(noPermissions(addedPermissions(after, before))).toBe(true);
  });
});
