/**
 * The plugin: a `generator` whose templates are the scenes in the user's linked Remotion project
 * (so add_insert renders one into the edit, like any generator's), and extra tools to write,
 * check, preview and render those scenes. Nothing runs until the user has entered their own
 * Remotion licence key (license.ts); Remotion itself comes from their project (project.ts).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ASPECTS,
  imageBlock,
  PluginFailure,
  ToolContent,
  type ExtraTool,
  type PluginContext,
  type PluginDefinition,
} from '@nodcut/plugin-sdk';
import { z } from 'zod';
import { BEAT_MS, createProject } from './create.js';
import { GUIDE } from './guide.js';
import {
  LICENSE_NOTICE,
  LICENSE_SECRET,
  licenseKey,
  recordAcceptance,
  stateDir,
  type LicenseKind,
} from './license.js';
import { linkedDir, installedVersions, openProject, versionProblem, type Project } from './project.js';
import {
  BundleError,
  cancelOn,
  CompositionError,
  ensureBrowser,
  ensureBundle,
  fileStamp,
  loadRemotion,
  missingFileFailure,
  selectScene,
  uniquePath,
  workDir,
  type BundleResult,
  type Remotion,
  type VideoConfig,
} from './remotion.js';
import { ensureRootPatched, findEntryPoint, type RootPatch } from './root-patch.js';
import {
  checkSceneId,
  codeProblem,
  compositionId,
  deleteScene,
  listScenes,
  propsSchema,
  readScene,
  SceneMetaSchema,
  writeIndex,
  writeScene,
  type Scene,
  type SceneMeta,
} from './scenes.js';
import { typecheckScenes } from './typecheck.js';

const PROFILES = ['4444-xq', '4444', 'hq', 'standard', 'light', 'proxy'] as const;

const Props = z.record(z.string(), z.unknown());
const SceneId = z
  .string()
  .describe(
    'the scene id: lowercase letters, digits and single hyphens, starting with a letter, e.g. "promo-intro"',
  );
const Code = z
  .string()
  .min(1)
  .max(200_000)
  .describe(
    'the whole .tsx file: imports from "remotion"/"react", a typed Props, and `export default` the component. ' +
      'Animate only with useCurrentFrame + interpolate/spring; no CSS animations, timers or Math.random (use random(seed)). ' +
      'Call remotion__guide for the full rules.',
  );
const metaFields = {
  durationInFrames: SceneMetaSchema.shape.durationInFrames.describe(
    'length in frames: seconds × fps, e.g. 300 for 10 s at 30 fps',
  ),
  fps: SceneMetaSchema.shape.fps.describe('frames per second, e.g. 30'),
  width: SceneMetaSchema.shape.width.describe('pixels, even: 1080 for 9:16 (1080x1920), 1920 for 16:9'),
  height: SceneMetaSchema.shape.height.describe('pixels, even: 1920 for 9:16, 1080 for 16:9 and 1:1'),
  defaultProps: Props.describe(
    'the props the scene renders with unless others are passed, JSON only, e.g. { "headline": "Just got safer", "accent": "#C6FF00" }',
  ),
};

export interface Options {
  /** where licence acceptances are recorded (default: the plugin's folder in the user's app data) */
  stateDir?: string;
  /** how often a call waiting for another Remotion job reports progress (default BEAT_MS) */
  beatMs?: number;
}

interface Ready {
  project: Project;
  remotion: Remotion;
  key: string;
  license: LicenseKind;
  entryPoint: string;
  /** the licence notice, the first time this project and Remotion version are used with the key */
  notice?: string;
}

interface LoggedError {
  at: string;
  tool: string;
  code: string;
  message: string;
}

export function createDefinition(opts: Options = {}): PluginDefinition {
  const records = opts.stateDir ?? stateDir();
  const lastErrors: LoggedError[] = [];
  const remember = (tool: string, code: string, message: string) => {
    lastErrors.push({ at: new Date().toISOString(), tool, code, message: message.slice(0, 2000) });
    if (lastErrors.length > 10) lastErrors.shift();
  };

  /**
   * One Remotion job at a time: each starts a Chrome and uses every core. A call waiting for its
   * turn reports progress while it waits: NodCut ends a plugin call after 120 s without any,
   * and a render ahead of it (another chat, the app) can take longer than that.
   */
  let queue: Promise<unknown> = Promise.resolve();
  const beatMs = opts.beatMs ?? BEAT_MS;
  const exclusive = <T>(ctx: Pick<PluginContext, 'progress'>, fn: () => Promise<T>): Promise<T> => {
    const asked = Date.now();
    const beat = setInterval(
      () =>
        ctx.progress(
          0,
          `waiting for another Remotion job to finish (${Math.round((Date.now() - asked) / 1000)} s)`,
        ),
      beatMs,
    );
    const start = () => {
      clearInterval(beat);
      return fn();
    };
    const run = queue.then(start, start);
    queue = run.catch(() => {});
    return run;
  };

  /** The licence (first: nothing runs without it), the project, and the acceptance record. */
  function ready(ctx: PluginContext): Ready {
    const { key, kind } = licenseKey(ctx);
    const project = openProject(ctx.settings.projectDir);
    const entryPoint = findEntryPoint(project.dir);
    if (!entryPoint)
      throw new PluginFailure(
        'E_REMOTION_NO_ENTRY',
        `${project.dir} has no Remotion entry point (src/index.ts calling registerRoot)`,
        'set the project folder to a Remotion project, or add Config.setEntryPoint("…") to its remotion.config.ts',
      );
    const remotion = loadRemotion(project.dir);
    const { isNew } = recordAcceptance(records, {
      projectDir: project.dir,
      remotionVersion: project.version,
      license: kind,
    });
    return {
      project,
      remotion,
      key,
      license: kind,
      entryPoint,
      ...(isNew ? { notice: LICENSE_NOTICE } : {}),
    };
  }

  /**
   * Run a tool, remembering its failure for status. The SDK has checked the arguments against
   * the tool's input shape before this runs, so they can be taken as that shape's type.
   */
  const tracked =
    <A>(tool: string, fn: (args: A, ctx: PluginContext) => Promise<unknown> | unknown) =>
    async (args: Record<string, unknown>, ctx: PluginContext) => {
      try {
        return await fn(args as A, ctx);
      } catch (e) {
        if (e instanceof PluginFailure) remember(tool, e.code, e.message);
        else remember(tool, 'E_PLUGIN_FAILED', (e as Error)?.message ?? String(e));
        throw e;
      }
    };

  /** Bundle (cached) and make sure there's a browser; the serve URL. */
  async function bundled(r: Ready, ctx: PluginContext, span = 0.4): Promise<BundleResult> {
    try {
      const b = await ensureBundle(r.remotion, r.project.dir, r.entryPoint, (f, m) =>
        ctx.progress(f * span, m),
      );
      await ensureBrowser(r.remotion, ctx);
      return b;
    } catch (e) {
      if (e instanceof BundleError)
        throw new PluginFailure(
          'E_REMOTION_BUNDLE_FAILED',
          `bundling the project failed: ${e.message.split('\n').slice(0, 4).join(' | ')}`,
          'fix the scene with remotion__update_scene (its check shows the full error), or the file the error names',
        );
      throw e;
    }
  }

  function sceneOrFail(dir: string, id: string): Scene {
    const s = readScene(dir, checkSceneId(id));
    if (!s)
      throw new PluginFailure(
        'E_REMOTION_NO_SCENE',
        `there is no scene ${JSON.stringify(id)}`,
        `remotion__status lists the scenes; make it with remotion__create_scene`,
      );
    return s;
  }

  async function composition(r: Ready, serveUrl: string, id: string, props: Record<string, unknown>) {
    try {
      return await selectScene(r.remotion, serveUrl, compositionId(id), props);
    } catch (e) {
      const missing = missingFileFailure(r.project.dir, e);
      if (missing) throw missing;
      if (e instanceof CompositionError)
        throw new PluginFailure(
          'E_REMOTION_SCENE_FAILED',
          `scene ${id} failed to load: ${e.message.split('\n').slice(0, 3).join(' | ')}`,
          'fix the scene with remotion__update_scene; its check shows the full error',
        );
      throw e;
    }
  }

  /**
   * The check after a write: TypeScript first (fast, exact), then bundle and selectComposition
   * (what a render does). Errors come back verbatim in the answer, not as a failure: the scene
   * is written either way, and the AI fixes it with update_scene.
   */
  async function check(r: Ready, id: string, file: string, root: RootPatch, ctx: PluginContext) {
    ctx.progress(0.05, 'type-checking the scene');
    const tc = typecheckScenes(r.project.dir, [file, join(r.project.dir, 'src', 'nodcut', 'index.tsx')]);
    const typescript = tc.ran ? (tc.ok ? 'ok' : tc.errors) : 'not checked: the project has no TypeScript';
    if (!tc.ok) {
      remember('check', 'E_REMOTION_TYPECHECK', tc.errors.join('\n'));
      return { ok: false, typescript, bundle: 'not run: fix the TypeScript errors first' };
    }
    if (root.state === 'manual')
      return {
        ok: false,
        typescript,
        bundle: `not run: the scenes aren't registered in the project yet. ${root.instructions}`,
      };
    try {
      const b = await ensureBundle(r.remotion, r.project.dir, r.entryPoint, (f, m) =>
        ctx.progress(0.1 + f * 0.6, m),
      );
      await ensureBrowser(r.remotion, ctx);
      ctx.progress(0.8, 'loading the scene');
      const c = await selectScene(r.remotion, b.serveUrl, compositionId(id), {});
      ctx.progress(1, 'checked');
      return {
        ok: true,
        typescript,
        bundle: 'ok',
        composition: {
          id: c.id,
          width: c.width,
          height: c.height,
          fps: c.fps,
          durationInFrames: c.durationInFrames,
        },
      };
    } catch (e) {
      if (e instanceof BundleError || e instanceof CompositionError) {
        const stage = e instanceof BundleError ? 'bundle' : 'composition';
        remember(
          'check',
          stage === 'bundle' ? 'E_REMOTION_BUNDLE_FAILED' : 'E_REMOTION_SCENE_FAILED',
          e.message,
        );
        return { ok: false, typescript, [stage]: e.message.slice(0, 6000) };
      }
      throw e;
    }
  }

  async function written(r: Ready, id: string, file: string, ctx: PluginContext, created: boolean) {
    const root = ensureRootPatched(r.project.dir);
    const result = await check(r, id, file, root, ctx);
    return {
      scene: id,
      [created ? 'created' : 'updated']: relative(r.project.dir, file),
      path: file,
      compositionId: compositionId(id),
      check: result,
      ...(root.state === 'patched'
        ? {
            rootPatch: {
              file: root.file,
              backup: root.backup,
              diff: root.diff,
              note: 'show the user this one-time change',
            },
          }
        : root.state === 'manual'
          ? {
              rootPatch: {
                file: root.file,
                instructions: root.instructions,
                note: 'ask the user to add these lines',
              },
            }
          : {}),
      ...(r.notice ? { licenseNotice: r.notice, noticeNote: 'show this notice to the user' } : {}),
      next: result.ok
        ? `remotion__preview_frame { id: "${id}", frame } at several frames and look at them; then add_insert { template: "${id}" } or remotion__render`
        : `fix the code with remotion__update_scene { id: "${id}", code }`,
    };
  }

  const create: ExtraTool = {
    description:
      "Write a new Remotion scene into the user's linked Remotion project (src/nodcut/<id>.tsx) and check it: " +
      'TypeScript, then bundling and loading it as Remotion would. Errors come back verbatim in `check`; fix them with remotion__update_scene. ' +
      'Then call remotion__preview_frame at several frames and look at the images before rendering. ' +
      'Read remotion__guide once before your first scene. Takes a few seconds (the first bundle up to a minute).',
    input: { id: SceneId, code: Code, ...metaFields, defaultProps: metaFields.defaultProps.optional() },
    handler: tracked('create_scene', (a: Record<string, unknown>, ctx) =>
      exclusive(ctx, async () => {
        const r = ready(ctx);
        const id = checkSceneId(a.id);
        if (readScene(r.project.dir, id) || existsSync(join(r.project.dir, 'src', 'nodcut', `${id}.tsx`)))
          throw new PluginFailure(
            'E_REMOTION_SCENE_EXISTS',
            `scene ${id} already exists`,
            `change it with remotion__update_scene { id: "${id}" }, or pick another id`,
          );
        const code = String(a.code);
        const problem = codeProblem(code);
        if (problem) throw new PluginFailure('E_PLUGIN_BAD_INPUT', problem, 'send the scene file as `code`');
        const meta = SceneMetaSchema.parse({ ...a, defaultProps: a.defaultProps ?? {} });
        const file = writeScene(r.project.dir, id, code, meta);
        return written(r, id, file, ctx, true);
      }),
    ),
  };

  const update: ExtraTool = {
    description:
      'Change a scene made with remotion__create_scene: new code, length, fps, size or default props (pass only what changes). ' +
      'Checks it again like create_scene; errors come back verbatim in `check`.',
    input: {
      id: SceneId,
      code: Code.optional(),
      durationInFrames: metaFields.durationInFrames.optional(),
      fps: metaFields.fps.optional(),
      width: metaFields.width.optional(),
      height: metaFields.height.optional(),
      defaultProps: metaFields.defaultProps.optional(),
    },
    handler: tracked('update_scene', (a: Record<string, unknown>, ctx) =>
      exclusive(ctx, async () => {
        const r = ready(ctx);
        const s = sceneOrFail(r.project.dir, String(a.id));
        const code = a.code === undefined ? s.code : String(a.code);
        const problem = codeProblem(code);
        if (problem) throw new PluginFailure('E_PLUGIN_BAD_INPUT', problem, 'send the scene file as `code`');
        const pick = <K extends keyof SceneMeta>(k: K) => (a[k] === undefined ? s.meta[k] : a[k]);
        const meta = SceneMetaSchema.parse({
          durationInFrames: pick('durationInFrames'),
          fps: pick('fps'),
          width: pick('width'),
          height: pick('height'),
          defaultProps: pick('defaultProps'),
        });
        const file = writeScene(r.project.dir, s.id, code, meta);
        return written(r, s.id, file, ctx, false);
      }),
    ),
  };

  const remove: ExtraTool = {
    description:
      'Delete a scene made with remotion__create_scene (its file in src/nodcut) and take it out of the registered compositions. ' +
      "Clips already added to the edit with add_insert stay; the user's other files are never touched.",
    input: { id: SceneId },
    handler: tracked('delete_scene', (a: { id: string }, ctx) => {
      licenseKey(ctx);
      const dir = linkedDir(ctx.settings.projectDir);
      const id = checkSceneId(a.id);
      if (!deleteScene(dir, id))
        throw new PluginFailure(
          'E_REMOTION_NO_SCENE',
          `there is no scene ${JSON.stringify(id)}`,
          'remotion__status lists the scenes',
        );
      return { ok: true, deleted: id };
    }),
  };

  const preview: ExtraTool = {
    description:
      'Render ONE frame of a scene as a PNG image you can look at, with the frame and its time. Check several frames: ' +
      'the first, the middle of each animation, the last; look for cut-off or overlapping text, contrast and margins, then fix with remotion__update_scene. ' +
      'A preview is a development render (not counted as a render by Remotion). The first call after a change bundles the project (seconds).',
    input: {
      id: SceneId,
      frame: z
        .number()
        .int()
        .min(0)
        .describe('the frame to show, 0-based: 0 is the first, durationInFrames - 1 the last'),
      props: Props.optional().describe(
        'props to render with instead of the defaults (merged over defaultProps)',
      ),
      scale: z
        .number()
        .min(0.1)
        .max(1)
        .optional()
        .describe('image size as a fraction of the scene size; default 0.5 (a 1080x1920 scene → 540x960)'),
    },
    handler: tracked(
      'preview_frame',
      (a: { id: string; frame: number; props?: Record<string, unknown>; scale?: number }, ctx) =>
        exclusive(ctx, async () => {
          const r = ready(ctx);
          const s = sceneOrFail(r.project.dir, a.id);
          const { serveUrl } = await bundled(r, ctx, 0.6);
          const props = { ...s.meta.defaultProps, ...(a.props ?? {}) };
          const c = await composition(r, serveUrl, s.id, props);
          if (a.frame >= c.durationInFrames)
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              `scene ${s.id} has ${c.durationInFrames} frames (0–${c.durationInFrames - 1}); there is no frame ${a.frame}`,
              `pass a frame from 0 to ${c.durationInFrames - 1}`,
            );
          const scale = a.scale ?? 0.5;
          ctx.progress(0.8, `rendering frame ${a.frame}`);
          const cancel = cancelOn(r.remotion, ctx.signal);
          try {
            const { buffer } = await r.remotion.renderer.renderStill({
              composition: c,
              serveUrl,
              frame: a.frame,
              output: null,
              inputProps: props,
              imageFormat: 'png',
              scale,
              cancelSignal: cancel.cancelSignal,
              licenseKey: r.key,
              isProduction: false,
              logLevel: 'error',
            });
            if (!buffer) throw new Error('Remotion returned no image');
            const info = {
              id: s.id,
              frame: a.frame,
              timeMs: Math.round((a.frame / c.fps) * 1000),
              durationInFrames: c.durationInFrames,
              durationMs: Math.round((c.durationInFrames / c.fps) * 1000),
              fps: c.fps,
              width: Math.round(c.width * scale),
              height: Math.round(c.height * scale),
              ...(r.notice ? { licenseNotice: r.notice } : {}),
            };
            ctx.progress(1, 'done');
            return new ToolContent(
              [
                {
                  type: 'text',
                  text:
                    `scene ${s.id}, frame ${a.frame} of ${c.durationInFrames} (${(info.timeMs / 1000).toFixed(2)} s of ${(info.durationMs / 1000).toFixed(2)} s), ` +
                    `${c.width}x${c.height} shown at ${info.width}x${info.height}` +
                    (r.notice ? `\nShow the user this licence notice: ${r.notice}` : ''),
                },
                imageBlock(buffer, 'image/png'),
              ],
              info,
            );
          } catch (e) {
            throw missingFileFailure(r.project.dir, e) ?? e;
          } finally {
            cancel.dispose();
          }
        }),
    ),
  };

  const render: ExtraTool = {
    description:
      'Render a whole scene to a video file in the Remotion project (out/nodcut/, never overwriting) and return its path. ' +
      'To put a scene into the edit, use add_insert { template: "<scene id>", params: { …props } } instead: it renders at the timeline\'s size and places the clip. ' +
      'Use render for a file: an H.264 MP4, or with transparent: true a ProRes 4444 .mov with alpha for overlays in other editors. ' +
      'Long renders report progress and can be cancelled.',
    input: {
      id: SceneId,
      props: Props.optional().describe(
        'props to render with instead of the defaults (merged over defaultProps)',
      ),
      codec: z.enum(['h264', 'prores']).optional().describe('h264 (MP4, default) or prores (.mov)'),
      proresProfile: z
        .enum(PROFILES)
        .optional()
        .describe('ProRes profile; default hq, or 4444 when transparent'),
      transparent: z
        .boolean()
        .optional()
        .describe(
          'keep the background transparent: ProRes 4444 with alpha (the scene must not paint a background)',
        ),
      frameRange: z
        .union([z.number().int().min(0), z.tuple([z.number().int().min(0), z.number().int().min(0)])])
        .optional()
        .describe('only these frames: one frame number, or [first, last] inclusive'),
    },
    handler: tracked(
      'render',
      (
        a: {
          id: string;
          props?: Record<string, unknown>;
          codec?: 'h264' | 'prores';
          proresProfile?: (typeof PROFILES)[number];
          transparent?: boolean;
          frameRange?: number | [number, number];
        },
        ctx,
      ) =>
        exclusive(ctx, async () => {
          if (a.transparent && a.codec === 'h264')
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              "H.264 has no alpha channel, so it can't be transparent",
              'leave out codec (transparent renders are ProRes 4444) or set transparent: false',
            );
          const codec = a.transparent ? 'prores' : (a.codec ?? 'h264');
          const profile = a.transparent
            ? a.proresProfile === '4444-xq'
              ? '4444-xq'
              : '4444'
            : (a.proresProfile ?? 'hq');
          if (a.transparent && a.proresProfile && !a.proresProfile.startsWith('4444'))
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              `ProRes ${a.proresProfile} has no alpha channel`,
              'leave out proresProfile, or use 4444 or 4444-xq',
            );
          const r = ready(ctx);
          const s = sceneOrFail(r.project.dir, a.id);
          const { serveUrl } = await bundled(r, ctx, 0.1);
          const props = { ...s.meta.defaultProps, ...(a.props ?? {}) };
          const c = await composition(r, serveUrl, s.id, props);
          const range = a.frameRange;
          const last = c.durationInFrames - 1;
          if (
            range !== undefined &&
            (typeof range === 'number' ? range > last : range[0] > range[1] || range[1] > last)
          )
            throw new PluginFailure(
              'E_PLUGIN_BAD_INPUT',
              `frameRange ${JSON.stringify(range)} is outside the scene's frames 0–${last}`,
              `pass frames from 0 to ${last}, first ≤ last`,
            );
          const outDir = join(r.project.dir, 'out', 'nodcut');
          mkdirSync(outDir, { recursive: true });
          const file = uniquePath(outDir, `${s.id}-${fileStamp()}`, codec === 'prores' ? 'mov' : 'mp4');
          await renderTo(r, ctx, c, serveUrl, props, file, {
            codec,
            ...(codec === 'prores' ? { proResProfile: profile } : {}),
            ...(a.transparent ? { pixelFormat: 'yuva444p10le', imageFormat: 'png' as const } : {}),
            ...(range !== undefined ? { frameRange: range } : {}),
          });
          const got = await r.remotion.renderer.getVideoMetadata(file);
          return {
            file,
            codec,
            ...(codec === 'prores' ? { proresProfile: profile } : {}),
            transparent: !!a.transparent,
            width: got.width,
            height: got.height,
            fps: c.fps,
            durationMs: Math.round((got.durationInSeconds ?? 0) * 1000),
            bytes: statSync(file).size,
            ...(r.notice ? { licenseNotice: r.notice, noticeNote: 'show this notice to the user' } : {}),
            next: `add_insert { template: "${s.id}", params: ${JSON.stringify(a.props ?? {})} } puts this scene into the edit at the timeline's size`,
          };
        }),
    ),
  };

  async function renderTo(
    r: Ready,
    ctx: PluginContext,
    c: VideoConfig,
    serveUrl: string,
    props: Record<string, unknown>,
    file: string,
    o: {
      codec: 'h264' | 'prores';
      proResProfile?: string;
      pixelFormat?: string;
      imageFormat?: 'png' | 'jpeg';
      frameRange?: number | [number, number];
    },
  ) {
    const partial = `${file}.rendering${o.codec === 'prores' ? '.mov' : '.mp4'}`;
    rmSync(partial, { force: true });
    const cancel = cancelOn(r.remotion, ctx.signal);
    try {
      await r.remotion.renderer.renderMedia({
        composition: c,
        serveUrl,
        codec: o.codec,
        outputLocation: partial,
        inputProps: props,
        imageFormat: o.imageFormat ?? 'jpeg',
        ...(o.proResProfile ? { proResProfile: o.proResProfile } : {}),
        ...(o.pixelFormat ? { pixelFormat: o.pixelFormat } : {}),
        ...(o.frameRange !== undefined ? { frameRange: o.frameRange } : {}),
        overwrite: true,
        cancelSignal: cancel.cancelSignal,
        licenseKey: r.key,
        isProduction: true,
        logLevel: 'error',
        onProgress: (p) =>
          ctx.progress(
            0.1 + p.progress * 0.88,
            `rendering ${c.id}: ${p.renderedFrames}/${c.durationInFrames} frames`,
          ),
      });
    } catch (e) {
      rmSync(partial, { force: true });
      if (ctx.signal.aborted)
        throw new PluginFailure(
          'E_REMOTION_CANCELLED',
          'the render was cancelled',
          'start it again when wanted',
        );
      const missing = missingFileFailure(r.project.dir, e);
      if (missing) throw missing;
      throw new PluginFailure(
        'E_REMOTION_RENDER_FAILED',
        `rendering ${c.id} failed: ${((e as Error).message ?? String(e)).split('\n').slice(0, 3).join(' | ')}`,
        'preview the frames around the failure with remotion__preview_frame and fix the scene; remotion__status shows the full error',
      );
    } finally {
      cancel.dispose();
    }
    renameSync(partial, file);
  }

  const status: ExtraTool = {
    description:
      'Is a Remotion project linked and usable: its folder, the Remotion versions, the licence key state, the scenes ' +
      '(id, size, fps, frames, length, default props) and the last errors. Call this first; it says what to do when something is missing.',
    input: {},
    handler: (_a: unknown, ctx: PluginContext) => {
      const problems: { code: string; message: string; fix: string }[] = [];
      const add = (e: unknown) => {
        if (e instanceof PluginFailure) problems.push({ code: e.code, message: e.message, fix: e.fix });
        else throw e;
      };
      let license: LicenseKind | null = null;
      try {
        license = licenseKey(ctx).kind;
      } catch (e) {
        add(e);
      }
      let dir: string | null = null;
      try {
        dir = linkedDir(ctx.settings.projectDir);
      } catch (e) {
        add(e);
      }
      const versions = dir ? installedVersions(dir) : null;
      if (dir && versions) {
        const p = versionProblem(versions);
        if (p) add(p);
      }
      const scenes = dir
        ? listScenes(dir).map((s) => ({
            id: s.id,
            compositionId: compositionId(s.id),
            width: s.meta.width,
            height: s.meta.height,
            fps: s.meta.fps,
            durationInFrames: s.meta.durationInFrames,
            durationMs: Math.round((s.meta.durationInFrames / s.meta.fps) * 1000),
            defaultProps: s.meta.defaultProps,
          }))
        : [];
      const root =
        dir && existsSync(join(dir, 'package.json')) ? ensureRootPatched(dir, { write: false }) : null;
      return {
        ok: problems.length === 0,
        linked: !!dir,
        projectDir: dir,
        license: license
          ? { entered: true, kind: license }
          : {
              entered: false,
              secret: LICENSE_SECRET,
              enteredBy: 'the user, in NodCut → Plugins → Remotion',
            },
        licenseNotice: LICENSE_NOTICE,
        versions,
        scenes,
        ...(root
          ? {
              root: {
                state: root.state,
                file: root.file,
                ...(root.instructions ? { instructions: root.instructions } : {}),
              },
            }
          : {}),
        problems,
        lastErrors,
        plugin: ctx.manifest.version,
      };
    },
  };

  const guide: ExtraTool = {
    description:
      'How to write a Remotion scene that renders correctly here: the workflow, the determinism rules, assets, props, common sizes, and a minimal example. Read it before your first remotion__create_scene.',
    input: {},
    handler: () => GUIDE,
  };

  const createProjectTool: ExtraTool = {
    description:
      "Make a new, blank Remotion project in a NEW folder the user chose (absolute path), with Remotion's own scaffolder (npx create-video) and npm, " +
      "on the user's machine. Needs Node.js and the internet; takes a minute or two (progress is reported). " +
      'Afterwards the USER sets that folder as "Remotion project folder" in NodCut → Plugins → Remotion. Ask before calling.',
    input: {
      dir: z
        .string()
        .min(2)
        .describe(
          'absolute path of the new folder, e.g. /Users/me/Videos/remotion-scenes; it must not exist or be empty',
        ),
    },
    handler: tracked('create_project', async (a: { dir: string }, ctx) => {
      licenseKey(ctx);
      const made = await createProject(a.dir, ctx);
      writeIndex(made.projectDir);
      const root = ensureRootPatched(made.projectDir);
      return {
        projectDir: made.projectDir,
        remotion: made.version,
        root: { state: root.state, file: root.file },
        licenseNotice: LICENSE_NOTICE,
        next: `ask the user to set "Remotion project folder" to ${made.projectDir} in NodCut → Plugins → Remotion, then call remotion__status`,
        log: made.log,
      };
    }),
  };

  return {
    listTemplates(input, ctx) {
      let dir: string;
      try {
        licenseKey(ctx);
        dir = openProject(ctx.settings.projectDir).dir;
      } catch (e) {
        // not set up: no templates (remotion__status says why), so other generators still list theirs
        ctx.log(`no scenes listed: ${(e as Error).message}`);
        return { templates: [] };
      }
      const templates = listScenes(dir).map((s) => {
        const ms = Math.round((s.meta.durationInFrames / s.meta.fps) * 1000);
        const aspect = aspectOf(s.meta.width, s.meta.height);
        const keys = Object.keys(s.meta.defaultProps);
        return {
          id: s.id,
          name: s.id,
          description:
            `Remotion scene from the user's project, ${s.meta.width}x${s.meta.height}, ${(ms / 1000).toFixed(1)} s at ${s.meta.fps} fps.` +
            (keys.length ? ` Props: ${keys.join(', ')}.` : '') +
            " Rendered at the timeline's size; the scene lays itself out from useVideoConfig().",
          params: propsSchema(s.meta.defaultProps),
          example: s.meta.defaultProps,
          defaultDurationMs: ms,
          minDurationMs: Math.min(ms, Math.max(1, Math.ceil(1000 / s.meta.fps))),
          maxDurationMs: Math.max(ms, 600_000),
          aspects: aspect ? [aspect] : [],
        };
      });
      return {
        templates: input.aspect
          ? templates.filter((t) => !t.aspects.length || t.aspects.includes(input.aspect!))
          : templates,
      };
    },

    generate: (input, ctx) =>
      exclusive(ctx, async () => {
        const r = ready(ctx);
        const s = sceneOrFail(r.project.dir, input.template);
        const props = { ...s.meta.defaultProps, ...input.params };
        const fps = input.fps;
        const durationMs = input.durationMs ?? Math.round((s.meta.durationInFrames / s.meta.fps) * 1000);
        const frames = Math.max(1, Math.round((durationMs / 1000) * fps));
        const { serveUrl, fingerprint } = await bundled(r, ctx, 0.1);
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              ctx.manifest.version,
              r.project.version,
              fingerprint,
              s.id,
              props,
              input.width,
              input.height,
              fps,
              frames,
            ]),
          )
          .digest('hex')
          .slice(0, 16);
        const clips = join(workDir(r.project.dir), 'clips');
        mkdirSync(clips, { recursive: true });
        const file = join(clips, `${s.id}-${key}.mp4`);
        if (!existsSync(file)) {
          const selected = await composition(r, serveUrl, s.id, props);
          // the timeline's canvas, rate and length: the scene is laid out from useVideoConfig()
          const c: VideoConfig = {
            ...selected,
            width: input.width,
            height: input.height,
            fps,
            durationInFrames: frames,
          };
          await renderTo(r, ctx, c, serveUrl, props, file, { codec: 'h264' });
        }
        const got = await r.remotion.renderer.getVideoMetadata(file);
        ctx.progress(1, 'done');
        return {
          file,
          durationMs: Math.max(1, Math.round((got.durationInSeconds ?? frames / fps) * 1000)),
          width: got.width,
          height: got.height,
          hasAudio: !!got.audioCodec,
        };
      }),

    tools: {
      status,
      guide,
      create_project: createProjectTool,
      create_scene: create,
      update_scene: update,
      delete_scene: remove,
      preview_frame: preview,
      render,
    },
  };
}

/** The ASPECTS name of a size, when it is one (1080x1920 → 9:16). */
export function aspectOf(width: number, height: number): (typeof ASPECTS)[number] | null {
  const ratio = width / height;
  for (const a of ASPECTS) {
    const [w, h] = a.split(':').map(Number);
    if (Math.abs(ratio - w! / h!) < 0.01) return a;
  }
  return null;
}

export const definition = createDefinition();
