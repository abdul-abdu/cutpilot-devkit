import { describe, expect, test } from 'vitest';
import { parseManifest, secretEnv, settingEnv, type Manifest } from './manifest.js';

/** The three first-party plugins (P3-030–034), as their manifests will read. */
const FIRST_PARTY: Record<string, unknown> = {
  'cloud-transcribe': {
    id: 'cloud-transcribe',
    name: 'Cloud transcription',
    version: '1.0.0',
    description: 'Transcribe with ElevenLabs Scribe or OpenAI, using your own API key. Audio is uploaded.',
    publisher: 'CutPilot',
    contract: 1,
    cutpilot: '>=0.3 <1',
    command: 'node',
    args: ['dist/index.js'],
    kinds: ['transcriber'],
    permissions: {
      network: ['api.elevenlabs.io', 'api.openai.com'],
      secrets: ['ELEVENLABS_API_KEY', 'OPENAI_API_KEY'],
      reads: ['audio'],
    },
    settings: [
      {
        key: 'provider',
        label: 'Provider',
        type: 'choice',
        choices: ['elevenlabs', 'openai'],
        default: 'elevenlabs',
      },
    ],
  },
  'follow-speaker': {
    id: 'follow-speaker',
    name: 'Follow the speaker',
    version: '1.0.0',
    description: 'Keeps the person talking in a vertical crop, using face detection on your Mac.',
    publisher: 'CutPilot',
    contract: 1,
    cutpilot: '^0.3.0',
    command: 'node',
    args: ['dist/index.js'],
    kinds: ['analyzer:reframe-track'],
    permissions: { reads: ['source'] },
    settings: [{ key: 'sampleFps', label: 'Frames per second to check', type: 'number', default: 5 }],
  },
  music: {
    id: 'music',
    name: 'Background music',
    version: '1.0.0',
    description: 'Royalty-free tracks by mood, mixed under speech.',
    contract: 1,
    cutpilot: '>=0.3',
    command: 'node',
    args: ['dist/index.js'],
    kinds: ['asset:music'],
  },
};

const base = FIRST_PARTY['follow-speaker'] as Record<string, unknown>;
const problems = (over: Record<string, unknown>) => {
  const r = parseManifest({ ...base, ...over });
  return r.ok ? [] : r.problems;
};

describe('manifest', () => {
  test.each(Object.keys(FIRST_PARTY))('the first-party %s manifest is valid', (id) => {
    const r = parseManifest(FIRST_PARTY[id]);
    expect(r.ok ? [] : r.problems).toEqual([]);
  });

  test('defaults: no kinds, no permissions, no settings, no args', () => {
    const r = parseManifest({
      id: 'hello',
      name: 'Hello',
      version: '0.1.0',
      description: 'd',
      contract: 1,
      cutpilot: '*',
      command: 'bin/hello',
    });
    expect(r.ok && r.manifest).toMatchObject({
      args: [],
      kinds: [],
      permissions: { network: [], secrets: [], reads: [] },
      settings: [],
    } satisfies Partial<Manifest>);
  });

  test.each([
    [{ id: 'Follow_Speaker' }, 'id: ids are kebab-case'],
    [{ id: 'a'.repeat(41) }, 'id: ids are at most 40 characters'],
    [{ version: '1.0' }, 'version: versions are semver'],
    [{ contract: 2 }, 'contract: this CutPilot speaks plugin contract 1'],
    [{ cutpilot: 'soon' }, 'cutpilot: cutpilot is a semver range'],
    [{ kinds: ['analyzer:faces'] }, 'kinds.0: kinds are transcriber, analyzer:reframe-track, asset:music'],
    [
      { kinds: ['analyzer:reframe-track', 'analyzer:reframe-track'] },
      'kinds: kind analyzer:reframe-track is listed twice',
    ],
    [{ permissions: { reads: [] } }, 'permissions.reads: a analyzer:reframe-track plugin needs "source"'],
    [{ permissions: { reads: ['source'], camera: true } }, 'permissions: Unrecognized key: "camera"'],
    [
      { permissions: { reads: ['source'], secrets: ['api-key'] } },
      'permissions.secrets.0: secret names look like',
    ],
    [
      { permissions: { reads: ['source'], network: ['https://x.io'] } },
      'permissions.network.0: network entries are host names',
    ],
    [
      { permissions: { reads: ['source', 'microphone'] } },
      'permissions.reads.1: reads are source, audio, frames',
    ],
    [{ command: '/usr/bin/python3' }, 'command: the command is relative to the plugin folder'],
    [{ command: '../other/bin' }, 'command: the command stays inside the plugin folder'],
    [
      { settings: [{ key: 'mode', label: 'Mode', type: 'choice' }] },
      'settings.0.choices: a choice setting lists its choices',
    ],
    [
      { settings: [{ key: 'n', label: 'N', type: 'number', default: 'five' }] },
      'settings.0.default: the default of a number setting is a number',
    ],
    [
      { settings: [{ key: 'm', label: 'M', type: 'choice', choices: ['a', 'b'], default: 'c' }] },
      'settings.0.default: the default is one of the choices',
    ],
    [{ run: 'node index.js' }, 'Unrecognized key: "run"'],
  ])('rejects %j with a readable problem', (over, want) => {
    expect(problems(over).join('\n')).toContain(want);
  });

  test('a missing field is named', () => {
    const { command: _drop, ...rest } = base;
    const r = parseManifest(rest);
    expect(r.ok ? [] : r.problems).toEqual([expect.stringMatching(/^command: /)]);
  });

  test('not an object at all', () => {
    expect(parseManifest('{"id": 1}').ok).toBe(false);
  });

  test('environment names for settings and secrets', () => {
    expect(settingEnv('provider')).toBe('CUTPILOT_SETTING_PROVIDER');
    expect(settingEnv('sampleFps')).toBe('CUTPILOT_SETTING_SAMPLE_FPS');
    expect(secretEnv('ELEVENLABS_API_KEY')).toBe('CUTPILOT_SECRET_ELEVENLABS_API_KEY');
  });
});
