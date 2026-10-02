/**
 * Licence guard: Remotion must never ship with this plugin. Each user brings their own Remotion
 * (and their own Remotion licence); the plugin loads it from their project at run time. These
 * checks fail `pnpm check` (and CI) if Remotion gets into the plugin's dependencies, its
 * sources as a value import, or the bundle `pnpm bundle` makes for the store.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { afterAll, describe, expect, test } from 'vitest';
import { bundlePlugin } from '../../../scripts/bundle-plugin.mjs';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const isRemotion = (name: string) => name === 'remotion' || name.startsWith('@remotion/');
/** A path inside an installed Remotion package: …/node_modules/remotion/… or …/node_modules/@remotion/x/… */
const inRemotionPackage = (path: string) =>
  /(^|\/)node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(remotion|@remotion\/[^/]+)\//.test(path);

/** The module specifiers a source file loads at run time: value imports, re-exports, require(), import(). */
function runtimeImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) && !n.importClause?.isTypeOnly && ts.isStringLiteral(n.moduleSpecifier))
      out.push(n.moduleSpecifier.text);
    if (
      ts.isExportDeclaration(n) &&
      !n.isTypeOnly &&
      n.moduleSpecifier &&
      ts.isStringLiteral(n.moduleSpecifier)
    )
      out.push(n.moduleSpecifier.text);
    if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteralLike(n.arguments[0])
    )
      out.push(n.arguments[0].text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const tmp = mkdtempSync(join(tmpdir(), 'cp-remotion-bundle-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('Remotion is never part of the plugin', () => {
  test('not in dependencies, peerDependencies or optionalDependencies', () => {
    const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies'])
      expect(Object.keys(pkg[field] ?? {}).filter(isRemotion), field).toEqual([]);
  });

  test('the sources import Remotion only as types (erased when compiled)', () => {
    const sources = readdirSync(join(DIR, 'src'), { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.startsWith('test-helpers'));
    expect(sources).toContain('remotion.ts');
    for (const f of sources) expect(runtimeImports(join(DIR, 'src', f)).filter(isRemotion), f).toEqual([]);
  });

  test('a bundle of the entry pulls in no Remotion module', async () => {
    const r = await build({
      entryPoints: [join(DIR, 'src', 'index.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      write: false,
      metafile: true,
      logLevel: 'silent',
      outfile: join(tmp, 'index.js'),
    });
    const inputs = Object.keys(r.metafile.inputs);
    expect(inputs.some((i) => i.includes('plugins/remotion/src/plugin.ts'))).toBe(true);
    expect(inputs.filter(inRemotionPackage)).toEqual([]);
    const external = Object.values(r.metafile.outputs).flatMap((o) => o.imports.map((i) => i.path));
    expect(external.filter(isRemotion)).toEqual([]);
  });

  test.skipIf(!existsSync(join(DIR, 'dist', 'index.js')))(
    'the store bundle (pnpm bundle) installs nothing of Remotion',
    async () => {
      const out = join(tmp, 'build');
      const b = await bundlePlugin(DIR, out);
      expect(b.installed.filter(isRemotion)).toEqual([]);
      const pkg = JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      };
      expect(Object.keys(pkg.dependencies).filter(isRemotion)).toEqual([]);
      const files = readdirSync(out, { recursive: true }).map(String);
      expect(files.map((f) => f.split('\\').join('/')).filter(inRemotionPackage)).toEqual([]);
      // what the shipped file itself loads, as a parser sees it (its guide text mentions "remotion")
      expect(runtimeImports(join(out, 'dist', 'index.js')).filter(isRemotion)).toEqual([]);
    },
  );
});
