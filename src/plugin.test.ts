import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { definePlugin, PluginDefinitionError, PluginFailure, type PluginDefinition } from './plugin.js';

const manifest = (over: Record<string, unknown> = {}) => ({
  id: 'test-plugin',
  name: 'Test plugin',
  version: '1.0.0',
  description: 'For tests.',
  contract: 1,
  cutpilot: '*',
  command: 'node',
  args: ['index.mjs'],
  kinds: ['transcriber'],
  permissions: { reads: ['audio'], secrets: ['API_KEY'] },
  settings: [
    { key: 'provider', label: 'Provider', type: 'choice', choices: ['a', 'b'], default: 'a' },
    { key: 'sampleFps', label: 'fps', type: 'number', default: 5 },
  ],
  ...over,
});

const words = [
  { text: 'Hello,', start: 0, end: 300 },
  { text: 'world.', start: 350, end: 700 },
];

let clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
});

async function connect(def: PluginDefinition, env: NodeJS.ProcessEnv = {}) {
  const plugin = definePlugin(def, env);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await plugin.server.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  clients.push(client);
  return client;
}

const problemsOf = (def: PluginDefinition) => {
  try {
    definePlugin(def, {});
    return [];
  } catch (e) {
    expect(e).toBeInstanceOf(PluginDefinitionError);
    return (e as PluginDefinitionError).problems;
  }
};

describe('definePlugin checks the definition against the manifest', () => {
  test('a kind without its handler, a handler without its kind, a bad extra tool name', () => {
    expect(problemsOf({ manifest: manifest() })).toEqual(['kind transcriber needs a transcribe handler']);
    expect(problemsOf({ manifest: manifest({ kinds: [] }), findMusic: () => ({ tracks: [] }) })).toEqual([
      'findMusic is defined, but the manifest doesn\'t list its kind in "kinds"',
    ]);
    expect(
      problemsOf({
        manifest: manifest({ kinds: [] }),
        tools: { suggestTitles: { description: 'd', input: {}, handler: () => '' } },
      }),
    ).toEqual([expect.stringMatching(/snake_case/)]);
  });

  test('a bad manifest is reported field by field', () => {
    expect(problemsOf({ manifest: manifest({ version: 'one' }) })).toEqual([
      expect.stringMatching(/^cutpilot-plugin\.json: version: versions are semver/),
    ]);
  });
});

describe('contract tools', () => {
  test('a valid answer comes back as structured content', async () => {
    const c = await connect({ manifest: manifest(), transcribe: () => ({ language: 'en', words }) });
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(['transcribe']);
    const r = await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ language: 'en', words });
  });

  test('a bad answer is refused, naming the field', async () => {
    const c = await connect({
      manifest: manifest(),
      transcribe: () => ({ language: 'en', words: [{ text: 'x', start: 500, end: 100 }] }),
    });
    const r = await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      error: {
        code: 'E_PLUGIN_CONTRACT',
        message: 'transcribe returned words.0.end: a word ends at or after its start',
        fix: 'the plugin must return what the transcriber contract says (see @cutpilot/plugin-api)',
      },
    });
  });

  test('input the contract refuses never reaches the handler', async () => {
    let called = false;
    const c = await connect({
      manifest: manifest({ kinds: ['analyzer:reframe-track'], permissions: { reads: ['source'] } }),
      reframeTrack: () => {
        called = true;
        return { keyframes: [{ t: 0, x: 0.5, y: 0.5 }] };
      },
    });
    const r = await c.callTool({
      name: 'reframe_track',
      arguments: { source: '/v.mp4', aspect: '9:16', ranges: [{ start: 5, end: 5 }] },
    });
    // refused by MCP's own input validation (the schema is the contract's), naming the field
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      { type: 'text', text: expect.stringContaining('a range ends after it starts at ranges[0]') },
    ]);
    expect(called).toBe(false);
  });

  test('PluginFailure keeps its code and fix; other errors become E_PLUGIN_FAILED, one line each', async () => {
    const c = await connect({
      manifest: manifest(),
      transcribe: (i) => {
        if (i.language === 'uz')
          throw new PluginFailure('E_BAD_KEY', 'the key was refused', 'enter a new key');
        throw new Error('socket hang up\n    at somewhere');
      },
    });
    const a = await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'uz' } });
    expect(a.structuredContent).toEqual({
      error: { code: 'E_BAD_KEY', message: 'the key was refused', fix: 'enter a new key' },
    });
    expect(a.content).toEqual([
      { type: 'text', text: 'E_BAD_KEY: the key was refused\nfix: enter a new key' },
    ]);
    const b = await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } });
    expect((b.structuredContent as { error: { code: string; message: string } }).error).toMatchObject({
      code: 'E_PLUGIN_FAILED',
      message: 'socket hang up',
    });
  });
});

describe('context', () => {
  test('settings from the environment (typed) or their defaults; only declared secrets', async () => {
    let seen: unknown;
    const c = await connect(
      {
        manifest: manifest(),
        transcribe: (_i, ctx) => {
          seen = { settings: ctx.settings, key: ctx.secret('API_KEY'), other: ctx.secret('HOME') };
          return { language: 'en', words: [] };
        },
      },
      { CUTPILOT_SETTING_SAMPLE_FPS: '8', CUTPILOT_SECRET_API_KEY: 'k-123', CUTPILOT_SECRET_HOME: 'nope' },
    );
    await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } });
    expect(seen).toEqual({ settings: { provider: 'a', sampleFps: 8 }, key: 'k-123', other: undefined });
  });

  test('requireSecret tells the user where to enter it', async () => {
    const c = await connect({
      manifest: manifest(),
      transcribe: (_i, ctx) => {
        ctx.requireSecret('API_KEY');
        return { language: 'en', words: [] };
      },
    });
    const r = await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } });
    expect(r.structuredContent).toEqual({
      error: {
        code: 'E_PLUGIN_NEEDS_SECRET',
        message: "API_KEY hasn't been entered",
        fix: 'enter it in CutPilot → Plugins → Test plugin',
      },
    });
  });

  test('progress reaches the caller', async () => {
    const c = await connect({
      manifest: manifest(),
      transcribe: (_i, ctx) => {
        ctx.progress(0.25, 'uploading');
        ctx.progress(2);
        return { language: 'en', words: [] };
      },
    });
    const seen: unknown[] = [];
    await c.callTool({ name: 'transcribe', arguments: { audio: '/a.wav', language: 'en' } }, undefined, {
      onprogress: (p) => seen.push(p),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toEqual([
      { progress: 25, total: 100, message: 'uploading' },
      { progress: 100, total: 100 },
    ]);
  });

  test('extra tools return text or structured data', async () => {
    const c = await connect({
      manifest: manifest({ kinds: [] }),
      tools: {
        greet: {
          description: 'Greet.',
          input: { name: z.string() },
          handler: ({ name }) => `Hello, ${name}!`,
        },
        stats: { description: 'Stats.', input: {}, handler: () => ({ words: 2 }) },
      },
    });
    expect(await c.callTool({ name: 'greet', arguments: { name: 'Abdul' } })).toMatchObject({
      content: [{ type: 'text', text: 'Hello, Abdul!' }],
    });
    expect((await c.callTool({ name: 'stats', arguments: {} })).structuredContent).toEqual({ words: 2 });
  });
});
