#!/usr/bin/env node
/**
 * Bundle a Node plugin of this workspace into a folder that stands alone, ready for
 * `nodcut plugin pack` (or for `nodcut plugin install <folder>` without --link):
 *
 *   node scripts/bundle-plugin.mjs plugins/hyperframes [--out build/hyperframes]
 *
 * An installed plugin must carry its own dependencies, and a package can't contain links, so a
 * workspace folder (pnpm symlinks, a `workspace:*` SDK) can't be packed as it is. This writes:
 * - the entry the manifest starts, bundled with esbuild. The SDK, plugin-api, zod and the MCP
 *   SDK go into the bundle: there must be one copy of zod between the plugin and the SDK;
 * - every other dependency of the plugin, installed with npm as real folders, because a CLI the
 *   plugin runs (`hyperframes`) or a file it copies at run time (`gsap`) can't be bundled;
 * - the manifest, its icon, README, LICENSE, and a package.json that names those dependencies;
 * - whatever else the plugin's package.json lists in `files` (npm's list of what a package
 *   ships: a music library, a helper binary), except the entry's folder, which esbuild writes.
 *   Plain paths, no globs; a listed path that doesn't exist is skipped with a note (e.g. a
 *   helper binary not built on this machine).
 *
 * A data-only plugin (a language pack, P3-067) has nothing to bundle: its manifest, the
 * catalogues it names, its icon, README and LICENSE are copied as they are.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const ROOT = join(import.meta.dirname, '..');
/** Bundled with the plugin's own code, never installed next to it. */
const BUNDLED = [/^@nodcut\//, /^zod(\/|$)/, /^@modelcontextprotocol\/sdk(\/|$)/];
const COPIED = ['nodcut-plugin.json', 'README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md'];

/**
 * @param {string} dir the plugin folder
 * @param {string} [out] where to write (default: build/<id> in this repo); emptied first
 * @param {{ log?: (line: string) => void }} [options]
 * @returns {Promise<{ dir: string; entry: string; bytes: number; installed: string[] }>}
 */
export async function bundlePlugin(dir, out, { log = () => {} } = {}) {
  const src = resolve(dir);
  const manifest = JSON.parse(readFileSync(join(src, 'nodcut-plugin.json'), 'utf8'));
  if (manifest.command === undefined) return copyData(src, manifest, out, log);
  const entry = manifest.args?.[0];
  if (manifest.command !== 'node' || !entry)
    throw new Error(`${manifest.id}: only a plugin started with "node <file>" can be bundled`);
  if (!existsSync(join(src, entry)))
    throw new Error(`${join(src, entry)} doesn't exist: build the plugin first`);
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  // pinned to the versions the workspace resolved, so the same lockfile gives the same package
  const installed = Object.entries(pkg.dependencies ?? {})
    .filter(([name]) => !BUNDLED.some((re) => re.test(name)))
    .map(([name, range]) => [name, resolvedVersion(src, name) ?? range]);

  const dest = resolve(out ?? join(ROOT, 'build', manifest.id));
  if (dest === src || src.startsWith(dest + sep))
    throw new Error(`the output folder ${dest} contains the plugin`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const result = await build({
    entryPoints: [join(src, entry)],
    outfile: join(dest, entry),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: installed.flatMap(([name]) => [name, `${name}/*`]),
    // CommonJS dependencies inside the bundle (the MCP SDK's) require Node modules at run time;
    // an ES module has no require, so give them one (esbuild's shim looks for a global)
    banner: {
      js: 'import { createRequire as __nodcutRequire } from "node:module"; if (typeof globalThis.require === "undefined") globalThis.require = __nodcutRequire(import.meta.url);',
    },
    metafile: true,
    logLevel: 'silent',
  });
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  log(`bundled ${entry} (${Math.round(bytes / 1024)} KB)`);

  for (const f of COPIED) if (existsSync(join(src, f))) copyFileSync(join(src, f), join(dest, f));
  if (manifest.icon && existsSync(join(src, manifest.icon))) {
    mkdirSync(dirname(join(dest, manifest.icon)), { recursive: true });
    copyFileSync(join(src, manifest.icon), join(dest, manifest.icon));
  }
  const entryDir = entry.split(/[\\/]/)[0];
  for (const f of pkg.files ?? []) {
    const rel = f.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!rel || rel === 'package.json' || rel === entryDir || rel === entry) continue;
    const from = resolve(src, rel);
    if (from === src || !from.startsWith(src + sep)) throw new Error(`files: ${f} is outside the plugin`);
    if (!existsSync(from)) {
      log(`skipped ${rel} (listed in files, not there)`);
      continue;
    }
    cpSync(from, join(dest, rel), { recursive: true, dereference: true });
    log(`copied ${rel}`);
  }
  writeFileSync(
    join(dest, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        version: manifest.version,
        description: manifest.description,
        type: 'module',
        private: true,
        license: pkg.license,
        dependencies: Object.fromEntries(installed),
      },
      null,
      2,
    ) + '\n',
  );

  if (installed.length) {
    log(`installing ${installed.map(([n]) => n).join(', ')} with npm`);
    execFileSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      [
        'install',
        '--omit=dev',
        '--no-package-lock',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--loglevel=error',
      ],
      { cwd: dest, stdio: ['ignore', 'inherit', 'inherit'] },
    );
  }
  const link = findLink(dest);
  if (link) throw new Error(`${link} is a link; a package can't contain links`);
  return { dir: dest, entry, bytes, installed: installed.map(([n]) => n) };
}

/** A data-only plugin as a package folder: the files its manifest names, copied. */
function copyData(src, manifest, out, log) {
  const dest = resolve(out ?? join(ROOT, 'build', manifest.id));
  if (dest === src || src.startsWith(dest + sep))
    throw new Error(`the output folder ${dest} contains the plugin`);
  const named = (manifest.languages ?? []).flatMap((l) => [l.messages, l.menu]).filter(Boolean);
  if (!named.length) throw new Error(`${manifest.id}: a data-only plugin names its files in "languages"`);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  let bytes = 0;
  for (const f of [...COPIED, ...(manifest.icon ? [manifest.icon] : []), ...named]) {
    const from = resolve(src, f);
    if (!from.startsWith(src + sep)) throw new Error(`${f} is outside the plugin`);
    if (!existsSync(from)) {
      if (named.includes(f)) throw new Error(`${f} doesn't exist`);
      continue;
    }
    mkdirSync(dirname(join(dest, f)), { recursive: true });
    copyFileSync(from, join(dest, f));
    bytes += lstatSync(from).size;
  }
  log(`copied ${named.length} catalogues (${Math.round(bytes / 1024)} KB)`);
  return { dir: dest, entry: null, bytes, installed: [] };
}

/** The version of a dependency as installed in the plugin's own node_modules, if it is there. */
function resolvedVersion(dir, name) {
  try {
    return JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/** The first symbolic link a package would include (dot files and folders are left out of packages). */
function findLink(root, rel = '') {
  for (const name of readdirSync(join(root, rel))) {
    if (name.startsWith('.')) continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(join(root, r));
    if (st.isSymbolicLink()) return r;
    if (st.isDirectory()) {
      const found = findLink(root, r);
      if (found) return found;
    }
  }
  return null;
}

// run as a command (not when imported, e.g. from a test or `node -e`, where argv[1] may be unset)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args[outAt + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));
  if (!dir) {
    console.error('usage: node scripts/bundle-plugin.mjs <plugin folder> [--out <folder>]');
    process.exit(2);
  }
  try {
    const r = await bundlePlugin(dir, out, { log: (l) => console.error(l) });
    console.log(r.dir);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
