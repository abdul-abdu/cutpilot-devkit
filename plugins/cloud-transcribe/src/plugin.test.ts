/**
 * The tool through MCP (in memory) against a recorded ElevenLabs answer, so no network in CI;
 * the plugin as CutPilot starts it (needs `pnpm build`); and a live run that needs a key:
 *
 *   CUTPILOT_LIVE_ELEVENLABS_KEY=… CUTPILOT_LIVE_AUDIO=talk_en.wav pnpm vitest run plugins/cloud-transcribe
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  definePlugin,
  formatReport,
  KIND_TOOLS,
  secretEnv,
  silentWav,
  testPlugin,
} from '@cutpilot/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { SCRIBE_URL } from './elevenlabs.js';
import { cloudTranscribe, SECRET, type Options } from './plugin.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'cutpilot-plugin.json'), 'utf8'));
const RECORDED = readFileSync(join(DIR, 'fixtures/scribe-en.json'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'cp-cloud-transcribe-'));
const wav = silentWav(join(tmp, 'audio.wav'), 2000);

const clients: Client[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  rmSync(tmp, { recursive: true, force: true });
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  form: FormData;
}

/** A fetch that answers like ElevenLabs did, and keeps what it was sent. */
function recorded(status = 200, body = RECORDED) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, form: init.body as FormData });
    return new Response(body, { status, headers: { 'request-id': 'req_1' } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

async function connect(opts: Options, env: NodeJS.ProcessEnv = { [secretEnv(SECRET)]: 'sk_test' }) {
  const plugin = definePlugin({ ...cloudTranscribe(opts), manifest }, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}
type Result = Awaited<ReturnType<Client['callTool']>>;
const errorOf = (r: Result) =>
  (r.structuredContent as { error: { code: string; message: string; fix: string } }).error;
const transcribe = (c: Client, args: Record<string, unknown> = {}) =>
  c.callTool({ name: 'transcribe', arguments: { audio: wav, language: 'auto', ...args } });

describe('transcribe', () => {
  test('uploads the wav with the key and answers with the recorded transcript', async () => {
    const r = recorded();
    const c = await connect({ fetch: r.fetch });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['transcribe']);
    const res = await transcribe(c, { language: 'en', prompt: 'CutPilot, Abdul' });
    expect(res.isError).toBeFalsy();
    const out = KIND_TOOLS.transcriber.transcribe.output.parse(res.structuredContent);
    expect(out.language).toBe('en');
    expect(out.words).toHaveLength(15);
    expect(out.words.filter((w) => w.event).map((w) => w.text)).toEqual(['(laughter)']);

    const [s] = r.sent;
    expect(s!.url).toBe(SCRIBE_URL);
    expect(s!.headers['xi-api-key']).toBe('sk_test');
    expect(s!.form.get('model_id')).toBe('scribe_v2');
    expect(s!.form.get('language_code')).toBe('en');
    expect(s!.form.getAll('keyterms')).toEqual(['CutPilot', 'Abdul']);
    expect((s!.form.get('file') as File).size).toBe(readFileSync(wav).length);
  });

  test('settings: another model, and no key terms', async () => {
    const r = recorded();
    const c = await connect(
      { fetch: r.fetch },
      {
        [secretEnv(SECRET)]: 'sk_test',
        CUTPILOT_SETTING_MODEL: 'scribe_v1',
        CUTPILOT_SETTING_KEYTERMS: 'false',
      },
    );
    await transcribe(c, { prompt: 'CutPilot' });
    expect(r.sent[0]!.form.get('model_id')).toBe('scribe_v1');
    expect(r.sent[0]!.form.has('keyterms')).toBe(false);
    expect(r.sent[0]!.form.has('language_code')).toBe(false);
  });

  test('without a key it asks for one and sends nothing', async () => {
    const r = recorded();
    const c = await connect({ fetch: r.fetch }, {});
    expect(errorOf(await transcribe(c))).toEqual({
      code: 'E_PLUGIN_NEEDS_SECRET',
      message: "ELEVENLABS_API_KEY hasn't been entered",
      fix: 'enter it in CutPilot → Plugins → Cloud Transcribe',
    });
    expect(r.sent).toHaveLength(0);
  });

  test('a refused key, a network failure, a missing file and an odd answer each say what to do', async () => {
    const bad = await connect(
      recorded(401, JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } })),
    );
    expect(errorOf(await transcribe(bad))).toMatchObject({
      code: 'E_CLOUD_TRANSCRIBE_BAD_KEY',
      fix: 'check ELEVENLABS_API_KEY in CutPilot → Plugins → Cloud Transcribe; the key needs speech-to-text access',
    });

    const offline = await connect({
      fetch: (async () => {
        throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
      }) as typeof fetch,
    });
    expect(errorOf(await transcribe(offline))).toMatchObject({
      code: 'E_CLOUD_TRANSCRIBE_NETWORK',
      message: "can't reach api.elevenlabs.io: ENOTFOUND",
    });

    const r = recorded();
    const c = await connect(r);
    expect(errorOf(await transcribe(c, { audio: join(tmp, 'nope.wav') })).code).toBe('E_PLUGIN_BAD_INPUT');
    expect(r.sent).toHaveLength(0);

    const odd = await connect(recorded(200, '{"transcripts": []}'));
    expect(errorOf(await transcribe(odd)).code).toBe('E_CLOUD_TRANSCRIBE_UNEXPECTED');
  });

  test('cancelling stops the upload', async () => {
    let uploadAborted!: () => void;
    const aborted = new Promise<void>((resolve) => (uploadAborted = resolve));
    const c = await connect({
      fetch: ((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => {
            uploadAborted();
            reject(new DOMException('aborted', 'AbortError'));
          }),
        )) as typeof fetch,
    });
    const ac = new AbortController();
    const call = c.callTool({ name: 'transcribe', arguments: { audio: wav, language: 'auto' } }, undefined, {
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 50);
    await expect(call).rejects.toThrow();
    await aborted;
  });
});

test('over real HTTP: a multipart upload with the key, the fields and the whole wav', async () => {
  let got: { headers: Record<string, unknown>; body: Buffer } | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      got = { headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(200, { 'content-type': 'application/json' }).end(RECORDED);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const c = await connect({ url: `http://127.0.0.1:${port}/v1/speech-to-text` });
    const res = await transcribe(c, { language: 'uz' });
    expect(res.isError).toBeFalsy();
    expect(got!.headers['xi-api-key']).toBe('sk_test');
    expect(String(got!.headers['content-type'])).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Response(new Uint8Array(got!.body), {
      headers: { 'content-type': String(got!.headers['content-type']) },
    }).formData();
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('uz');
    const file = form.get('file') as File;
    expect(file.name).toBe('audio.wav');
    expect(Buffer.from(await file.arrayBuffer()).equals(readFileSync(wav))).toBe(true);
  } finally {
    server.close();
  }
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as CutPilot starts it', () => {
  test('testPlugin: starts, offers transcribe; the call needs a key', async () => {
    const r = await testPlugin(DIR);
    expect(r.ok, formatReport(r)).toBe(true);
    expect(r.checks.map((c) => [c.name, c.result])).toEqual([
      ['manifest', 'pass'],
      ['icon', 'pass'],
      ['starts and answers', 'pass'],
      ['offers transcribe', 'pass'],
      ['transcribe answers per contract', 'skip'],
    ]);
  });
});

const LIVE_KEY = process.env.CUTPILOT_LIVE_ELEVENLABS_KEY;
const LIVE_AUDIO = process.env.CUTPILOT_LIVE_AUDIO;
describe.skipIf(!LIVE_KEY || !LIVE_AUDIO || !existsSync(join(DIR, 'dist/index.js')))(
  'live, with a key',
  () => {
    test('transcribes a real recording', async () => {
      const r = await testPlugin(DIR, {
        secrets: { [SECRET]: LIVE_KEY! },
        fixtures: { audio: LIVE_AUDIO!, language: process.env.CUTPILOT_LIVE_LANGUAGE ?? 'en' },
        timeoutMs: 600_000,
      });
      expect(r.ok, formatReport(r)).toBe(true);
    }, 600_000);
  },
);
