import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFailure } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { FREE_LICENSE, LICENSE_NOTICE, licenseKey, readAcceptances, recordAcceptance } from './license.js';
import { installedVersions, linkedDir, MIN_VERSION, openProject, versionProblem } from './project.js';
import { fakeProject } from './test-helpers/fake-project.js';

const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-project-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const v = (
  remotion: string | null,
  renderer: string | null = remotion,
  bundler: string | null = remotion,
) => ({
  remotion,
  '@remotion/renderer': renderer,
  '@remotion/bundler': bundler,
});
const failure = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PluginFailure);
    return e as PluginFailure;
  }
  throw new Error('no failure');
};

describe('versions', () => {
  test('one supported version of all three packages is fine', () => {
    expect(versionProblem(v('4.0.532'))).toBeNull();
    expect(versionProblem(v(MIN_VERSION))).toBeNull();
  });

  test('a mismatch names each version and the command that aligns them on the newest', () => {
    const p = versionProblem(v('4.0.532', '4.0.500', '4.0.532'))!;
    expect(p.code).toBe('E_REMOTION_VERSION_MISMATCH');
    expect(p.message).toContain('@remotion/renderer 4.0.500');
    expect(p.fix).toContain(
      'npm i --save-exact remotion@4.0.532 @remotion/renderer@4.0.532 @remotion/bundler@4.0.532',
    );
  });

  test("missing packages: npm i, at the project's Remotion version", () => {
    const p = versionProblem(v('4.0.532', null, null))!;
    expect(p.code).toBe('E_REMOTION_NOT_INSTALLED');
    expect(p.message).toBe("@remotion/renderer, @remotion/bundler aren't installed in the Remotion project");
    expect(p.fix).toContain('@remotion/renderer@4.0.532 @remotion/bundler@4.0.532');
  });

  test('too old (no licenseKey) or another major: refused, saying what to do', () => {
    expect(versionProblem(v('4.0.408'))!.code).toBe('E_REMOTION_UNSUPPORTED_VERSION');
    expect(versionProblem(v('3.3.100'))!.fix).toContain('npx remotion upgrade');
    const five = versionProblem(v('5.0.0'))!;
    expect(five.code).toBe('E_REMOTION_UNSUPPORTED_VERSION');
    expect(five.fix).toContain('use Remotion 4');
  });

  test('read from the project folder, not from this plugin', () => {
    const dir = fakeProject({ versions: { '@remotion/bundler': '4.0.500' } });
    expect(installedVersions(dir)).toEqual(v('4.0.532', '4.0.532', '4.0.500'));
    expect(failure(() => openProject(dir)).code).toBe('E_REMOTION_VERSION_MISMATCH');
    expect(openProject(fakeProject()).version).toBe('4.0.532');
    // this repo has no Remotion at all
    expect(installedVersions(tmp)).toEqual(v(null));
  });
});

describe('the linked folder', () => {
  test('unset, relative, missing, not a project', () => {
    expect(failure(() => linkedDir('')).code).toBe('E_REMOTION_NOT_LINKED');
    expect(failure(() => linkedDir(undefined)).fix).toContain('remotion__create_project');
    expect(failure(() => linkedDir('videos/x')).code).toBe('E_REMOTION_NOT_LINKED');
    expect(failure(() => linkedDir(join(tmp, 'nope'))).code).toBe('E_REMOTION_NO_PROJECT');
    expect(failure(() => openProject(tmp)).message).toContain('has no package.json');
  });
});

describe('bring your own licence', () => {
  const ctx = (key?: string) => ({ secret: (n: string) => (n === 'REMOTION_LICENSE_KEY' ? key : undefined) });

  test('no key: refused with the licence notice, and where the user enters theirs', () => {
    const e = failure(() => licenseKey(ctx()));
    expect(e.code).toBe('E_PLUGIN_NEEDS_SECRET');
    expect(e.message).toContain(LICENSE_NOTICE);
    expect(e.fix).toContain('CutPilot → Plugins → Remotion');
    expect(e.fix).toContain(`"${FREE_LICENSE}"`);
    expect(e.fix).toContain('remotion.pro');
    expect(failure(() => licenseKey(ctx('  '))).code).toBe('E_PLUGIN_NEEDS_SECRET');
    expect(failure(() => licenseKey(ctx('rm_ab cd'))).code).toBe('E_REMOTION_BAD_LICENSE_KEY');
  });

  test('free-license or a company key', () => {
    expect(licenseKey(ctx('free-license'))).toEqual({ key: 'free-license', kind: 'free' });
    expect(licenseKey(ctx(' rm_sec_abc '))).toEqual({ key: 'rm_sec_abc', kind: 'company' });
  });

  test('the notice text is the one the user agrees to', () => {
    expect(LICENSE_NOTICE).toBe(
      'This plugin uses your own installation of Remotion, which is licensed separately by Remotion AG. CutPilot does not include or license Remotion. You are responsible for complying with Remotion’s license: it’s free for individuals and companies of up to 3 people; larger companies need a Remotion Company License — remotion.pro.',
    );
  });

  test('acceptance is recorded per project and Remotion version, with a time and never the key', () => {
    const dir = join(tmp, 'state');
    const at = new Date('2026-10-01T10:00:00.000Z');
    const a = { projectDir: '/p/one', remotionVersion: '4.0.532', license: 'free' as const };
    expect(recordAcceptance(dir, a, at)).toEqual({
      acceptance: { ...a, acceptedAt: at.toISOString() },
      isNew: true,
    });
    expect(recordAcceptance(dir, a).isNew).toBe(false);
    expect(recordAcceptance(dir, { ...a, projectDir: '/p/two' }).isNew).toBe(true);
    expect(recordAcceptance(dir, { ...a, remotionVersion: '4.0.540' }).isNew).toBe(true);
    expect(recordAcceptance(dir, { ...a, license: 'company' }).isNew).toBe(true);
    expect(readAcceptances(dir)).toHaveLength(4);
    expect(JSON.stringify(readAcceptances(dir))).not.toContain('rm_');
  });
});
