/**
 * The plugin: an `asset:sound` (list_voices, generate_sound) plus doctor, setup and remove.
 * Nothing is bundled: `setup` downloads audio.cpp and the model a job needs into the data
 * folder (`~/.cutpilot/sound`), once the user has agreed to each licence `doctor` shows.
 * generate_sound runs the CLI on one request and returns the wav; the same request with the
 * same seed is answered from the cache.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PluginFailure,
  type ExtraTool,
  type PluginContext,
  type PluginDefinition,
  type SoundKind,
} from '@cutpilot/plugin-sdk';
import { z } from 'zod';
import {
  DEFAULT_VOICE,
  DURATION,
  MODELS,
  modelFor,
  RUNTIME_LICENSE,
  RUNTIMES,
  SPEECH_LANGUAGES,
  VOICES,
  type Job,
  type Model,
  type Runtime,
} from './catalog.js';
import { download, unpack } from './download.js';
import { run, threadCount } from './runner.js';
import { wavInfo } from './wav.js';

export const VERSION = '0.1.0';

export interface Catalog {
  runtimes: Readonly<Record<string, Runtime>>;
  models: readonly Model[];
  fetch?: typeof fetch;
}

const JOBS = ['sfx', 'music', 'speech'] as const;
const SETUP_WHAT = ['runtime', ...JOBS, 'all'] as const;

/** An extra tool with its input typed (ExtraTool's default shape is untyped). */
const tool = <S extends z.ZodRawShape>(t: ExtraTool<S>): ExtraTool => t as unknown as ExtraTool;

/** The data folder's layout. */
export interface Layout {
  dir: string;
  runtime: string;
  models: string;
  cache: string;
}

export function layout(setting: unknown): Layout {
  const dir = resolve(
    typeof setting === 'string' && setting.trim() ? setting.trim() : join(homedir(), '.cutpilot', 'sound'),
  );
  return { dir, runtime: join(dir, 'runtime'), models: join(dir, 'models'), cache: join(dir, 'cache') };
}

/** A download's marker: written after the bytes were checked, read instead of hashing them again. */
const marker = (file: string) => `${file}.sha256`;
const installed = (file: string, sha256: string) =>
  existsSync(file) && existsSync(marker(file)) && readFileSync(marker(file), 'utf8').trim() === sha256;

const platformKey = () => `${process.platform}-${process.arch}`;

export function makeDefinition(c: Catalog): PluginDefinition {
  const runtimeFor = () => {
    const r = c.runtimes[platformKey()];
    if (!r)
      throw new PluginFailure(
        'E_SOUND_UNSUPPORTED',
        `no audio.cpp build for ${platformKey()} yet`,
        `generated sound works on macOS, Windows x64 and Linux x64; on this computer use a cloud sound plugin, or a music file`,
      );
    return r;
  };
  const exePath = (L: Layout, r: Runtime) => join(L.runtime, r.version, r.exe);
  const modelPath = (L: Layout, m: Model) => join(L.models, m.id, m.file);

  const status = (ctx: PluginContext) => {
    const L = layout(ctx.settings.dataDir);
    const r = c.runtimes[platformKey()] ?? null;
    const exe = r ? exePath(L, r) : null;
    return {
      dataDir: L.dir,
      platform: platformKey(),
      supported: !!r,
      runtime: {
        name: 'audio.cpp',
        version: r?.version ?? null,
        installed: !!exe && existsSync(exe),
        sizeMb: r ? Math.round(r.size / 1e6) : null,
        license: RUNTIME_LICENSE.name,
        licenseUrl: RUNTIME_LICENSE.url,
      },
      models: c.models.map((m) => ({
        job: m.job,
        name: m.name,
        installed: installed(modelPath(L, m), m.sha256),
        sizeMb: Math.round(m.size / 1e6),
        license: m.license,
        licenseUrl: m.licenseUrl,
        ...(m.attribution ? { attribution: m.attribution } : {}),
        terms: m.terms,
      })),
    };
  };

  const needSetup = (job: Job, what: string) =>
    new PluginFailure(
      'E_SOUND_NOT_SET_UP',
      `${what} isn't downloaded yet, so no ${job} can be made`,
      `run sound__doctor, tell the user the sizes and licences, and once they agree call sound__setup({ what: "${job}", agree: true })`,
    );

  /** The CLI and the model a job needs, or the error that says how to get them. */
  const ready = (ctx: PluginContext, job: Job) => {
    const L = layout(ctx.settings.dataDir);
    const r = runtimeFor();
    const exe = exePath(L, r);
    if (!existsSync(exe)) throw needSetup(job, 'audio.cpp (the sound runtime)');
    const m = c.models.find((x) => x.job === job)!;
    const model = modelPath(L, m);
    if (!installed(model, m.sha256)) throw needSetup(job, `${m.name} (the ${job} model)`);
    return { L, exe, m, model };
  };

  const backendArg = (ctx: PluginContext) =>
    ctx.settings.backend === 'cpu' || process.platform !== 'darwin' ? 'cpu' : 'best';

  const definition: PluginDefinition = {
    listVoices: ({ language }) => ({
      voices:
        language && !SPEECH_LANGUAGES.includes(language.split('-')[0]!)
          ? []
          : VOICES.map((v) => ({ ...v, languages: [] })),
      languages: [...SPEECH_LANGUAGES],
    }),

    async generateSound(input, ctx) {
      const kind: SoundKind = input.kind;
      const { L, exe, m, model } = ready(ctx, kind);
      const args = ['--task', m.task, '--family', m.family, '--model', model, '--backend', backendArg(ctx)];
      args.push('--threads', String(threadCount(Number(ctx.settings.threads) || 0)), '--metrics');
      const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31);
      args.push('--seed', String(seed));
      let expectedSec: number;
      let durationMs: number | undefined;
      if (kind === 'speech') {
        const text = input.text!.trim();
        const language = (input.language ?? 'en').split('-')[0]!;
        if (!SPEECH_LANGUAGES.includes(language))
          throw new PluginFailure(
            'E_SOUND_LANGUAGE',
            `${m.name} doesn't speak ${language}`,
            `use one of ${SPEECH_LANGUAGES.join(', ')}, or write the text in one of them`,
          );
        const voice = input.voice ?? DEFAULT_VOICE;
        if (!VOICES.some((v) => v.id === voice))
          throw new PluginFailure(
            'E_PLUGIN_BAD_INPUT',
            `there is no voice ${JSON.stringify(voice)}`,
            `use one of ${VOICES.map((v) => v.id).join(', ')} (list_voices describes them)`,
          );
        args.push('--language', language, '--voice-id', voice, '--text', text);
        expectedSec = 2 + text.length / 60;
      } else {
        const d = DURATION[kind];
        durationMs = input.durationMs ?? d.default;
        if (durationMs < d.min || durationMs > d.max)
          throw new PluginFailure(
            'E_PLUGIN_BAD_INPUT',
            `${kind} is ${d.min / 1000}–${d.max / 1000} s long, not ${durationMs / 1000} s`,
            `pass durationMs between ${d.min} and ${d.max}`,
          );
        args.push('--text', input.prompt!.trim(), '--duration-seconds', String(durationMs / 1000));
        expectedSec = 3 + (durationMs / 1000) * (backendArg(ctx) === 'cpu' ? 1.2 : 0.5);
      }
      const key = createHash('sha256')
        .update(JSON.stringify([VERSION, m.id, m.sha256.slice(0, 16), args.slice(6)]))
        .digest('hex')
        .slice(0, 24);
      mkdirSync(L.cache, { recursive: true });
      const out = join(L.cache, `${key}.wav`);
      const answer = () => {
        const info = wavInfo(out);
        return {
          file: out,
          ...info,
          license: m.license,
          ...(m.attribution ? { attribution: m.attribution } : {}),
          model: m.name,
        };
      };
      if (existsSync(out) && statSync(out).size > 44) return answer();
      args.push('--out', out);
      ctx.progress(0.02, `${m.name} is working`);
      const started = Date.now();
      const tick = setInterval(
        () =>
          ctx.progress(Math.min(0.9, (Date.now() - started) / 1000 / expectedSec), `${m.name} is working`),
        1000,
      );
      let r;
      try {
        r = await run(exe, args, ctx.signal);
      } finally {
        clearInterval(tick);
      }
      if (r.code !== 0 || !existsSync(out)) {
        await rm(out, { force: true });
        throw new PluginFailure(
          'E_SOUND_FAILED',
          `${m.name} failed${r.code === null ? '' : ` (exit ${r.code})`}: ${r.tail || 'no output'}`,
          'try a shorter or simpler request; if it keeps failing, sound__remove and sound__setup the job again',
        );
      }
      ctx.progress(1);
      return answer();
    },

    tools: {
      doctor: {
        description:
          "What the Sound plugin has on this computer: the audio.cpp runtime and the models for sound effects, music and speech, with each one's download size, licence and terms. Read it before sound__setup so the user can agree to the licences.",
        input: {},
        handler: (_a, ctx) => status(ctx),
      },
      setup: tool({
        description:
          'Download the sound runtime (audio.cpp, ~30 MB) and the model for a job: sfx (Stable Audio 3 Small SFX, 1.7 GB), music (Stable Audio 3 Small Music, 1.7 GB) or speech (Supertonic 3, 450 MB); all = every model. Only after the user has seen the licences and sizes from sound__doctor and agreed. Takes minutes; progress is reported. Returns what is installed.',
        input: {
          what: z.enum(SETUP_WHAT).describe('runtime, sfx, music, speech or all'),
          agree: z.boolean().describe('true once the user has agreed to the licences sound__doctor lists'),
        },
        handler: async ({ what, agree }, ctx) => {
          if (!agree)
            throw new PluginFailure(
              'E_SOUND_LICENSE',
              'the user has to agree to the licences first',
              'show the user the licences and sizes from sound__doctor, then call sound__setup with agree: true',
            );
          const L = layout(ctx.settings.dataDir);
          const r = runtimeFor();
          const jobs: Job[] = what === 'all' ? [...JOBS] : what === 'runtime' ? [] : [what];
          type Step = {
            what: string;
            d: { url: string; sha256: string; size: number };
            go: () => Promise<void>;
          };
          const steps: Step[] = [];
          let total = 0;
          let before = 0;
          let current: Step | undefined;
          const report = (bytes: number) =>
            ctx.progress(
              total ? (before + bytes) / total : 1,
              `downloading ${current!.what} (${Math.round(bytes / 1e6)} of ${Math.round(current!.d.size / 1e6)} MB)`,
            );
          const exe = exePath(L, r);
          if (!existsSync(exe))
            steps.push({
              what: `audio.cpp ${r.version}`,
              d: r,
              go: async () => {
                const archive = join(L.runtime, `audiocpp-${r.version}.${r.archive}`);
                await download(`audio.cpp ${r.version}`, r, archive, {
                  signal: ctx.signal,
                  fetch: c.fetch,
                  onProgress: (b) => report(b),
                });
                await unpack(archive, join(L.runtime, r.version), r.exe);
                await rm(archive, { force: true });
              },
            });
          for (const job of jobs) {
            const m = c.models.find((x) => x.job === job)!;
            const file = modelPath(L, m);
            if (installed(file, m.sha256)) continue;
            steps.push({
              what: m.name,
              d: m,
              go: async () => {
                await download(m.name, m, file, {
                  signal: ctx.signal,
                  fetch: c.fetch,
                  onProgress: (b) => report(b),
                });
                writeFileSync(marker(file), `${m.sha256}\n`);
              },
            });
          }
          total = steps.reduce((n, s) => n + s.d.size, 0);
          for (const s of steps) {
            current = s;
            ctx.log(`downloading ${s.what} from ${s.d.url}`);
            await s.go();
            before += s.d.size;
          }
          ctx.progress(1);
          return { downloaded: steps.map((s) => s.what), ...status(ctx) };
        },
      }),
      remove: tool({
        description:
          "Delete what sound__setup downloaded: one job's model (sfx, music, speech), the runtime, or all of it with the cache of made sounds. Sounds already placed in projects are unaffected (CutPilot keeps its own copies).",
        input: { what: z.enum(SETUP_WHAT).describe('runtime, sfx, music, speech or all') },
        handler: async ({ what }, ctx) => {
          const L = layout(ctx.settings.dataDir);
          const gone: string[] = [];
          const dropModel = async (m: Model) => {
            if (existsSync(join(L.models, m.id))) {
              await rm(join(L.models, m.id), { recursive: true, force: true });
              gone.push(m.name);
            }
          };
          if (what === 'all') {
            await rm(L.dir, { recursive: true, force: true });
            gone.push('everything');
          } else if (what === 'runtime') {
            await rm(L.runtime, { recursive: true, force: true });
            gone.push('audio.cpp');
          } else await dropModel(modelFor(what));
          return { removed: gone, ...status(ctx) };
        },
      }),
    },
  };
  return definition;
}

export const definition = makeDefinition({ runtimes: RUNTIMES, models: MODELS });
