import { describe, expect, test } from 'vitest';
import { parseManifest, secretEnv, settingEnv, type Manifest } from './manifest.js';

/** The three first-party plugins (P3-030–034), as their manifests will read. */
const FIRST_PARTY: Record<string, unknown> = {
  'cloud-transcribe': {
    id: 'cloud-transcribe',
    name: 'Cloud transcription',
    version: '1.0.0',
    description: 'Transcribe with ElevenLabs Scribe or OpenAI, using your own API key. Audio is uploaded.',
    publisher: 'NodCut',
    contract: 1,
    nodcut: '>=0.3 <1',
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
    publisher: 'NodCut',
    icon: 'icon.png',
    contract: 1,
    nodcut: '^0.3.0',
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
    nodcut: '>=0.3',
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
      nodcut: '*',
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
    [{ contract: 2 }, 'contract: this NodCut speaks plugin contract 1'],
    [{ nodcut: 'soon' }, 'nodcut: nodcut is a semver range'],
    [
      { kinds: ['analyzer:faces'] },
      'kinds.0: kinds are transcriber, analyzer:reframe-track, asset:music, generator, asset:sound, language',
    ],
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
    [{ icon: 'icon.svg' }, 'icon: the icon is a PNG, like icon.png'],
    [{ icon: '/Users/me/icon.png' }, 'icon: the icon is a path inside the plugin folder'],
    [{ icon: '../shared/icon.png' }, 'icon: the icon is a path inside the plugin folder'],
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
    [
      { settings: [{ key: 'dir', label: 'Folder', type: 'folder', default: 'videos' }] },
      'settings.0.default: the default of a folder setting is empty or an absolute path',
    ],
    [
      { settings: [{ key: 'dir', label: 'Folder', type: 'folder', choices: ['a', 'b'] }] },
      'settings.0.choices: only choice settings have choices',
    ],
    [{ run: 'node index.js' }, 'Unrecognized key: "run"'],
  ])('rejects %j with a readable problem', (over, want) => {
    expect(problems(over).join('\n')).toContain(want);
  });

  test('a language plugin is data only: no command, permissions or settings (P3-067)', () => {
    const pack = {
      id: 'lang-de',
      name: 'Deutsch',
      version: '1.0.0',
      description: 'NodCut in German.',
      contract: 1,
      nodcut: '>=0.3',
      kinds: ['language'],
      languages: [{ code: 'de', name: 'Deutsch', messages: 'de.json', menu: 'de.menu.json' }],
    };
    const ok = parseManifest(pack);
    expect(ok.ok ? [] : ok.problems).toEqual([]);
    expect(ok.ok && ok.manifest.command).toBeUndefined();
    const bad = (over: Record<string, unknown>) => {
      const r = parseManifest({ ...pack, ...over });
      return r.ok ? '' : r.problems.join('\n');
    };
    expect(bad({ languages: [] })).toContain('languages: a language plugin lists its languages');
    expect(bad({ command: 'node', args: ['dist/index.js'] })).toContain(
      'command: a language plugin is data only: it has no command',
    );
    expect(bad({ kinds: ['language', 'generator'] })).toContain(
      'kinds: a language plugin is only a language plugin',
    );
    expect(bad({ permissions: { network: ['x.io'], secrets: [], reads: [] } })).toContain(
      'permissions: a language plugin asks for no permissions',
    );
    expect(bad({ settings: [{ key: 'x', label: 'X', type: 'string' }] })).toContain(
      'settings: a language plugin has no settings',
    );
    const de = { code: 'de', name: 'Deutsch', messages: 'de.json' };
    expect(bad({ languages: [de, de] })).toContain('languages: language de is listed twice');
    expect(bad({ languages: [{ ...de, code: 'en' }] })).toContain('English is built in');
    expect(bad({ languages: [{ ...de, code: 'German' }] })).toContain('language codes look like de, pt-BR');
    expect(bad({ languages: [{ ...de, messages: 'de.po' }] })).toContain('a catalogue is a .json file');
    expect(bad({ languages: [{ ...de, menu: '../de.json' }] })).toContain('a path inside the plugin folder');
    // and only a language plugin has languages
    expect(problems({ languages: [de] }).join('\n')).toContain(
      'languages: only a language plugin has languages',
    );
  });

  test('a missing field is named', () => {
    const { command: _drop, ...rest } = base;
    const r = parseManifest(rest);
    expect(r.ok ? [] : r.problems).toEqual(['command: the command that starts the plugin is missing']);
  });

  test('not an object at all', () => {
    expect(parseManifest('{"id": 1}').ok).toBe(false);
  });

  test('a folder setting: empty or an absolute path by default', () => {
    for (const d of [undefined, '', '/Users/me/Videos', 'C:\\Videos']) {
      const r = parseManifest({
        ...base,
        settings: [
          {
            key: 'projectDir',
            label: 'Project folder',
            type: 'folder',
            ...(d === undefined ? {} : { default: d }),
          },
        ],
      });
      expect(r.ok, String(d)).toBe(true);
    }
  });

  test('environment names for settings and secrets', () => {
    expect(settingEnv('provider')).toBe('NODCUT_SETTING_PROVIDER');
    expect(settingEnv('sampleFps')).toBe('NODCUT_SETTING_SAMPLE_FPS');
    expect(secretEnv('ELEVENLABS_API_KEY')).toBe('NODCUT_SECRET_ELEVENLABS_API_KEY');
  });
});
