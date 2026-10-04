import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  ensureRootPatched,
  findEntryPoint,
  findRootFile,
  importSpec,
  patchRootSource,
  unifiedDiff,
} from './root-patch.js';
import { BLANK_ROOT } from './test-helpers/fake-project.js';

const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-root-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(tmp, `p${n++}`);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

describe('patching the root component', () => {
  test('the blank template: the tag before </>, the import after the last import, in its style', () => {
    const r = patchRootSource(BLANK_ROOT, './nodcut');
    expect(r).toEqual({
      kind: 'patched',
      text: `import { MyComposition } from "./Composition";
import { NodCutCompositions } from "./nodcut";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
      <NodCutCompositions />
    </>
  );
};
`,
    });
  });

  test('already patched: nothing to do, also when it was added by hand', () => {
    const once = patchRootSource(BLANK_ROOT, './nodcut');
    expect(once.kind === 'patched' && patchRootSource(once.text, './nodcut')).toEqual({ kind: 'already' });
    expect(patchRootSource('export const R = () => <><NodCutCompositions/></>;', './nodcut')).toEqual({
      kind: 'already',
    });
  });

  test('a fragment on one line, no imports, tabs and multi-line imports', () => {
    expect(patchRootSource('export const R = () => <><A /></>;\n', './nodcut')).toEqual({
      kind: 'patched',
      text: "import { NodCutCompositions } from './nodcut';\nexport const R = () => <><A /><NodCutCompositions /></>;\n",
    });
    const tabs = `import {\n\tA,\n\tB,\n} from './comps'\n\nexport const R = () => (\n\t<>\n\t\t<A />\n\t</>\n)\n`;
    expect(patchRootSource(tabs, '../nodcut')).toEqual({
      kind: 'patched',
      text: `import {\n\tA,\n\tB,\n} from './comps'\nimport { NodCutCompositions } from '../nodcut'\n\nexport const R = () => (\n\t<>\n\t\t<A />\n\t\t<NodCutCompositions />\n\t</>\n)\n`,
    });
  });

  test('no fragment, or more than one: left to the user, with the reason', () => {
    const single = `import { Composition } from 'remotion';\nexport const R = () => <Composition id="a" />;\n`;
    expect(patchRootSource(single, './nodcut')).toEqual({
      kind: 'manual',
      reason: "its root component doesn't return a fragment (<>…</>)",
    });
    const two = `const A = () => <><B /></>;\nexport const R = () => <><A /></>;\n`;
    expect(patchRootSource(two, './nodcut')).toEqual({
      kind: 'manual',
      reason: "it has 2 fragments, so the right place isn't certain",
    });
  });

  test('import specifier from the root file to src/nodcut', () => {
    expect(importSpec('/p/src/Root.tsx', '/p')).toBe('./nodcut');
    expect(importSpec('/p/src/remotion/Root.tsx', '/p')).toBe('../nodcut');
    expect(importSpec('/p/remotion/Root.tsx', '/p')).toBe('../src/nodcut');
  });
});

describe('finding the entry point and the root file', () => {
  test('Config.setEntryPoint wins, then a remotion script, then the defaults', () => {
    const a = project({
      'remotion.config.ts':
        "import { Config } from '@remotion/cli/config';\nConfig.setEntryPoint('./video/entry.tsx');\n",
      'video/entry.tsx': '',
      'src/index.ts': '',
      'package.json': '{}',
    });
    expect(findEntryPoint(a)).toBe(join(a, 'video/entry.tsx'));
    const b = project({
      'package.json': JSON.stringify({ scripts: { dev: 'remotion studio remotion/main.ts --port 3001' } }),
      'remotion/main.ts': '',
      'src/index.ts': '',
    });
    expect(findEntryPoint(b)).toBe(join(b, 'remotion/main.ts'));
    const c = project({ 'package.json': '{}', 'src/index.ts': '' });
    expect(findEntryPoint(c)).toBe(join(c, 'src/index.ts'));
    expect(findEntryPoint(project({ 'package.json': '{}' }))).toBeNull();
    // never outside the project
    const d = project({
      'remotion.config.ts': "Config.setEntryPoint('../../etc/x.ts');",
      'package.json': '{}',
    });
    expect(findEntryPoint(d)).toBeNull();
  });

  test('registerRoot(X): named, aliased, default import, or defined in the entry itself', () => {
    const p = project({
      'src/Root.tsx': '',
      'src/roots/Main.tsx': '',
      'src/named.ts':
        'import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\nregisterRoot(RemotionRoot);\n',
      'src/alias.ts':
        "import { registerRoot } from 'remotion';\nimport { Main as Root } from './roots/Main';\nregisterRoot(Root);\n",
      'src/default.ts':
        "import { registerRoot } from 'remotion';\nimport Root from './roots/Main.js';\nregisterRoot(Root);\n",
      'src/inline.tsx':
        "import { registerRoot } from 'remotion';\nconst Root = () => <></>;\nregisterRoot(Root);\n",
      'src/none.ts':
        "import { registerRoot } from 'remotion';\nimport { Root } from 'some-package';\nregisterRoot(Root);\n",
    });
    expect(findRootFile(join(p, 'src/named.ts'))).toBe(join(p, 'src/Root.tsx'));
    expect(findRootFile(join(p, 'src/alias.ts'))).toBe(join(p, 'src/roots/Main.tsx'));
    expect(findRootFile(join(p, 'src/default.ts'))).toBe(join(p, 'src/roots/Main.tsx'));
    expect(findRootFile(join(p, 'src/inline.tsx'))).toBe(join(p, 'src/inline.tsx'));
    expect(findRootFile(join(p, 'src/none.ts'))).toBeNull();
  });
});

describe('ensureRootPatched', () => {
  const blank = () =>
    project({
      'package.json': '{}',
      'src/index.ts':
        'import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\n\nregisterRoot(RemotionRoot);\n',
      'src/Root.tsx': BLANK_ROOT,
    });

  test('patches once, with a backup of the original and a diff; then it is a no-op', () => {
    const p = blank();
    const now = new Date('2026-10-01T12:00:00.000Z');
    const r = ensureRootPatched(p, { now });
    expect(r.state).toBe('patched');
    expect(r.file).toBe('src/Root.tsx');
    expect(r.backup).toBe('src/nodcut/backups/src_Root.tsx.2026-10-01T12-00-00-000Z.bak');
    expect(readFileSync(join(p, r.backup!), 'utf8')).toBe(BLANK_ROOT);
    expect(r.diff).toContain('+import { NodCutCompositions } from "./nodcut";');
    expect(r.diff).toContain('+      <NodCutCompositions />');
    expect(readFileSync(join(p, 'src/Root.tsx'), 'utf8')).toContain('<NodCutCompositions />');
    expect(ensureRootPatched(p)).toEqual({ state: 'already', file: 'src/Root.tsx' });
  });

  test('write: false only says what would change', () => {
    const p = blank();
    expect(ensureRootPatched(p, { write: false })).toMatchObject({ state: 'pending', file: 'src/Root.tsx' });
    expect(readFileSync(join(p, 'src/Root.tsx'), 'utf8')).toBe(BLANK_ROOT);
  });

  test("an unusual layout isn't guessed at: nothing written, the two lines to add", () => {
    const p = blank();
    const odd =
      'import { Composition } from \'remotion\';\nexport const RemotionRoot = () => <Composition id="a" />;\n';
    writeFileSync(join(p, 'src/Root.tsx'), odd);
    const r = ensureRootPatched(p);
    expect(r.state).toBe('manual');
    expect(r.instructions).toContain("import { NodCutCompositions } from './nodcut';");
    expect(r.instructions).toContain('<NodCutCompositions />');
    expect(readFileSync(join(p, 'src/Root.tsx'), 'utf8')).toBe(odd);
    expect(ensureRootPatched(project({ 'package.json': '{}' })).state).toBe('manual');
  });
});

test('unified diff of an insertion', () => {
  expect(unifiedDiff('f', 'a\nb\nc\nd\ne\nf', 'a\nb\nc\nX\nd\ne\nf')).toBe(
    '--- a/f\n+++ b/f\n@@ -2,4 +2,5 @@\n b\n c\n+X\n d\n e',
  );
});
