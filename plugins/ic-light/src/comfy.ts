import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { PluginFailure, type PluginContext } from '@nodcut/plugin-sdk';
import { workflow, type WorkflowInput } from './workflow.js';

export interface NodeInfo {
  input?: { required?: Record<string, unknown[]> };
}
export type ObjectInfo = Record<string, NodeInfo>;

/** Media only goes to a loopback server. Do not follow a server's redirects elsewhere. */
export function localUrl(value: unknown): URL {
  try {
    const url = new URL(typeof value === 'string' && value.trim() ? value.trim() : 'http://localhost:8188');
    if (
      url.protocol !== 'http:' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('local URL');
    return url;
  } catch {
    throw new PluginFailure(
      'E_PLUGIN_BAD_INPUT',
      'ComfyUI URL must be a local HTTP address',
      'set ComfyUI URL to http://localhost:8188, or the loopback port used by ComfyUI Desktop',
    );
  }
}

export class Comfy {
  constructor(
    readonly url: URL,
    private readonly transport: typeof fetch = fetch,
    private readonly pollMs = 1000,
  ) {}

  async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    const deadline = AbortSignal.timeout(15_000);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const r = await this.transport(new URL(path, this.url), {
        ...init,
        redirect: 'error',
        signal: requestSignal,
      });
      if (!r.ok) {
        const detail = (await r.text()).replace(/[\r\n]+/g, ' ').slice(0, 800);
        throw new PluginFailure(
          'E_PLUGIN_FAILED',
          `ComfyUI ${path}: HTTP ${r.status} ${detail}`,
          'check ComfyUI for a failed node, confirm IC-Light SD1.5 models and native nodes are installed, then run ic-light__doctor',
        );
      }
      return r;
    } catch (e) {
      signal?.throwIfAborted();
      if (e instanceof PluginFailure) throw e;
      throw new PluginFailure(
        'E_PLUGIN_FAILED',
        'the local ComfyUI server did not answer',
        `start ComfyUI at ${this.url.origin}, set its port in the plugin, then run ic-light__doctor`,
      );
    }
  }

  async info(signal: AbortSignal): Promise<{ nodes: ObjectInfo; stats: Record<string, unknown> }> {
    const [nodes, stats] = await Promise.all([
      this.request('/object_info', {}, signal).then((r) => r.json()),
      this.request('/system_stats', {}, signal).then((r) => r.json()),
    ]);
    return { nodes: nodes as ObjectInfo, stats: stats as Record<string, unknown> };
  }

  /** Current ComfyUI cancels one job atomically. Old servers can only safely dequeue it. */
  private async cancel(id: string, ctx: PluginContext): Promise<void> {
    try {
      const r = await this.transport(new URL(`/api/jobs/${encodeURIComponent(id)}/cancel`, this.url), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return;
      if (r.status !== 404 && r.status !== 405) throw new Error(`HTTP ${r.status}`);
      await this.request('/queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ delete: [id] }),
      });
      ctx.log(
        'ComfyUI lacks per-job cancellation; the queued job was removed, but an already running frame may finish. Upgrade ComfyUI for targeted cancellation.',
      );
    } catch {
      ctx.log(`Could not cancel ComfyUI job ${id}; check its queue. No global interrupt was sent.`);
    }
  }

  async render(
    png: Uint8Array,
    a: Omit<WorkflowInput, 'image'>,
    ctx: PluginContext,
    timeoutMs: number,
    beat: () => void,
  ): Promise<Uint8Array> {
    ctx.signal.throwIfAborted();
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), `${randomUUID()}.png`);
    form.append('subfolder', 'nodcut-ic-light');
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const uploaded = (await (
      await this.request('/upload/image', { method: 'POST', body: form }, ctx.signal)
    ).json()) as { name: string; subfolder?: string };
    if (
      !uploaded.name ||
      uploaded.name.includes('..') ||
      uploaded.name.includes('/') ||
      uploaded.name.includes('\\')
    )
      throw new PluginFailure(
        'E_PLUGIN_CONTRACT',
        'ComfyUI returned an invalid upload filename',
        'check the local ComfyUI server and run ic-light__doctor',
      );
    const graph = workflow({ ...a, image: [uploaded.subfolder, uploaded.name].filter(Boolean).join('/') });
    // Do not abort this short POST midway: receive its id so cancellation can target our own job.
    const queued = (await (
      await this.request('/prompt', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: randomUUID() }),
      })
    ).json()) as { prompt_id?: string };
    if (!queued.prompt_id)
      throw new PluginFailure(
        'E_PLUGIN_CONTRACT',
        'ComfyUI returned no prompt id',
        'check ComfyUI for node validation errors',
      );
    const id = queued.prompt_id;
    const end = Date.now() + timeoutMs;
    try {
      for (;;) {
        ctx.signal.throwIfAborted();
        if (Date.now() > end)
          throw new PluginFailure(
            'E_PLUGIN_TIMEOUT',
            'the relighting frame exceeded its time limit',
            'try fewer steps or a smaller maxSide, or raise Frame timeout seconds in the plugin settings',
          );
        beat();
        const history = (await (
          await this.request(`/history/${encodeURIComponent(id)}`, {}, ctx.signal)
        ).json()) as Record<
          string,
          {
            status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
            outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
          }
        >;
        const entry = history[id];
        if (entry?.status?.status_str === 'error')
          throw new PluginFailure(
            'E_PLUGIN_FAILED',
            `ComfyUI failed to relight the frame: ${JSON.stringify(entry.status.messages ?? [])
              .replace(/[\r\n]+/g, ' ')
              .slice(0, 700)}`,
            'check ComfyUI for the failed node; confirm the checkpoint is SD1.5 and the IC-Light model is the converted foreground (fc) model',
          );
        const image = entry?.outputs?.['11']?.images?.[0];
        if (image) {
          const query = new URLSearchParams({
            filename: image.filename,
            subfolder: image.subfolder ?? '',
            type: image.type ?? 'output',
          });
          const bytes = new Uint8Array(
            await (await this.request(`/view?${query}`, {}, ctx.signal)).arrayBuffer(),
          );
          if (bytes.length < 8 || Buffer.from(bytes.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a')
            throw new PluginFailure(
              'E_PLUGIN_CONTRACT',
              'ComfyUI did not return a PNG',
              'use the native IC-Light workflow with the standard SaveImage node',
            );
          return bytes;
        }
        if (entry?.status?.completed)
          throw new PluginFailure(
            'E_PLUGIN_CONTRACT',
            'ComfyUI completed without the relit image',
            'check the SaveImage node in ComfyUI',
          );
        await sleep(this.pollMs, undefined, { signal: ctx.signal });
      }
    } catch (e) {
      await this.cancel(id, ctx);
      throw e;
    }
  }
}

export function choices(nodes: ObjectInfo, type: string, input: string): string[] {
  const value = nodes[type]?.input?.required?.[input]?.[0];
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}
