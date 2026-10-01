/**
 * definePlugin(): one call turns handlers into a CutPilot plugin — an MCP server on stdio that
 * offers its kinds' contract tools, checks what goes in and out against `@cutpilot/plugin-api`,
 * and reports errors the way CutPilot does (a code, a one-line message, a one-line fix).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import {
  extraToolProblem,
  KIND_TOOLS,
  MANIFEST_FILE,
  parseManifest,
  secretEnv,
  settingEnv,
  type FindMusicInputSchema,
  type FindMusicOutputSchema,
  type GenerateInputSchema,
  type GenerateOutputSchema,
  type GenerateSoundInputSchema,
  type GenerateSoundOutputSchema,
  type GetMusicInputSchema,
  type GetMusicOutputSchema,
  type ListTemplatesInputSchema,
  type ListTemplatesOutputSchema,
  type ListVoicesInputSchema,
  type ListVoicesOutputSchema,
  type Manifest,
  type PluginKind,
  type ReframeTrackInputSchema,
  type ReframeTrackOutputSchema,
  type ToolContract,
  type TranscribeInputSchema,
  type TranscribeOutputSchema,
} from '@cutpilot/plugin-api';
import type { z } from 'zod';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Throw this from a handler for an error the user or their AI can act on. */
export class PluginFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

export interface PluginContext {
  readonly manifest: Manifest;
  /** the manifest's settings, as the user set them (or their defaults) */
  readonly settings: Readonly<Record<string, string | number | boolean | undefined>>;
  /** a declared secret, or undefined when the user hasn't entered it */
  secret(name: string): string | undefined;
  /** a declared secret, or a PluginFailure telling the user where to enter it */
  requireSecret(name: string): string;
  /** report progress, 0..1 */
  progress(fraction: number, message?: string): void;
  /** aborted when CutPilot cancels the call */
  readonly signal: AbortSignal;
  /** a line in CutPilot's log for this plugin (stderr; stdout belongs to MCP) */
  log(message: string): void;
}

type Handler<I extends z.ZodType, O extends z.ZodType> = (
  input: z.infer<I>,
  ctx: PluginContext,
) => Promise<z.input<O>> | z.input<O>;

export interface ExtraTool<S extends z.ZodRawShape = z.ZodRawShape> {
  description: string;
  input: S;
  /** return a string (shown as text) or an object (structured, and as JSON text) */
  handler: (args: z.infer<z.ZodObject<S>>, ctx: PluginContext) => Promise<unknown> | unknown;
}

export interface PluginDefinition {
  /** default: `cutpilot-plugin.json` in the working directory (CutPilot starts plugins in their folder) */
  manifest?: unknown;
  /** kind `transcriber` */
  transcribe?: Handler<typeof TranscribeInputSchema, typeof TranscribeOutputSchema>;
  /** kind `analyzer:reframe-track` */
  reframeTrack?: Handler<typeof ReframeTrackInputSchema, typeof ReframeTrackOutputSchema>;
  /** kind `asset:music` */
  findMusic?: Handler<typeof FindMusicInputSchema, typeof FindMusicOutputSchema>;
  getMusic?: Handler<typeof GetMusicInputSchema, typeof GetMusicOutputSchema>;
  /** kind `generator` */
  listTemplates?: Handler<typeof ListTemplatesInputSchema, typeof ListTemplatesOutputSchema>;
  generate?: Handler<typeof GenerateInputSchema, typeof GenerateOutputSchema>;
  /** kind `asset:sound` */
  listVoices?: Handler<typeof ListVoicesInputSchema, typeof ListVoicesOutputSchema>;
  generateSound?: Handler<typeof GenerateSoundInputSchema, typeof GenerateSoundOutputSchema>;
  /** free-form read-only tools; AI clients see them as `<plugin id>__<name>` */
  tools?: Record<string, ExtraTool>;
}

/** contract tool name → the handler that implements it */
const HANDLER_FOR: Record<string, keyof PluginDefinition> = {
  transcribe: 'transcribe',
  reframe_track: 'reframeTrack',
  find_music: 'findMusic',
  get_music: 'getMusic',
  list_templates: 'listTemplates',
  generate: 'generate',
  list_voices: 'listVoices',
  generate_sound: 'generateSound',
};

export class PluginDefinitionError extends Error {
  constructor(readonly problems: string[]) {
    super(`this plugin can't start:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

export interface Plugin {
  readonly manifest: Manifest;
  readonly server: McpServer;
  /** serve on stdin/stdout (what CutPilot expects) */
  start(): Promise<void>;
}

const firstLine = (s: string) => s.split(/\r?\n/)[0]!.trim() || 'failed';
const issueText = (e: z.ZodError) =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

function failure(code: string, message: string, fix: string): CallToolResult {
  const error = { code, message: firstLine(message), fix: firstLine(fix) };
  return {
    isError: true,
    content: [{ type: 'text', text: `${error.code}: ${error.message}\nfix: ${error.fix}` }],
    structuredContent: { error },
  };
}

function success(out: unknown): CallToolResult {
  if (typeof out === 'string') return { content: [{ type: 'text', text: out }] };
  const text = JSON.stringify(out ?? null);
  return out && typeof out === 'object' && !Array.isArray(out)
    ? { content: [{ type: 'text', text }], structuredContent: out as Record<string, unknown> }
    : { content: [{ type: 'text', text }] };
}

function readSettings(
  m: Manifest,
  env: NodeJS.ProcessEnv,
): Record<string, string | number | boolean | undefined> {
  const out: Record<string, string | number | boolean | undefined> = {};
  for (const s of m.settings) {
    const raw = env[settingEnv(s.key)];
    if (raw === undefined) out[s.key] = s.default;
    else if (s.type === 'number') out[s.key] = Number.isFinite(Number(raw)) ? Number(raw) : s.default;
    else if (s.type === 'boolean') out[s.key] = raw === 'true' || raw === '1';
    else out[s.key] = raw;
  }
  return out;
}

/** Check a definition against its manifest; build the MCP server without starting it. */
export function definePlugin(def: PluginDefinition, env: NodeJS.ProcessEnv = process.env): Plugin {
  let json = def.manifest;
  if (json === undefined) {
    const file = join(process.cwd(), MANIFEST_FILE);
    try {
      json = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new PluginDefinitionError([`can't read ${file}: ${(e as Error).message}`]);
    }
  }
  const parsed = parseManifest(json);
  if (!parsed.ok) throw new PluginDefinitionError(parsed.problems.map((p) => `${MANIFEST_FILE}: ${p}`));
  const manifest = parsed.manifest;

  const problems: string[] = [];
  const declared = new Set<string>();
  for (const kind of manifest.kinds)
    for (const tool of Object.keys(KIND_TOOLS[kind])) {
      declared.add(tool);
      if (!def[HANDLER_FOR[tool]!]) problems.push(`kind ${kind} needs a ${HANDLER_FOR[tool]} handler`);
    }
  for (const [tool, key] of Object.entries(HANDLER_FOR))
    if (def[key] && !declared.has(tool))
      problems.push(`${key} is defined, but the manifest doesn't list its kind in "kinds"`);
  for (const name of Object.keys(def.tools ?? {})) {
    const p = extraToolProblem(manifest.id, name);
    if (p) problems.push(p);
  }
  if (problems.length) throw new PluginDefinitionError(problems);

  const settings = Object.freeze(readSettings(manifest, env));
  const log = (message: string) => void process.stderr.write(`[${manifest.id}] ${message}\n`);
  const context = (extra: Extra): PluginContext => {
    const token = extra._meta?.progressToken;
    return {
      manifest,
      settings,
      signal: extra.signal,
      log,
      secret: (name) =>
        manifest.permissions.secrets.includes(name) ? env[secretEnv(name)] || undefined : undefined,
      requireSecret(name) {
        const v = this.secret(name);
        if (v) return v;
        throw new PluginFailure(
          'E_PLUGIN_NEEDS_SECRET',
          `${name} hasn't been entered`,
          `enter it in CutPilot → Plugins → ${manifest.name}`,
        );
      },
      progress(fraction, message) {
        if (token === undefined) return;
        void extra
          .sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: token,
              progress: Math.round(Math.max(0, Math.min(1, fraction)) * 100),
              total: 100,
              ...(message ? { message } : {}),
            },
          })
          .catch(() => {});
      },
    };
  };

  const server = new McpServer({ name: manifest.id, version: manifest.version, title: manifest.name });
  const run = async (fn: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PluginFailure) return failure(e.code, e.message, e.fix);
      log(`error: ${(e as Error)?.stack ?? String(e)}`);
      return failure(
        'E_PLUGIN_FAILED',
        (e as Error)?.message ?? String(e),
        `if it keeps failing, report it to the publisher of ${manifest.name}`,
      );
    }
  };

  for (const kind of manifest.kinds as PluginKind[])
    for (const [tool, contract] of Object.entries(KIND_TOOLS[kind]) as [string, ToolContract][]) {
      const handler = def[HANDLER_FOR[tool]!] as (input: unknown, ctx: PluginContext) => unknown;
      const input = contract.input as z.ZodObject;
      server.registerTool(
        tool,
        { description: contract.description, inputSchema: input.shape, annotations: { readOnlyHint: true } },
        ((args: unknown, extra: Extra) =>
          run(async () => {
            const a = input.safeParse(args);
            if (!a.success)
              return failure(
                'E_PLUGIN_BAD_INPUT',
                `${tool}: ${issueText(a.error)}`,
                "CutPilot sent an input this plugin can't use; update CutPilot or the plugin",
              );
            const out = await handler(a.data, context(extra));
            const o = contract.output.safeParse(out);
            if (!o.success)
              return failure(
                'E_PLUGIN_CONTRACT',
                `${tool} returned ${issueText(o.error)}`,
                `the plugin must return what the ${kind} contract says (see @cutpilot/plugin-api)`,
              );
            return success(o.data);
          })) as never,
      );
    }

  for (const [name, t] of Object.entries(def.tools ?? {}))
    server.registerTool(
      name,
      { description: t.description, inputSchema: t.input, annotations: { readOnlyHint: true } },
      ((args: never, extra: Extra) =>
        run(async () => success(await t.handler(args, context(extra))))) as never,
    );

  return {
    manifest,
    server,
    start: async () => {
      await server.connect(new StdioServerTransport());
      // CutPilot closes stdin when it stops the plugin, or when it goes away: don't outlive it
      process.stdin.once('end', () => process.exit(0));
    },
  };
}
