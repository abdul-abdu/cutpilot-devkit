/**
 * The tools through MCP (in memory) with a fake fetch that plays recorded responses, real HTTP
 * against a local stub, the plugin as CutPilot starts it (needs `pnpm build`), and, with
 * CUTPILOT_LIVE_STT=1 and a key, the real providers.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, formatReport, silentWav, testPlugin } from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { definition, makeDefinition, ORIGIN_ENV, type Options } from './plugin.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(DIR, 'fixtures');
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const ERRORS = fixture('errors.json') as Record<string, { status: number; body: unknown }>;
const tmp = mkdtempSync(join(tmpdir(), 'cp-stt-'));
const wav = silentWav(join(tmp, 'audio.wav'), 500);

const clients: Client[] = [];
const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  for (const s of servers) s.close();
  rmSync(tmp, { recursive: true, force: true });
});

const KEYS = { CUTPILOT_SECRET_ELEVENLABS_API_KEY: 'el-key', CUTPILOT_SECRET_OPENAI_API_KEY: 'oa-key' };

async function connect(o: Options, env: NodeJS.ProcessEnv = KEYS) {
  const plugin = definePlugin({ ...makeDefinition(o), manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}

interface Call {
  url: string;
  init: RequestInit;
}
/** A fetch that answers every request with `status` and `body`, and remembers the calls. */
function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

type Result = Awaited<ReturnType<Client['callTool']>>;
const structured = <T>(r: Result) => {
  expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
  return r.structuredContent as T;
};
const error = (r: Result) => {
  expect(r.isError, JSON.stringify(r.content)).toBe(true);
  return (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
};
const transcribe = (c: Client, args: Record<string, unknown> = {}) =>
  c.callTool({ name: 'transcribe', arguments: { audio: wav, language: 'en', ...args } });

interface Words {
  language: string;
  words: { text: string; start: number; end: number; event?: boolean }[];
}

describe('ElevenLabs', () => {
  test('uploads the wav with the request Scribe expects and maps the answer', async () => {
    const f = fakeFetch(200, fixture('elevenlabs.json'));
    const r = structured<Words>(await transcribe(await connect({ fetch: f.fetch })));
    expect(r.language).toBe('en');
    expect(r.words.map((w) => w.text).join(' ')).toBe(
      'Hello, everyone. (laughs) Welcome back to the channel! Today: "three" quick tips.',
    );
    expect(r.words.find((w) => w.event)).toMatchObject({ text: '(laughs)', start: 1299, end: 2059 });

    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'xi-api-key': 'el-key' });
    const form = init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v1');
    expect(form.get('language_code')).toBe('en');
    expect(form.get('timestamps_granularity')).toBe('word');
    expect(form.get('tag_audio_events')).toBe('true');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(file.size).toBe(readFileSync(wav).length);
  });

  test('language auto sends no language; the language heard comes back as ISO 639-1', async () => {
    const f = fakeFetch(200, { ...fixture('elevenlabs.json'), language_code: 'uzb' });
    const r = structured<Words>(await transcribe(await connect({ fetch: f.fetch }), { language: 'auto' }));
    expect((f.calls[0]!.init.body as FormData).has('language_code')).toBe(false);
    expect(r.language).toBe('uz');
  });

  test.each([
    ['elevenlabs_invalid_key', 'E_STT_BAD_KEY', /ELEVENLABS_API_KEY.*Keys/],
    ['elevenlabs_quota', 'E_STT_QUOTA', /credits/],
    ['elevenlabs_too_large', 'E_STT_FILE_TOO_LARGE', /shorter/],
    ['elevenlabs_bad_language', 'E_STT_PROVIDER', /another provider/],
  ])('%s → %s with a fix', async (name, code, fix) => {
    const { status, body } = ERRORS[name]!;
    const e = error(await transcribe(await connect({ fetch: fakeFetch(status, body).fetch })));
    expect(e.code).toBe(code);
    expect(e.fix).toMatch(fix);
    if (name === 'elevenlabs_bad_language')
      expect(e.message).toMatch(/HTTP 422: Value error, Unsupported language/);
  });

  test('without the key: which secret to enter, where; no request', async () => {
    const f = fakeFetch(200, {});
    const e = error(await transcribe(await connect({ fetch: f.fetch }, {})));
    expect(e).toMatchObject({ code: 'E_PLUGIN_NEEDS_SECRET' });
    expect(e.message).toMatch(/ElevenLabs/);
    expect(e.fix).toMatch(/ELEVENLABS_API_KEY in CutPilot → Plugins → Cloud transcription → Keys/);
    expect(f.calls).toHaveLength(0);
  });
});

describe('OpenAI', () => {
  const env = { ...KEYS, CUTPILOT_SETTING_PROVIDER: 'openai' };

  test('uploads the wav with the request whisper-1 expects and maps the answer', async () => {
    const f = fakeFetch(200, fixture('openai.json'));
    const r = structured<Words>(
      await transcribe(await connect({ fetch: f.fetch }, env), { language: 'ru', prompt: 'CutPilot' }),
    );
    expect(r.language).toBe('en'); // what it heard, not the hint
    expect(r.words.slice(0, 2)).toEqual([
      { text: 'Hello,', start: 0, end: 500 },
      { text: 'everyone.', start: 500, end: 1160 },
    ]);
    const { url, init } = f.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.headers).toEqual({ authorization: 'Bearer oa-key' });
    const form = init.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(form.get('language')).toBe('ru');
    expect(form.get('prompt')).toBe('CutPilot');
  });

  test('a file over 25 MB is refused before uploading, with a fix', async () => {
    const big = join(tmp, 'big.wav');
    writeFileSync(big, '');
    truncateSync(big, 26 * 1024 * 1024);
    const f = fakeFetch(200, {});
    const e = error(await transcribe(await connect({ fetch: f.fetch }, env), { audio: big }));
    expect(e.code).toBe('E_STT_FILE_TOO_LARGE');
    expect(e.fix).toMatch(/ElevenLabs/);
    expect(f.calls).toHaveLength(0);
  });

  test.each([
    ['openai_invalid_key', 'E_STT_BAD_KEY', /OPENAI_API_KEY/],
    ['openai_quota', 'E_STT_QUOTA', /billing/],
    ['openai_rate_limit', 'E_STT_RATE_LIMITED', /wait/],
    ['openai_too_large', 'E_STT_FILE_TOO_LARGE', /25 MB/],
    ['openai_server', 'E_STT_PROVIDER', /on its side/],
  ])('%s → %s with a fix', async (name, code, fix) => {
    const { status, body } = ERRORS[name]!;
    const e = error(await transcribe(await connect({ fetch: fakeFetch(status, body).fetch }, env)));
    expect(e.code).toBe(code);
    expect(e.fix).toMatch(fix);
  });

  test('not JSON is a clear error', async () => {
    const e = error(await transcribe(await connect({ fetch: fakeFetch(200, '<html>').fetch }, env)));
    expect(e.code).toBe('E_STT_BAD_RESPONSE');
  });
});

describe('network', () => {
  test('a fetch that fails says what was unreachable', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof globalThis.fetch;
    const e = error(await transcribe(await connect({ fetch })));
    expect(e.code).toBe('E_STT_NETWORK');
    expect(e.message).toMatch(/api\.elevenlabs\.io \(ENOTFOUND\)/);
    expect(e.fix).toMatch(/internet connection/);
  });

  test('a refused connection with the real fetch', async () => {
    const e = error(await transcribe(await connect({ origin: 'http://127.0.0.1:9' })));
    expect(e.code).toBe('E_STT_NETWORK');
    expect(e.message).toMatch(/127\.0\.0\.1:9/);
  });
});

describe('test_key', () => {
  const check = async (o: Options, env: NodeJS.ProcessEnv, args: Record<string, unknown> = {}) =>
    structured<{ ok: boolean; provider: string; message: string; fix?: string }>(
      await (await connect(o, env)).callTool({ name: 'test_key', arguments: args }),
    );

  test('ElevenLabs: GET /v1/user with the key; OK', async () => {
    const f = fakeFetch(200, { subscription: { tier: 'creator' } });
    expect(await check({ fetch: f.fetch }, KEYS)).toEqual({
      ok: true,
      provider: 'ElevenLabs',
      message: 'ElevenLabs accepted the key',
    });
    expect(f.calls[0]!.url).toBe('https://api.elevenlabs.io/v1/user');
    expect(f.calls[0]!.init.headers).toEqual({ 'xi-api-key': 'el-key' });
  });

  test('a restricted ElevenLabs key that may not read the account is still fine', async () => {
    const { status, body } = ERRORS.elevenlabs_missing_permissions!;
    expect(await check({ fetch: fakeFetch(status, body).fetch }, KEYS)).toMatchObject({ ok: true });
  });

  test('OpenAI (named, or from the settings): GET /v1/models; a bad key says why and what to do', async () => {
    const { status, body } = ERRORS.openai_invalid_key!;
    const f = fakeFetch(status, body);
    const r = await check({ fetch: f.fetch }, KEYS, { provider: 'openai' });
    expect(r).toMatchObject({ ok: false, provider: 'OpenAI' });
    expect(r.message).toMatch(/Incorrect API key/);
    expect(r.fix).toMatch(/OPENAI_API_KEY/);
    expect(f.calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(f.calls[0]!.init.headers).toEqual({ authorization: 'Bearer oa-key' });
  });

  test('no key: not OK, with where to enter it', async () => {
    const r = await check({ fetch: fakeFetch(200, {}).fetch }, { CUTPILOT_SETTING_PROVIDER: 'openai' });
    expect(r).toMatchObject({ ok: false, provider: 'OpenAI' });
    expect(r.fix).toMatch(/Keys/);
  });
});

/** A stand-in for both providers over real HTTP: checks the key and the upload, plays the recordings. */
async function stub(): Promise<{ origin: string; seen: string[] }> {
  const seen: string[] = [];
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString('latin1');
  };
  const server = createServer(async (req, res) => {
    const raw = await body(req);
    seen.push(`${req.method} ${req.url}`);
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(json));
    };
    const multipart = (field: string) =>
      new RegExp(`name="${field.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)`).exec(raw)?.[1];
    if (req.url === '/v1/speech-to-text') {
      if (req.headers['xi-api-key'] !== 'el-key') return send(401, ERRORS.elevenlabs_invalid_key!.body);
      if (multipart('model_id') !== 'scribe_v1' || !raw.includes('RIFF'))
        return send(422, { detail: 'bad upload' });
      return send(200, fixture('elevenlabs.json'));
    }
    if (req.url === '/v1/audio/transcriptions') {
      if (req.headers.authorization !== 'Bearer oa-key') return send(401, ERRORS.openai_invalid_key!.body);
      if (multipart('model') !== 'whisper-1' || !raw.includes('RIFF'))
        return send(400, { error: { message: 'bad upload' } });
      return send(200, fixture('openai.json'));
    }
    send(404, { detail: 'not found' });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { origin: `http://127.0.0.1:${port}`, seen };
}

describe('over HTTP', () => {
  test('both providers against a local stub', async () => {
    const s = await stub();
    const el = structured<Words>(await transcribe(await connect({ origin: s.origin })));
    expect(el.words).toHaveLength(12);
    const oa = structured<Words>(
      await transcribe(await connect({ origin: s.origin }, { ...KEYS, CUTPILOT_SETTING_PROVIDER: 'openai' })),
    );
    expect(oa.words).toHaveLength(15);
    expect(s.seen).toEqual(['POST /v1/speech-to-text', 'POST /v1/audio/transcriptions']);
  });
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as CutPilot starts it', () => {
  test('testPlugin without keys: starts, offers transcribe and test_key; the call is skipped', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers transcribe', 'pass'],
      ['extra tool test_key', 'pass'],
      ['transcribe answers per contract', 'skip'],
    ]);
  });

  /**
   * The harness gives a plugin only its settings and secrets, so to point it at the stub this
   * starts the built plugin from a copy of the folder whose entry sets ORIGIN_ENV first.
   */
  test.each(['elevenlabs', 'openai'])(
    'testPlugin with keys transcribes through %s (stub)',
    async (provider) => {
      const s = await stub();
      const dir = mkdtempSync(join(tmp, 'harness-'));
      writeFileSync(join(dir, 'cutpilot-plugin.json'), JSON.stringify({ ...manifest, args: ['start.mjs'] }));
      copyFileSync(join(DIR, 'icon.png'), join(dir, 'icon.png'));
      writeFileSync(
        join(dir, 'start.mjs'),
        `process.env.${ORIGIN_ENV} = ${JSON.stringify(s.origin)};\nawait import(${JSON.stringify(pathToFileURL(join(DIR, 'dist/index.js')).href)});\n`,
      );
      const r = await testPlugin(dir, {
        settings: { provider },
        secrets: { ELEVENLABS_API_KEY: 'el-key', OPENAI_API_KEY: 'oa-key' },
      });
      expect(r.ok, formatReport(r)).toBe(true);
      expect(r.checks.find((c) => c.name === 'transcribe answers per contract')?.result).toBe('pass');
      expect(s.seen).toHaveLength(1);
    },
  );
});

// ── live ─────────────────────────────────────────────────────────────────────

const LIVE = process.env.CUTPILOT_LIVE_STT === '1';

/** A spoken English sentence as a 16 kHz mono wav: $CUTPILOT_LIVE_STT_AUDIO, or made with say / espeak-ng. */
function speech(): string | null {
  if (process.env.CUTPILOT_LIVE_STT_AUDIO) return process.env.CUTPILOT_LIVE_STT_AUDIO;
  const text = 'Hello everyone, and welcome back to the channel. Today, three quick tips.';
  const raw = join(tmp, process.platform === 'darwin' ? 'speech.aiff' : 'speech-raw.wav');
  const out = join(tmp, 'speech.wav');
  try {
    if (process.platform === 'darwin') execFileSync('say', ['-o', raw, text]);
    else execFileSync('espeak-ng', ['-w', raw, text]);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw, '-ar', '16000', '-ac', '1', out]);
    return out;
  } catch {
    return null;
  }
}

describe.skipIf(!LIVE)('live (CUTPILOT_LIVE_STT=1 and ELEVENLABS_API_KEY or OPENAI_API_KEY)', () => {
  const providers = [
    ['elevenlabs', process.env.ELEVENLABS_API_KEY],
    ['openai', process.env.OPENAI_API_KEY],
  ] as const;
  test.each(providers.filter(([, key]) => key).map(([p]) => p))(
    '%s transcribes real speech',
    async (provider) => {
      const audio = speech();
      if (!audio) throw new Error('no speech: set CUTPILOT_LIVE_STT_AUDIO to a 16 kHz mono wav');
      const env = {
        CUTPILOT_SETTING_PROVIDER: provider,
        CUTPILOT_SECRET_ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
        CUTPILOT_SECRET_OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      };
      const c = await connect({}, env);
      expect(structured<{ ok: boolean }>(await c.callTool({ name: 'test_key', arguments: {} })).ok).toBe(
        true,
      );
      const r = structured<Words>(await transcribe(c, { audio, language: 'auto' }));
      expect(r.language).toBe('en');
      expect(r.words.length).toBeGreaterThan(5);
      expect(r.words.map((w) => w.text.toLowerCase()).join(' ')).toMatch(/welcome/);
      console.log(provider, r.words.map((w) => `${w.text}@${w.start}`).join(' '));
    },
    120_000,
  );
});

// keep `definition` (what index.ts starts) built from the real defaults
test('the default definition uses the real fetch and providers', () => {
  expect(typeof definition.transcribe).toBe('function');
  expect(Object.keys(definition.tools ?? {})).toEqual(['test_key']);
});
