/**
 * A Remotion project on disk whose node_modules hold stand-ins for remotion, @remotion/renderer
 * and @remotion/bundler: they record their calls and write small files instead of rendering, so
 * the tools can be tested without Remotion or Chrome. The plugin loads them from the project
 * folder exactly as it loads the real ones.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeCall {
  fn: string;
  args: Record<string, unknown>;
}

declare global {
  var __fakeRemotion: Record<string, FakeCall[]> | undefined;
}

/** The calls the stand-ins received, for a project folder. */
export const fakeCalls = (dir: string): FakeCall[] => (globalThis.__fakeRemotion ??= {})[dir] ?? [];

const RENDERER = `
const fs = require('node:fs');
const path = require('node:path');
const DIR = PROJECT_DIR;
const calls = () => ((globalThis.__fakeRemotion ??= {})[DIR] ??= []);
const log = (fn, args) => calls().push({ fn, args: JSON.parse(JSON.stringify(args ?? {}, (k, v) => (typeof v === 'function' ? '[fn]' : v))) });
const scenes = (serveUrl) => JSON.parse(fs.readFileSync(path.join(serveUrl, 'scenes.json'), 'utf8'));
exports.ensureBrowser = async (o) => { log('ensureBrowser', o); return { type: 'local-puppeteer-browser', path: '/fake/chrome' }; };
exports.selectComposition = async (o) => {
  log('selectComposition', o);
  const s = scenes(o.serveUrl)[o.id];
  if (!s) throw new Error('Could not find composition with ID ' + o.id + '. The following compositions are available: ' + Object.keys(scenes(o.serveUrl)).join(', '));
  if (s.throws) throw new Error(s.throws);
  return { id: o.id, ...s, props: { ...s.defaultProps, ...(o.inputProps ?? {}) } };
};
exports.renderStill = async (o) => {
  log('renderStill', o);
  return { buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, o.frame & 0xff]) };
};
exports.renderMedia = async (o) => {
  log('renderMedia', o);
  let cancelled = false;
  o.cancelSignal?.(() => { cancelled = true; });
  if (o.composition.props?.slow || o.inputProps?.slow) {
    for (let i = 0; i < 100 && !cancelled; i++) await new Promise((r) => setTimeout(r, 10));
    if (cancelled) throw new Error('renderMedia() got cancelled');
  }
  const frames = Array.isArray(o.frameRange) ? o.frameRange[1] - o.frameRange[0] + 1 : typeof o.frameRange === 'number' ? 1 : o.composition.durationInFrames;
  o.onProgress?.({ progress: 1, renderedFrames: frames, encodedFrames: frames, stitchStage: 'muxing' });
  fs.writeFileSync(o.outputLocation, JSON.stringify({ width: o.composition.width, height: o.composition.height, durationInSeconds: frames / o.composition.fps, fps: o.composition.fps }));
  return {};
};
exports.getVideoMetadata = async (file) => {
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...m, audioCodec: null };
};
exports.makeCancelSignal = () => {
  const cbs = [];
  return { cancelSignal: (cb) => cbs.push(cb), cancel: () => cbs.splice(0).forEach((cb) => cb()) };
};
`;

/**
 * The stand-in bundler reads the scene files' metadata (the real one runs webpack); a scene whose
 * code contains BUNDLE_ERROR fails to bundle, one with LOAD_ERROR fails selectComposition.
 */
const BUNDLER = `
const fs = require('node:fs');
const path = require('node:path');
const DIR = PROJECT_DIR;
const calls = () => ((globalThis.__fakeRemotion ??= {})[DIR] ??= []);
exports.bundle = async (o) => {
  calls().push({ fn: 'bundle', args: { entryPoint: o.entryPoint, outDir: o.outDir } });
  const dir = path.join(DIR, 'src', 'cutpilot');
  const scenes = {};
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!f.endsWith('.tsx') || f === 'index.tsx') continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (text.includes('BUNDLE_ERROR')) throw new Error('Module parse failed: Unexpected token (3:10)\\nYou may need an appropriate loader');
    const m = /export const cutpilotScene = (.*);/.exec(text);
    if (!m) continue;
    const meta = JSON.parse(m[1]);
    scenes['cutpilot-' + f.slice(0, -4)] = { ...meta, ...(text.includes('LOAD_ERROR') ? { throws: 'ReferenceError: foo is not defined\\n    at Scene (promo.tsx:4:3)' } : {}) };
  }
  o.onProgress?.(50);
  fs.mkdirSync(o.outDir, { recursive: true });
  fs.writeFileSync(path.join(o.outDir, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(o.outDir, 'scenes.json'), JSON.stringify(scenes));
  o.onProgress?.(100);
  return o.outDir;
};
`;

export interface FakeOptions {
  /** versions of remotion, @remotion/renderer, @remotion/bundler; null leaves one out */
  versions?: Partial<Record<'remotion' | '@remotion/renderer' | '@remotion/bundler', string | null>>;
  root?: string;
}

export const BLANK_ROOT = `import { MyComposition } from "./Composition";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <MyComposition />
    </>
  );
};
`;

/** A blank Remotion project like `create-video --blank` makes, with the stand-ins installed. */
export function fakeProject(opts: FakeOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cp-remotion-fake-'));
  const v = {
    remotion: '4.0.532',
    '@remotion/renderer': '4.0.532',
    '@remotion/bundler': '4.0.532',
    ...opts.versions,
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fake', private: true, dependencies: {} }));
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src', 'index.ts'),
    'import { registerRoot } from "remotion";\nimport { RemotionRoot } from "./Root";\n\nregisterRoot(RemotionRoot);\n',
  );
  writeFileSync(join(dir, 'src', 'Root.tsx'), opts.root ?? BLANK_ROOT);
  const pkg = (name: string, version: string, source: string) => {
    const p = join(dir, 'node_modules', ...name.split('/'));
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }));
    writeFileSync(join(p, 'index.js'), source.replace(/PROJECT_DIR/g, JSON.stringify(dir)));
  };
  if (v.remotion) pkg('remotion', v.remotion, 'exports.registerRoot = () => {};\n');
  if (v['@remotion/renderer']) pkg('@remotion/renderer', v['@remotion/renderer'], RENDERER);
  if (v['@remotion/bundler']) pkg('@remotion/bundler', v['@remotion/bundler'], BUNDLER);
  return dir;
}
