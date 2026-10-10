import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { definePlugin, testPlugin, type PluginContext } from '@nodcut/plugin-sdk';
import { afterAll, describe, expect, test } from 'vitest';
import { Comfy, localUrl, type ObjectInfo } from './comfy.js';
import { executable, probe } from './media.js';
import { makeDefinition } from './plugin.js';
import { REQUIRED_NODES, type Workflow } from './workflow.js';

const DIR = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(DIR, 'nodcut-plugin.json'), 'utf8'));
const ffmpeg = executable('', 'ffmpeg');
const ffprobe = executable('', 'ffprobe');
const tmp = mkdtempSync(join(tmpdir(), 'nodcut-ic-light-test-'));
const clients: Client[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  await rm(tmp, { recursive: true, force: true });
});

const info: ObjectInfo = Object.fromEntries(REQUIRED_NODES.map((n) => [n, { input: { required: {} } }]));
info.CheckpointLoaderSimple.input!.required!.ckpt_name = [['base-sd15.safetensors']];
info.UNETLoader.input!.required!.unet_name = [['iclight_sd15_fc_unet_ldm.safetensors']];

interface Backend {
  url: string;
  prompts: Workflow[];
  cancelled: string[];
  removed: string[];
  mode: 'ok' | 'error' | 'pending' | 'no-image';
  legacy: boolean;
  nodes: ObjectInfo;
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const b of req) chunks.push(Buffer.from(b));
  return Buffer.concat(chunks);
}

function sample(): string {
  const file = join(tmp, 'source.mp4');
  if (!existsSync(file))
    execFileSync(ffmpeg!, [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x48:rate=12',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc='0.1*sin(2*PI*if(lt(t,0.5),440,880)*t)':s=48000",
      '-t',
      '1',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ]);
  return file;
}

async function backend(): Promise<Backend> {
  const b: Backend = {
    url: '',
    prompts: [],
    cancelled: [],
    removed: [],
    mode: 'ok',
    legacy: false,
    nodes: structuredClone(info),
  };
  const uploads = new Map<string, Buffer>();
  const jobs = new Map<string, Buffer>();
  const send = (res: ServerResponse, data: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, 'http://localhost');
      if (url.pathname === '/object_info') return send(res, b.nodes);
      if (url.pathname === '/system_stats')
        return send(res, { system: { comfyui_version: 'test' }, devices: [{ type: 'mps' }] });
      if (url.pathname === '/upload/image') {
        const bytes = await body(req);
        const start = bytes.indexOf(Buffer.from('89504e470d0a1a0a', 'hex'));
        const marker = bytes.indexOf(Buffer.from('IEND'), start);
        const filename = /filename="([^"]+)"/.exec(bytes.toString())![1];
        uploads.set(`nodcut-ic-light/${filename}`, bytes.subarray(start, marker + 8));
        return send(res, { name: filename, subfolder: 'nodcut-ic-light', type: 'input' });
      }
      if (url.pathname === '/prompt') {
        const data = JSON.parse((await body(req)).toString()) as { prompt: Workflow };
        b.prompts.push(data.prompt);
        // The fixture checks the real API node names and the source-conditioning edge.
        if (
          data.prompt['6'].class_type !== 'ICLightAppply' ||
          JSON.stringify(data.prompt['6'].inputs.c_concat) !== '["5",0]'
        )
          return send(res, { error: 'invalid IC-Light conditioning' }, 400);
        const id = randomUUID();
        jobs.set(id, uploads.get(String(data.prompt['3'].inputs.image))!);
        return send(res, { prompt_id: id });
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').pop()!;
        if (b.mode === 'pending') return send(res, {});
        if (b.mode === 'error')
          return send(res, {
            [id]: {
              status: {
                status_str: 'error',
                messages: [['execution_error', { exception_message: 'MPS test failure' }]],
              },
            },
          });
        if (b.mode === 'no-image') return send(res, { [id]: { status: { completed: true }, outputs: {} } });
        return send(res, {
          [id]: {
            status: { completed: true, status_str: 'success' },
            outputs: { '11': { images: [{ filename: `${id}.png`, subfolder: 'relit', type: 'output' }] } },
          },
        });
      }
      if (url.pathname === '/view') {
        const id = url.searchParams.get('filename')!.replace(/\.png$/, '');
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(jobs.get(id));
        return;
      }
      if (url.pathname.startsWith('/api/jobs/')) {
        if (b.legacy) return send(res, {}, 404);
        b.cancelled.push(url.pathname.split('/')[3]);
        return send(res, { cancelled: true });
      }
      if (url.pathname === '/queue') {
        const data = JSON.parse((await body(req)).toString());
        b.removed.push(...data.delete);
        return send(res, {});
      }
      return send(res, { error: 'unknown route' }, 404);
    } catch (e) {
      return send(res, { error: String(e) }, 500);
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  b.url = `http://127.0.0.1:${address.port}`;
  return b;
}

async function connect(b?: Backend, extra: Record<string, string> = {}, transport: typeof fetch = fetch) {
  const env = {
    NODCUT_SETTING_DATA_DIR: join(tmp, randomUUID()),
    NODCUT_SETTING_CHECKPOINT: 'base-sd15.safetensors',
    ...(b ? { NODCUT_SETTING_COMFY_URL: b.url } : {}),
    ...extra,
  };
  const plugin = definePlugin({ ...makeDefinition(transport, 1), manifest }, env);
  const [a, c] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'ic-light-test', version: '1' });
  await client.connect(c);
  clients.push(client);
  return { client, env };
}

const data = (r: Awaited<ReturnType<Client['callTool']>>) => r.structuredContent as Record<string, unknown>;
const setup = (client: Client, agree = true) =>
  client.callTool({
    name: 'setup',
    arguments: { agree, checkpointLicenseUrl: 'https://example.test/base-sd15/LICENSE' },
  });

test('local addresses only, including IPv6; credentials, redirects to external endpoints and non-HTTP addresses are rejected', () => {
  expect(localUrl('http://[::1]:8188').hostname).toBe('[::1]');
  for (const url of [
    'https://localhost:8188',
    'http://example.test:8188',
    'http://localhost.example.test:8188',
    'http://user:secret@localhost:8188',
    'http://localhost:8188/path',
  ])
    expect(() => localUrl(url)).toThrow('local HTTP address');
});

test('doctor offers the right tools and reports an unavailable backend with an actionable fix', async () => {
  const offline = (async () => {
    throw new Error('offline');
  }) as typeof fetch;
  const { client } = await connect(undefined, {}, offline);
  expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual([
    'doctor',
    'preview',
    'render',
    'setup',
  ]);
  const r = data(await client.callTool({ name: 'doctor', arguments: {} }));
  expect(r.ok).toBe(false);
  expect(r.downloads).toEqual([]);
  expect(JSON.stringify(r.problems)).toContain('start ComfyUI');
});

test('no media is sent or jobs queued before the user accepts the selected models’ terms', async () => {
  const b = await backend();
  const { client } = await connect(b);
  const r = await client.callTool({ name: 'preview', arguments: { source: '/unused.mp4' } });
  expect(data(r).error).toMatchObject({ code: 'E_PLUGIN_NOT_APPROVED' });
  expect(data(await setup(client, false)).error).toMatchObject({ code: 'E_PLUGIN_NOT_APPROVED' });
  expect(b.prompts).toEqual([]);
});

test('doctor validates native nodes and installed models; a changed model invalidates acceptance', async () => {
  const b = await backend();
  const { client, env } = await connect(b);
  const d = data(await client.callTool({ name: 'doctor', arguments: {} }));
  expect(d.configured).toBe(!!ffmpeg && !!ffprobe);
  if (ffmpeg && ffprobe) {
    expect(data(await setup(client)).ok).toBe(true);
    const changed = await connect(b, { ...env, NODCUT_SETTING_IC_LIGHT_MODEL: 'other-model.safetensors' });
    const r = await changed.client.callTool({ name: 'preview', arguments: { source: '/unused.mp4' } });
    expect(data(r).error).toMatchObject({ code: 'E_PLUGIN_NOT_APPROVED' });
  }
  delete b.nodes.ICLightAppply;
  expect(JSON.stringify(data(await client.callTool({ name: 'doctor', arguments: {} })).problems)).toContain(
    'ICLightAppply',
  );
});

describe.skipIf(!ffmpeg || !ffprobe)('real media with a protocol-level simulated ComfyUI', () => {
  test('preview returns a PNG image and persistent file, source remains byte-identical', async () => {
    const b = await backend();
    const { client } = await connect(b);
    await setup(client);
    const source = sample();
    const before = readFileSync(source);
    const r = await client.callTool({
      name: 'preview',
      arguments: { source, atMs: 200, prompt: 'soft key light from the left', seed: 11, steps: 4 },
    });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    expect((r.content as { type: string }[]).some((c) => c.type === 'image')).toBe(true);
    const file = data(r).file as string;
    expect((await readFile(file)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(b.prompts[0]['9'].inputs.seed).toBe(11);
    expect(b.prompts[0]['7'].inputs.text).toBe('soft key light from the left');
    expect(readFileSync(source)).toEqual(before);
  });

  test('video processes all range frames with one seed, keeps timing and source audio, cleans scratch frames', async () => {
    const b = await backend();
    const { client } = await connect(b);
    await setup(client);
    const source = sample();
    const before = readFileSync(source);
    const r = await client.callTool({
      name: 'render',
      arguments: { source, startMs: 500, endMs: 1000, seed: 17, steps: 2 },
    });
    expect(r.isError, JSON.stringify(r.structuredContent)).toBeFalsy();
    const result = data(r);
    expect(result.range).toEqual({ startMs: 500, endMs: 1000, durationMs: 500 });
    const actual = await probe(result.file as string, ffprobe!, new AbortController().signal);
    expect(actual.hasAudio).toBe(true);
    expect(actual.durationMs).toBeGreaterThanOrEqual(480);
    expect(actual.durationMs).toBeLessThanOrEqual(600);
    expect(actual.width).toBe(64);
    expect(actual.height).toBe(48);
    expect(actual.fps).toBe(12);
    expect(b.prompts).toHaveLength(6);
    expect(b.prompts.every((p) => p['9'].inputs.seed === 17)).toBe(true);
    expect(await readdir(join(result.file as string, '..'))).toEqual(['provenance.json', 'relit.mp4']);
    expect(readFileSync(source)).toEqual(before);
    // The source changes from 440 Hz to 880 Hz at 500 ms. Check that the selected range has the second tone, rather than audio from the beginning.
    const pcm = execFileSync(ffmpeg!, [
      '-v',
      'error',
      '-i',
      result.file as string,
      '-vn',
      '-f',
      'f32le',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-',
    ]);
    let crossings = 0;
    let energy = 0;
    for (let i = 4; i < pcm.length; i += 4) {
      const v = pcm.readFloatLE(i);
      energy += v * v;
      if (v >= 0 && pcm.readFloatLE(i - 4) < 0) crossings++;
    }
    expect(Math.sqrt(energy / (pcm.length / 4))).toBeGreaterThan(0.02);
    expect(crossings / (pcm.length / 4 / 48000)).toBeGreaterThan(800);
    expect(crossings / (pcm.length / 4 / 48000)).toBeLessThan(940);
  }, 30_000);

  test('pictures can be previewed and silent videos do not acquire generated audio', async () => {
    const b = await backend();
    const { client } = await connect(b);
    await setup(client);
    const picture = join(tmp, 'still.png');
    const silent = join(tmp, 'silent.mp4');
    execFileSync(ffmpeg!, ['-v', 'error', '-i', sample(), '-frames:v', '1', picture]);
    execFileSync(ffmpeg!, ['-v', 'error', '-i', sample(), '-an', '-c:v', 'copy', silent]);
    const p = await client.callTool({ name: 'preview', arguments: { source: picture } });
    expect(p.isError, JSON.stringify(p)).toBeFalsy();
    const r = await client.callTool({ name: 'render', arguments: { source: silent, endMs: 250, steps: 1 } });
    expect(r.isError, JSON.stringify(r)).toBeFalsy();
    const actual = await probe(data(r).file as string, ffprobe!, new AbortController().signal);
    expect(actual.hasAudio).toBe(false);
    expect(actual.durationMs).toBeGreaterThanOrEqual(240);
    expect(actual.durationMs).toBeLessThanOrEqual(340);
  });

  test('bad ranges and backend execution errors return useful failures without keeping partial outputs', async () => {
    const b = await backend();
    const { client, env } = await connect(b);
    await setup(client);
    const bad = await client.callTool({ name: 'render', arguments: { source: sample(), endMs: 1500 } });
    expect(data(bad).error).toMatchObject({ code: 'E_PLUGIN_BAD_INPUT' });
    b.mode = 'error';
    const failed = await client.callTool({ name: 'preview', arguments: { source: sample() } });
    expect(data(failed).error).toMatchObject({ code: 'E_PLUGIN_FAILED' });
    expect(JSON.stringify(data(failed).error)).toContain('MPS test failure');
    expect(b.cancelled).toHaveLength(1);
    expect(await readdir(join(env.NODCUT_SETTING_DATA_DIR, 'outputs'))).toEqual([]);
  });

  test('cancelling a pending call targets only its own job; legacy fallback only removes its queued id', async () => {
    for (const legacy of [false, true]) {
      const b = await backend();
      b.mode = 'pending';
      b.legacy = legacy;
      const abort = new AbortController();
      const png = join(tmp, `cancel-${legacy}.png`);
      execFileSync(ffmpeg!, ['-v', 'error', '-i', sample(), '-frames:v', '1', png]);
      const ctx = { signal: abort.signal, progress: () => {}, log: () => {} } as unknown as PluginContext;
      const promise = new Comfy(localUrl(b.url), fetch, 1).render(
        await readFile(png),
        {
          checkpoint: 'base-sd15.safetensors',
          icLightModel: 'iclight_sd15_fc_unet_ldm.safetensors',
          width: 64,
          height: 48,
          prefix: 'test',
          prompt: 'studio light',
          negativePrompt: '',
          seed: 1,
          steps: 1,
          cfg: 3,
          denoise: 0.6,
        },
        ctx,
        20_000,
        () => {
          abort.abort(new Error('cancelled by user'));
        },
      );
      await expect(promise).rejects.toThrow('cancelled by user');
      expect(legacy ? b.removed.length : b.cancelled.length).toBe(1);
      expect(b.prompts).toHaveLength(1);
    }
  });
});

describe.skipIf(!existsSync(join(DIR, 'dist/index.js')))('as NodCut starts the plugin', () => {
  test('the real stdio process validates and offers all tools with no backend or models needed', async () => {
    const report = await testPlugin(DIR);
    expect(
      report.checks.every((c) => c.result !== 'fail'),
      JSON.stringify(report),
    ).toBe(true);
    expect(report.checks.some((c) => c.name === 'extra tool render')).toBe(true);
  });
});

test('the plugin contains no ComfyUI runtime, native node package or model dependency', () => {
  const p = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
  expect(Object.keys(p.dependencies).sort()).toEqual(['@nodcut/plugin-sdk', 'zod']);
  expect(p.files).not.toContain('models');
  expect(manifest.permissions.network).toEqual(['localhost']);
});
