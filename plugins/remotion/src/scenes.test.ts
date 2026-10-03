import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginFailure } from '@cutpilot/plugin-sdk';
import fc from 'fast-check';
import { afterAll, describe, expect, test } from 'vitest';
import { missingFileFailure, missingPublicFiles } from './remotion.js';
import {
  checkSceneId,
  codeProblem,
  deleteScene,
  indexSource,
  listScenes,
  parseSceneSource,
  propsSchema,
  sceneFile,
  sceneSource,
  writeScene,
  type SceneMeta,
} from './scenes.js';

const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-scenes-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const meta: SceneMeta = {
  durationInFrames: 300,
  fps: 30,
  width: 1080,
  height: 1920,
  defaultProps: { headline: 'Just got safer', accent: '#C6FF00' },
};
const CODE = `import { AbsoluteFill } from 'remotion';\n\nexport default function Scene() {\n  return <AbsoluteFill />;\n}\n`;

const codeOf = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(PluginFailure);
    return (e as PluginFailure).code;
  }
  return null;
};

describe('scene ids', () => {
  test('kebab-case ids are accepted', () => {
    for (const id of ['promo', 'promo-intro', 'a1-b2', 'x'.repeat(40)]) expect(checkSceneId(id)).toBe(id);
  });

  test("anything that could leave src/cutpilot, or isn't a template id, is refused", () => {
    for (const id of [
      '../Root',
      '..',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'promo.tsx',
      'Promo',
      'promo intro',
      '',
      '-promo',
      'promo-',
      'a--b',
      '1promo',
      'index',
      'x'.repeat(41),
      'x'.repeat(65),
      42,
      null,
    ])
      expect(
        codeOf(() => checkSceneId(id)),
        String(id),
      ).toBe('E_REMOTION_BAD_SCENE_ID');
  });

  test('every accepted id names a file directly inside src/cutpilot', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 70 }), (id) => {
        let file: string;
        try {
          file = sceneFile('/p', id);
        } catch {
          return true;
        }
        return file === `/p/src/cutpilot/${id}.tsx` && /^[a-z0-9-]{1,64}$/.test(id);
      }),
    );
  });
});

describe('scene files', () => {
  test('code and metadata survive a round trip', () => {
    const text = sceneSource(CODE, meta);
    expect(text).toContain('export const cutpilotScene = {"durationInFrames":300');
    expect(parseSceneSource(text)).toEqual({ code: CODE, meta });
  });

  test("a file that isn't ours, or whose metadata is broken, isn't a scene", () => {
    expect(parseSceneSource(CODE)).toBeNull();
    expect(parseSceneSource(sceneSource(CODE, meta).replace('"fps":30', '"fps":-1'))).toBeNull();
    expect(
      parseSceneSource(sceneSource(CODE, meta).replace('{"durationInFrames"', '{durationInFrames')),
    ).toBeNull();
  });

  test('the code must default-export the component and leave the metadata to the plugin', () => {
    expect(codeProblem(CODE)).toBeNull();
    expect(codeProblem('  ')).toBe('the code is empty');
    expect(codeProblem('export const Scene = () => null;')).toMatch(/export default/);
    expect(codeProblem(`${CODE}\nexport const cutpilotScene = {};`)).toMatch(/leave out cutpilotScene/);
  });

  test('write, list, delete: index.tsx follows; other files in the folder are left alone', () => {
    const dir = join(tmp, 'p1');
    mkdirSync(join(dir, 'src', 'cutpilot'), { recursive: true });
    writeFileSync(join(dir, 'src', 'cutpilot', 'notes.tsx'), 'export const x = 1;\n');
    writeScene(dir, 'outro', CODE, meta);
    writeScene(dir, 'intro', CODE, { ...meta, durationInFrames: 60 });
    expect(listScenes(dir).map((s) => [s.id, s.meta.durationInFrames])).toEqual([
      ['intro', 60],
      ['outro', 300],
    ]);
    const index = readFileSync(join(dir, 'src', 'cutpilot', 'index.tsx'), 'utf8');
    expect(index).toBe(indexSource(['intro', 'outro']));
    expect(deleteScene(dir, 'intro')).toBe(true);
    expect(deleteScene(dir, 'intro')).toBe(false);
    expect(readFileSync(join(dir, 'src', 'cutpilot', 'index.tsx'), 'utf8')).toBe(indexSource(['outro']));
    expect(existsSync(join(dir, 'src', 'cutpilot', 'notes.tsx'))).toBe(true);
    expect(existsSync(join(dir, 'src', 'cutpilot', 'intro.tsx.cutpilot-tmp'))).toBe(false);
  });
});

describe('index.tsx', () => {
  test('with no scenes it still exports CutPilotCompositions, importing nothing (noUnusedLocals)', () => {
    const s = indexSource([]);
    expect(s).toContain('export const CutPilotCompositions = () => null;');
    expect(s).not.toContain('import');
  });

  test('registers each scene as cutpilot-<id>, sorted, with identifiers safe for hyphens', () => {
    const s = indexSource(['promo-outro', 'intro']);
    expect(s).toMatch(/import S0_intro, \{ cutpilotScene as S0_intro_meta \} from '\.\/intro';/);
    expect(s).toMatch(
      /import S1_promo_outro, \{ cutpilotScene as S1_promo_outro_meta \} from '\.\/promo-outro';/,
    );
    expect(s.indexOf('id="cutpilot-intro"')).toBeLessThan(s.indexOf('id="cutpilot-promo-outro"'));
    expect(s).toContain('durationInFrames={S1_promo_outro_meta.durationInFrames}');
    expect(s).toContain('defaultProps={S0_intro_meta.defaultProps as Props}');
    expect(indexSource(['b', 'a'])).toBe(indexSource(['a', 'b']));
  });
});

test('props schema: each default typed, all optional', () => {
  expect(propsSchema({ headline: 'Hi', size: 3, bold: true, items: ['a'], style: { a: 1 } })).toEqual({
    type: 'object',
    properties: {
      headline: { type: 'string', default: 'Hi' },
      size: { type: 'number', default: 3 },
      bold: { type: 'boolean', default: true },
      items: { type: 'array', default: ['a'] },
      style: { type: 'object', default: { a: 1 } },
    },
    additionalProperties: true,
  });
});

describe('missingPublicFiles', () => {
  test('names the files of public/ a Remotion error points at that are not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cp-remotion-public-'));
    try {
      mkdirSync(join(dir, 'public', 'img'), { recursive: true });
      writeFileSync(join(dir, 'public', 'img', 'here.png'), '');
      const msg = [
        'Error loading image with src: http://localhost:3000/public/cleanup.webp',
        'and http://127.0.0.1:3001/public/CutPilot%20sample.mp4?t=1, then http://localhost:3000/public/img/here.png.',
        'a repeat: http://localhost:3000/public/cleanup.webp, outside: http://localhost:3000/public/../etc/passwd',
        'elsewhere: https://example.com/public/x.png',
      ].join('\n');
      expect(missingPublicFiles(dir, msg)).toEqual(['cleanup.webp', 'CutPilot sample.mp4']);
      expect(missingPublicFiles(dir, 'ReferenceError: foo is not defined')).toEqual([]);
      expect(missingFileFailure(dir, new Error('nothing about files'))).toBeNull();
      expect(missingFileFailure(dir, new Error(msg))?.message).toBe(
        `the scene loads public/cleanup.webp, public/CutPilot sample.mp4 with staticFile(), and they aren't in the Remotion project (${join(dir, 'public')})`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
