/**
 * The tools through MCP (in memory) with a fake audio.cpp, setup against a local server, the
 * plugin as CutPilot starts it (needs `pnpm build`), and, with CUTPILOT_SOUND_E2E set to a data
 * folder that has the runtime and models, real sounds.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, testPlugin } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import {
  MODELS,
  RUNTIME_VERSION,
  RUNTIMES,
  SPEECH_LANGUAGES,
  VOICES,
  type Model,
  type Runtime,
} from './catalog.js';
import { definition, layout, makeDefinition } from './plugin.js';
import { threadCount } from './runner.js';
import { wavInfo } from './wav.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'cp-sound-'));
const key = `${process.platform}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli';

const clients: Client[] = [];
const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A wav file: `seconds` of silence, 24 kHz mono 16-bit. */
function wav(seconds: number, rate = 24000, channels = 1): Buffer {
  const frames = Math.round(rate * seconds);
  const b = Buffer.alloc(44 + frames * 2 * channels);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + frames * 2 * channels, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2 * channels, 28);
  b.writeUInt16LE(2 * channels, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(frames * 2 * channels, 40);
  return b;
}

/**
 * A stand-in for audiocpp_cli: writes a wav at --out (its length from --duration-seconds, or 1 s),
 * echoes its arguments to stderr, fails when the text says so.
 */
const FAKE_CLI = `#!${process.execPath}
const fs = require('node:fs');
const a = process.argv.slice(2);
const arg = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
console.error('args ' + JSON.stringify(a));
if ((arg('--text') || '').includes('explode')) { console.error('planner masked decode found no valid token'); process.exit(3); }
const s = Number(arg('--duration-seconds') || 1);
const rate = arg('--task') === 'tts' ? 24000 : 44100, ch = arg('--task') === 'tts' ? 1 : 2;
const frames = Math.round(rate * s);
const b = Buffer.alloc(44 + frames * 2 * ch);
b.write('RIFF', 0); b.writeUInt32LE(36 + frames * 2 * ch, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
b.writeUInt16LE(1, 20); b.writeUInt16LE(ch, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2 * ch, 28);
b.writeUInt16LE(2 * ch, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(frames * 2 * ch, 40);
fs.writeFileSync(arg('--out'), b);
fs.writeFileSync(arg('--out') + '.args', JSON.stringify(a));
console.log('metrics.audio_duration_ms=' + s * 1000);
`;

/** A data folder with the fake runtime and the given jobs' "models" marked as installed. */
function dataDir(name: string, jobs: string[]): string {
  const dir = join(tmp, name);
  const exe = join(dir, 'runtime', RUNTIME_VERSION, exeName);
  mkdirSync(join(dir, 'runtime', RUNTIME_VERSION), { recursive: true });
  writeFileSync(exe, FAKE_CLI);
  chmodSync(exe, 0o755);
  for (const m of MODELS)
    if (jobs.includes(m.job)) {
      mkdirSync(join(dir, 'models', m.id), { recursive: true });
      writeFileSync(join(dir, 'models', m.id, m.file), 'gguf');
      writeFileSync(join(dir, 'models', m.id, `${m.file}.sha256`), `${m.sha256}\n`);
    }
  return dir;
}

async function connect(def = definition, env: NodeJS.ProcessEnv = {}) {
  const plugin = definePlugin({ ...def, manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
type Result = Awaited<ReturnType<Client['callTool']>>;
const structured = <T>(r: Result) => r.structuredContent as T;
const errorOf = (r: Result) => structured<{ error: { code: string; message: string; fix: string } }>(r).error;
interface Sound {
  file: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  license: string;
  attribution?: string;
  model: string;
}

describe.skipIf(!RUNTIMES[key])('tools, with a fake audio.cpp', () => {
  test('an asset:sound with doctor, setup and remove; voices and languages', async () => {
    const c = await connect();
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual([
      'doctor',
      'generate_sound',
      'list_voices',
      'remove',
      'setup',
    ]);
    const all = structured<{ voices: { id: string }[]; languages: string[] }>(
      await c.callTool({ name: 'list_voices', arguments: {} }),
    );
    expect(all.voices.map((v) => v.id)).toEqual(VOICES.map((v) => v.id));
    expect(all.languages).toEqual(SPEECH_LANGUAGES);
    expect(all.languages).toContain('ru');
    expect(
      structured<{ voices: unknown[] }>(
        await c.callTool({ name: 'list_voices', arguments: { language: 'uz' } }),
      ).voices,
    ).toEqual([]);
    expect(
      structured<{ voices: unknown[] }>(
        await c.callTool({ name: 'list_voices', arguments: { language: 'pt-br' } }),
      ).voices,
    ).toHaveLength(10);
  });

  test('nothing downloaded: doctor says so, generate_sound says how to set up', async () => {
    const dir = join(tmp, 'empty');
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dir });
    const d = structured<{
      dataDir: string;
      supported: boolean;
      runtime: { installed: boolean; license: string };
      models: { job: string; installed: boolean; sizeMb: number; license: string; attribution?: string }[];
    }>(await c.callTool({ name: 'doctor', arguments: {} }));
    expect(d.dataDir).toBe(dir);
    expect(d.supported).toBe(true);
    expect(d.runtime).toMatchObject({ installed: false, license: 'Apache-2.0' });
    expect(d.models.map((m) => [m.job, m.installed])).toEqual([
      ['sfx', false],
      ['music', false],
      ['speech', false],
    ]);
    expect(d.models[0]).toMatchObject({
      sizeMb: 1684,
      license: 'Stability AI Community License',
      attribution: 'Powered by Stability AI',
    });
    const e = errorOf(
      await c.callTool({ name: 'generate_sound', arguments: { kind: 'speech', text: 'Hi' } }),
    );
    expect(e.code).toBe('E_SOUND_NOT_SET_UP');
    expect(e.message).toMatch(/audio\.cpp .* isn't downloaded yet, so no speech/);
    expect(e.fix).toMatch(/sound__doctor.*sound__setup\(\{ what: "speech", agree: true \}\)/);
    const s = errorOf(await c.callTool({ name: 'setup', arguments: { what: 'speech', agree: false } }));
    expect(s.code).toBe('E_SOUND_LICENSE');
  });

  test('the runtime but not the model: the model is what is missing', async () => {
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dataDir('rt-only', []) });
    const e = errorOf(
      await c.callTool({ name: 'generate_sound', arguments: { kind: 'sfx', prompt: 'rain' } }),
    );
    expect(e.code).toBe('E_SOUND_NOT_SET_UP');
    expect(e.message).toBe(
      "Stable Audio 3 Small SFX (the sfx model) isn't downloaded yet, so no sfx can be made",
    );
  });

  test('speech: the CLI gets the language, voice and text; the wav comes back with its facts; cached by seed', async () => {
    const dir = dataDir('speech', ['speech']);
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dir, CUTPILOT_SETTING_THREADS: '3' });
    const r = await c.callTool({
      name: 'generate_sound',
      arguments: { kind: 'speech', text: ' Привет, мир. ', language: 'ru', voice: 'M2', seed: 5 },
    });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const s = structured<Sound>(r);
    expect(s).toMatchObject({
      durationMs: 1000,
      sampleRate: 24000,
      channels: 1,
      license: 'BigScience OpenRAIL-M',
      model: 'Supertonic 3',
    });
    expect(s.attribution).toBeUndefined();
    expect(s.file.startsWith(join(dir, 'cache'))).toBe(true);
    expect(existsSync(s.file)).toBe(true);
    const args = JSON.parse(readFileSync(`${s.file}.args`, 'utf8')) as string[];
    const arg = (k: string) => args[args.indexOf(k) + 1];
    expect([arg('--task'), arg('--family'), arg('--language'), arg('--voice-id'), arg('--text')]).toEqual([
      'tts',
      'supertonic',
      'ru',
      'M2',
      'Привет, мир.',
    ]);
    expect([arg('--threads'), arg('--seed'), arg('--backend')]).toEqual([
      '3',
      '5',
      process.platform === 'darwin' ? 'best' : 'cpu',
    ]);
    expect(arg('--model')).toBe(join(dir, 'models', 'supertonic-3', 'supertonic-3-orig.gguf'));
    // the same request again: the same file, no second run (the fake would have overwritten it)
    writeFileSync(s.file, wav(2));
    const again = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'speech', text: 'Привет, мир.', language: 'ru', voice: 'M2', seed: 5 },
      }),
    );
    expect(again.file).toBe(s.file);
    expect(again.durationMs).toBe(2000);
    // another seed is another file
    const other = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'speech', text: 'Привет, мир.', language: 'ru', voice: 'M2', seed: 6 },
      }),
    );
    expect(other.file).not.toBe(s.file);
  });

  test('effects and music: the length goes to the CLI; stereo 44.1 kHz; the Stability credit', async () => {
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dataDir('sfx', ['sfx', 'music']) });
    const s = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'sfx', prompt: 'a door creaks', durationMs: 2500, seed: 1 },
      }),
    );
    expect(s).toMatchObject({
      durationMs: 2500,
      sampleRate: 44100,
      channels: 2,
      attribution: 'Powered by Stability AI',
      model: 'Stable Audio 3 Small SFX',
    });
    const m = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'music', prompt: 'calm piano', seed: 1 },
      }),
    );
    expect(m).toMatchObject({ durationMs: 30_000, model: 'Stable Audio 3 Small Music' });
  });

  test('bad input is refused with a fix: language, voice, length', async () => {
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dataDir('bad', ['sfx', 'speech']) });
    const call = (a: Record<string, unknown>) =>
      c.callTool({ name: 'generate_sound', arguments: a }).then(errorOf);
    expect(await call({ kind: 'speech', text: 'Salom', language: 'uz' })).toMatchObject({
      code: 'E_SOUND_LANGUAGE',
      fix: expect.stringMatching(/use one of en, ko/),
    });
    expect(await call({ kind: 'speech', text: 'Hi', voice: 'Z9' })).toMatchObject({
      code: 'E_PLUGIN_BAD_INPUT',
      fix: expect.stringMatching(/F1, F2/),
    });
    expect(await call({ kind: 'sfx', prompt: 'x', durationMs: 500 })).toMatchObject({
      code: 'E_PLUGIN_BAD_INPUT',
      message: 'sfx is 1–120 s long, not 0.5 s',
    });
    // the contract refuses what it can before the handler
    expect(
      (await c.callTool({ name: 'generate_sound', arguments: { kind: 'sfx', text: 'no prompt' } })).isError,
    ).toBe(true);
  });

  test("a failed run: the CLI's last lines, and nothing left in the cache", async () => {
    const dir = dataDir('fail', ['speech']);
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dir });
    const e = errorOf(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'speech', text: 'explode now', seed: 1 },
      }),
    );
    expect(e.code).toBe('E_SOUND_FAILED');
    expect(e.message).toMatch(/Supertonic 3 failed \(exit 3\): .*no valid token/);
    expect(readdirSync(join(dir, 'cache'))).toEqual([]);
  });

  test('remove: one model, then everything', async () => {
    const dir = dataDir('rm', ['sfx', 'speech']);
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: dir });
    const one = structured<{ removed: string[]; models: { job: string; installed: boolean }[] }>(
      await c.callTool({ name: 'remove', arguments: { what: 'sfx' } }),
    );
    expect(one.removed).toEqual(['Stable Audio 3 Small SFX']);
    expect(one.models.map((m) => m.installed)).toEqual([false, false, true]);
    const all = structured<{ removed: string[]; runtime: { installed: boolean } }>(
      await c.callTool({ name: 'remove', arguments: { what: 'all' } }),
    );
    expect(all.removed).toEqual(['everything']);
    expect(all.runtime.installed).toBe(false);
    expect(existsSync(dir)).toBe(false);
  });
});

describe.skipIf(!RUNTIMES[key] || process.platform === 'win32')('setup, against a local server', () => {
  /** A tar.gz with the fake CLI inside, served with a fake model; both pinned by their real hashes. */
  async function serve(): Promise<{ runtimes: Record<string, Runtime>; models: Model[]; hits: string[] }> {
    const src = join(tmp, 'serve');
    mkdirSync(join(src, 'pkg'), { recursive: true });
    writeFileSync(join(src, 'pkg', exeName), FAKE_CLI);
    execFileSync('tar', ['-czf', join(src, 'rt.tar.gz'), '-C', join(src, 'pkg'), exeName]);
    const archive = readFileSync(join(src, 'rt.tar.gz'));
    const model = Buffer.from('a very small gguf');
    const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === '/moved') return void res.writeHead(302, { location: '/rt.tar.gz' }).end();
      const body =
        req.url === '/rt.tar.gz'
          ? archive
          : req.url === '/model.gguf'
            ? model
            : req.url === '/short.gguf'
              ? model.subarray(0, 5)
              : null;
      if (!body) return void res.writeHead(404).end();
      res.writeHead(200, { 'content-length': body.length }).end(body);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const rt = RUNTIMES[key]!;
    return {
      hits,
      runtimes: {
        [key]: { ...rt, url: `${base}/moved`, sha256: sha(archive), size: archive.length, archive: 'tar.gz' },
      },
      models: MODELS.map((m) => ({
        ...m,
        url:
          m.job === 'music'
            ? `${base}/short.gguf`
            : m.job === 'sfx'
              ? `${base}/model.gguf`
              : `${base}/model.gguf`,
        sha256: m.job === 'speech' ? 'ab'.repeat(32) : sha(model),
        size: model.length,
      })),
    };
  }

  test('downloads the runtime (following a redirect) and a model, marks them, and then makes sound; refuses a wrong hash or size', async () => {
    const { runtimes, models, hits } = await serve();
    const dir = join(tmp, 'setup');
    const c = await connect(makeDefinition({ runtimes, models }), { CUTPILOT_SETTING_DATA_DIR: dir });
    const progress: string[] = [];
    const r = await c.callTool({ name: 'setup', arguments: { what: 'sfx', agree: true } }, undefined, {
      onprogress: (p) => progress.push(p.message ?? ''),
    });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const s = structured<{
      downloaded: string[];
      runtime: { installed: boolean };
      models: { job: string; installed: boolean }[];
    }>(r);
    expect(s.downloaded).toEqual([`audio.cpp ${RUNTIME_VERSION}`, 'Stable Audio 3 Small SFX']);
    expect(s.runtime.installed).toBe(true);
    expect(s.models.map((m) => m.installed)).toEqual([true, false, false]);
    expect(hits).toEqual(['/moved', '/rt.tar.gz', '/model.gguf']);
    expect(progress.some((m) => /downloading audio\.cpp/.test(m))).toBe(true);
    expect(existsSync(join(dir, 'runtime', RUNTIME_VERSION, exeName))).toBe(true);
    expect(existsSync(join(dir, 'runtime', `audiocpp-${RUNTIME_VERSION}.tar.gz`))).toBe(false); // the archive is gone
    const made = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'sfx', prompt: 'wind', durationMs: 1000, seed: 2 },
      }),
    );
    expect(made.durationMs).toBe(1000);
    // again: nothing to download
    expect(
      structured<{ downloaded: string[] }>(
        await c.callTool({ name: 'setup', arguments: { what: 'sfx', agree: true } }),
      ).downloaded,
    ).toEqual([]);

    const wrongHash = errorOf(
      await c.callTool({ name: 'setup', arguments: { what: 'speech', agree: true } }),
    );
    expect(wrongHash.code).toBe('E_SOUND_DOWNLOAD');
    expect(wrongHash.message).toMatch(/Supertonic 3: SHA-256 .* expected abababab/);
    const short = errorOf(await c.callTool({ name: 'setup', arguments: { what: 'music', agree: true } }));
    expect(short.message).toMatch(/5 bytes, the publisher lists 17/);
    expect(existsSync(join(dir, 'models', 'supertonic-3', 'supertonic-3-orig.gguf.part'))).toBe(false);
    expect(
      structured<{ models: { installed: boolean }[] }>(
        await c.callTool({ name: 'doctor', arguments: {} }),
      ).models.map((m) => m.installed),
    ).toEqual([true, false, false]);
  });
});

test('wav header: PCM facts, odd chunk sizes, not a wav', () => {
  const f = join(tmp, 'h.wav');
  writeFileSync(f, wav(1.5, 48000, 2));
  expect(wavInfo(f)).toEqual({ sampleRate: 48000, channels: 2, durationMs: 1500 });
  // a LIST chunk of odd length before the data (padded to even)
  const b = wav(0.25);
  const list = Buffer.alloc(8 + 3 + 1);
  list.write('LIST', 0);
  list.writeUInt32LE(3, 4);
  writeFileSync(f, Buffer.concat([b.subarray(0, 36), list, b.subarray(36)]));
  expect(wavInfo(f)).toEqual({ sampleRate: 24000, channels: 1, durationMs: 250 });
  writeFileSync(f, 'not audio at all, really not');
  expect(() => wavInfo(f)).toThrow(/not a wav/);
});

test('threads: half the cores within 2..8, or the setting; the data folder defaults to ~/.cutpilot/sound', () => {
  expect(threadCount(0)).toBeGreaterThanOrEqual(2);
  expect(threadCount(0)).toBeLessThanOrEqual(8);
  expect(threadCount(6)).toBe(6);
  expect(layout('').dir).toMatch(/[\\/]\.cutpilot[\\/]sound$/);
  expect(layout(' /x/y ').dir).toBe('/x/y');
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as CutPilot starts it', () => {
  test('testPlugin: starts, offers the contract tools, lists voices; no sound without a data folder', async () => {
    const r = await testPlugin(DIR, { settings: { dataDir: join(tmp, 'harness') } });
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => `${c.name}: ${c.result}`)).toEqual(
      expect.arrayContaining([
        'list_voices answers per contract: pass',
        'generate_sound answers per contract: skip',
      ]),
    );
  });
});

const E2E = process.env.CUTPILOT_SOUND_E2E;
describe.skipIf(!E2E)('real sounds (CUTPILOT_SOUND_E2E=<data folder with the runtime and models>)', () => {
  test('speech in Russian and a sound effect, with their facts', async () => {
    const c = await connect(definition, { CUTPILOT_SETTING_DATA_DIR: E2E });
    const s = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'speech', text: 'Добро пожаловать.', language: 'ru', voice: 'F2', seed: 1 },
      }),
    );
    expect(s.durationMs).toBeGreaterThan(500);
    expect(s).toMatchObject({ sampleRate: 44100, channels: 1, model: 'Supertonic 3' });
    const fx = structured<Sound>(
      await c.callTool({
        name: 'generate_sound',
        arguments: { kind: 'sfx', prompt: 'a wooden door creaks open', durationMs: 2000, seed: 1 },
      }),
    );
    expect(fx).toMatchObject({
      durationMs: 2000,
      sampleRate: 44100,
      channels: 2,
      attribution: 'Powered by Stability AI',
    });
  }, 120_000);
});
