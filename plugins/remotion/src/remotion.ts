/**
 * Remotion at run time, loaded from the user's project (never from this plugin: it doesn't
 * depend on Remotion, and its bundle doesn't contain it). The types below are the few parts of
 * @remotion/bundler and @remotion/renderer 4.x this file calls, written out here so the plugin
 * needs no Remotion package even to compile.
 *
 * The plugin is its own process (CutPilot starts it next to the engine), so bundling and
 * rendering never run on the app's main thread; Remotion starts Chrome and its compositor as
 * further processes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PluginFailure, type PluginContext } from '@cutpilot/plugin-sdk';
import { projectRequire } from './project.js';

export interface VideoConfig {
  id: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: Record<string, unknown>;
  props: Record<string, unknown>;
  [k: string]: unknown;
}
type CancelSignal = (cb: () => void) => void;
type BrowserProgress = (p: { percent: number; downloadedBytes: number; totalSizeInBytes: number }) => void;
interface Renderer {
  ensureBrowser(o?: {
    onBrowserDownload?: (o: { chromeMode: string }) => {
      version: string | null;
      onProgress: BrowserProgress;
    };
    logLevel?: string;
  }): Promise<{ type: string; path?: string }>;
  selectComposition(o: {
    serveUrl: string;
    id: string;
    inputProps?: Record<string, unknown>;
    logLevel?: string;
  }): Promise<VideoConfig>;
  renderStill(o: {
    composition: VideoConfig;
    serveUrl: string;
    frame?: number;
    output?: string | null;
    inputProps?: Record<string, unknown>;
    imageFormat?: 'png' | 'jpeg';
    scale?: number;
    cancelSignal?: CancelSignal;
    licenseKey?: string | null;
    /** false: a development render, not billable on remotion.pro */
    isProduction?: boolean;
    logLevel?: string;
  }): Promise<{ buffer: Buffer | null }>;
  renderMedia(o: {
    composition: VideoConfig;
    serveUrl: string;
    codec: 'h264' | 'prores';
    outputLocation: string;
    inputProps?: Record<string, unknown>;
    proResProfile?: string;
    pixelFormat?: string;
    imageFormat?: 'png' | 'jpeg';
    frameRange?: number | [number, number] | null;
    overwrite?: boolean;
    cancelSignal?: CancelSignal;
    onProgress?: (p: {
      progress: number;
      renderedFrames: number;
      encodedFrames: number;
      stitchStage: string;
    }) => void;
    licenseKey?: string | null;
    isProduction?: boolean;
    logLevel?: string;
  }): Promise<unknown>;
  makeCancelSignal(): { cancelSignal: CancelSignal; cancel: () => void };
  getVideoMetadata(file: string): Promise<{
    width: number;
    height: number;
    fps: number;
    durationInSeconds: number | null;
    audioCodec: string | null;
  }>;
}
interface Bundler {
  bundle(o: {
    entryPoint: string;
    onProgress?: (percent: number) => void;
    outDir?: string | null;
    rootDir?: string | null;
    publicDir?: string | null;
    enableCaching?: boolean;
    ignoreRegisterRootWarning?: boolean;
  }): Promise<string>;
}

export interface Remotion {
  renderer: Renderer;
  bundler: Bundler;
}

const loaded = new Map<string, Remotion>();

/** @remotion/renderer and @remotion/bundler as the project installed them. */
export function loadRemotion(projectDir: string): Remotion {
  const hit = loaded.get(projectDir);
  if (hit) return hit;
  const req = projectRequire(projectDir);
  try {
    const r: Remotion = {
      renderer: req('@remotion/renderer') as Renderer,
      bundler: req('@remotion/bundler') as Bundler,
    };
    loaded.set(projectDir, r);
    return r;
  } catch (e) {
    throw new PluginFailure(
      'E_REMOTION_NOT_INSTALLED',
      `can't load Remotion from ${projectDir}: ${(e as Error).message}`,
      'in the project folder run: npm i',
    );
  }
}

/** Files whose change means a new bundle: everything in src/ and public/ (not node_modules). */
export function sourceFingerprint(projectDir: string): string {
  const h = createHash('sha256');
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || !existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === 'node_modules' || name.startsWith('.') || name.endsWith('.cutpilot-tmp')) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (p === join(projectDir, 'src', 'cutpilot', 'backups')) continue;
        walk(p, depth + 1);
      } else h.update(`${p}\0${st.size}\0${st.mtimeMs}\n`);
    }
  };
  walk(join(projectDir, 'src'), 0);
  walk(join(projectDir, 'public'), 0);
  return h.digest('hex').slice(0, 20);
}

/** This plugin's working folder for a project, in the OS temp folder (bundles, timeline clips). */
export const workDir = (projectDir: string) =>
  join(
    tmpdir(),
    'cutpilot-remotion',
    createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 12),
  );

export interface BundleResult {
  serveUrl: string;
  fingerprint: string;
  /** false when the cached bundle was used */
  rebuilt: boolean;
}

const bundling = new Map<string, Promise<BundleResult>>();

/**
 * The project bundled by Remotion's bundler, rebuilt only when a file in src/ or public/ changed
 * (bundling takes seconds). The bundle and its fingerprint stay on disk, so a restart reuses them.
 */
export function ensureBundle(
  r: Remotion,
  projectDir: string,
  entryPoint: string,
  onProgress: (f: number, m: string) => void = () => {},
): Promise<BundleResult> {
  const fingerprint = sourceFingerprint(projectDir);
  const outDir = join(workDir(projectDir), 'bundle');
  const stamp = join(workDir(projectDir), 'bundle.fingerprint');
  if (
    existsSync(join(outDir, 'index.html')) &&
    existsSync(stamp) &&
    readFileSync(stamp, 'utf8') === fingerprint
  )
    return Promise.resolve({ serveUrl: outDir, fingerprint, rebuilt: false });
  const key = `${projectDir}\0${fingerprint}`;
  const running = bundling.get(key);
  if (running) return running;
  const p = (async () => {
    rmSync(stamp, { force: true });
    mkdirSync(workDir(projectDir), { recursive: true });
    onProgress(0, 'bundling the Remotion project');
    let serveUrl: string;
    try {
      serveUrl = await r.bundler.bundle({
        entryPoint,
        outDir,
        rootDir: projectDir,
        publicDir: join(projectDir, 'public'),
        enableCaching: true,
        onProgress: (pct) => onProgress(pct / 100, `bundling ${Math.round(pct)}%`),
      });
    } catch (e) {
      throw new BundleError((e as Error).message ?? String(e));
    }
    writeFileSync(stamp, fingerprint);
    return { serveUrl, fingerprint, rebuilt: true };
  })().finally(() => bundling.delete(key));
  bundling.set(key, p);
  return p;
}

/** The bundler's own error text, verbatim: the AI reads it to fix its code. */
export class BundleError extends Error {}

/** A Chrome Headless Shell for Remotion: the one it has, or downloaded once (with progress). */
export async function ensureBrowser(
  r: Remotion,
  ctx: Pick<PluginContext, 'progress' | 'log'>,
): Promise<void> {
  const status = await r.renderer.ensureBrowser({
    logLevel: 'error',
    onBrowserDownload: () => {
      ctx.log('downloading Chrome Headless Shell for Remotion (once)');
      return {
        version: null,
        onProgress: ({ percent }) =>
          ctx.progress(
            percent * 0.9,
            `downloading Chrome Headless Shell for Remotion: ${Math.round(percent * 100)}%`,
          ),
      };
    },
  });
  if (status.type === 'no-browser')
    throw new PluginFailure(
      'E_REMOTION_NO_BROWSER',
      'Remotion has no browser to render with and could not download one',
      'check the internet connection, or in the project folder run: npx remotion browser ensure',
    );
}

/** Cancel Remotion's work when CutPilot cancels the call. */
export function cancelOn(
  r: Remotion,
  signal: AbortSignal,
): { cancelSignal: CancelSignal; dispose: () => void } {
  const { cancelSignal, cancel } = r.renderer.makeCancelSignal();
  if (signal.aborted) cancel();
  signal.addEventListener('abort', cancel, { once: true });
  return { cancelSignal, dispose: () => signal.removeEventListener('abort', cancel) };
}

export async function selectScene(
  r: Remotion,
  serveUrl: string,
  compositionId: string,
  inputProps: Record<string, unknown>,
): Promise<VideoConfig> {
  try {
    return await r.renderer.selectComposition({ serveUrl, id: compositionId, inputProps, logLevel: 'error' });
  } catch (e) {
    throw new CompositionError((e as Error).message ?? String(e));
  }
}

/** selectComposition's error (the scene threw while loading, or isn't registered), verbatim. */
export class CompositionError extends Error {}

/** A unique file name in a folder: `<base>.<ext>`, else `<base>-2.<ext>`, … (nothing is overwritten). */
export function uniquePath(dir: string, base: string, ext: string): string {
  for (let i = 1; ; i++) {
    const f = join(dir, `${base}${i === 1 ? '' : `-${i}`}.${ext}`);
    if (!existsSync(f)) return f;
  }
}

/** `2026-10-01T09-30-05` for file names. */
export const fileStamp = (d: Date = new Date()) => d.toISOString().slice(0, 19).replace(/:/g, '-');
