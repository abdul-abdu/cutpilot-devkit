/** `cutpilot-plugin.json`: what a plugin is, what it needs, and how to start it. */
import { z } from 'zod';
import { parseRange, VERSION_RE } from './version.js';

/** The plugin contract this package describes. The engine refuses other versions. */
export const CONTRACT_VERSION = 1;

export const MANIFEST_FILE = 'cutpilot-plugin.json';

/** kebab-case, at most 40 characters, so `<id>__<tool>` fits MCP's 64 */
export const PluginIdSchema = z
  .string()
  .max(40, 'ids are at most 40 characters')
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'ids are kebab-case, like follow-speaker');

export const PLUGIN_KINDS = ['transcriber', 'analyzer:reframe-track', 'asset:music', 'generator'] as const;
export const PluginKindSchema = z.enum(PLUGIN_KINDS, {
  error: `kinds are ${PLUGIN_KINDS.join(', ')}`,
});
export type PluginKind = z.infer<typeof PluginKindSchema>;

/** What the engine may hand to the plugin: the source video path, the 16 kHz wav, frame images. */
export const PLUGIN_READS = ['source', 'audio', 'frames'] as const;
export const PluginReadSchema = z.enum(PLUGIN_READS, { error: `reads are ${PLUGIN_READS.join(', ')}` });
export type PluginRead = z.infer<typeof PluginReadSchema>;

/** What each kind needs to be given, so a manifest can't forget to ask for it. */
export const KIND_READS: Record<PluginKind, readonly PluginRead[]> = {
  transcriber: ['audio'],
  'analyzer:reframe-track': ['source'],
  'asset:music': [],
  generator: [],
};

const HostSchema = z
  .string()
  .regex(
    /^(localhost|(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i,
    'network entries are host names, like api.example.com or *.example.com',
  );

const SecretNameSchema = z
  .string()
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'secret names look like ELEVENLABS_API_KEY');

export const PermissionsSchema = z
  .object({
    /** hosts the plugin talks to; empty = works offline */
    network: z.array(HostSchema).default([]),
    /** secrets the user enters in CutPilot; passed as CUTPILOT_SECRET_<NAME> */
    secrets: z.array(SecretNameSchema).default([]),
    reads: z.array(PluginReadSchema).default([]),
  })
  .strict();
export type Permissions = z.infer<typeof PermissionsSchema>;

export const SettingSchema = z
  .object({
    /** passed as CUTPILOT_SETTING_<KEY in upper snake case> */
    key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'setting keys are camelCase, like provider'),
    label: z.string().min(1).max(60),
    type: z.enum(['string', 'number', 'boolean', 'choice']),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    choices: z.array(z.string().min(1)).min(2).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    if (s.type === 'choice' && !s.choices)
      ctx.addIssue({ code: 'custom', message: 'a choice setting lists its choices', path: ['choices'] });
    if (s.type !== 'choice' && s.choices)
      ctx.addIssue({ code: 'custom', message: 'only choice settings have choices', path: ['choices'] });
    if (s.default === undefined) return;
    const want = s.type === 'choice' ? 'string' : s.type;
    if (typeof s.default !== want)
      ctx.addIssue({
        code: 'custom',
        message: `the default of a ${s.type} setting is a ${want}`,
        path: ['default'],
      });
    else if (s.type === 'choice' && !s.choices?.includes(s.default as string))
      ctx.addIssue({ code: 'custom', message: 'the default is one of the choices', path: ['default'] });
  });
export type Setting = z.infer<typeof SettingSchema>;

/**
 * How to start the plugin, run in its folder. `node` means CutPilot's own Node.js (the user may
 * not have one); another bare name is looked up on PATH (e.g. `uv`, `python3`); a path is
 * relative to the plugin folder and must stay inside it.
 */
const CommandSchema = z
  .string()
  .min(1)
  .refine(
    (c) => !c.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(c),
    'the command is relative to the plugin folder',
  )
  .refine((c) => !c.split(/[\\/]/).includes('..'), 'the command stays inside the plugin folder');

/**
 * The plugin's icon: a PNG inside the plugin folder, square, 32–256 px, at most 64 KB
 * (`iconProblem` in icon.ts checks the bytes). The store and the Plugins screen show it.
 */
const IconPathSchema = z
  .string()
  .min(1)
  .refine((p) => /\.png$/i.test(p), 'the icon is a PNG, like icon.png')
  .refine(
    (p) => !p.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(p) && !p.split(/[\\/]/).includes('..'),
    'the icon is a path inside the plugin folder',
  );

export const ManifestSchema = z
  .object({
    id: PluginIdSchema,
    name: z.string().min(1).max(60),
    version: z.string().regex(VERSION_RE, 'versions are semver, like 1.0.0'),
    description: z.string().min(1).max(300),
    publisher: z.string().min(1).max(60).optional(),
    homepage: z.url().optional(),
    icon: IconPathSchema.optional(),
    contract: z.literal(CONTRACT_VERSION, {
      error: `this CutPilot speaks plugin contract ${CONTRACT_VERSION}`,
    }),
    /** engine versions the plugin works with, e.g. ">=0.3 <1" */
    cutpilot: z.string().refine((r) => parseRange(r) !== null, 'cutpilot is a semver range, like >=0.3 <1'),
    command: CommandSchema,
    args: z.array(z.string()).default([]),
    kinds: z.array(PluginKindSchema).default([]),
    permissions: PermissionsSchema.default({ network: [], secrets: [], reads: [] }),
    settings: z.array(SettingSchema).default([]),
  })
  .strict()
  .superRefine((m, ctx) => {
    const dup = <T>(xs: T[]) => xs.find((x, i) => xs.indexOf(x) !== i);
    const d = dup(m.kinds);
    if (d) ctx.addIssue({ code: 'custom', message: `kind ${d} is listed twice`, path: ['kinds'] });
    for (const k of m.kinds)
      for (const r of KIND_READS[k])
        if (!m.permissions.reads.includes(r))
          ctx.addIssue({
            code: 'custom',
            message: `a ${k} plugin needs "${r}" in permissions.reads`,
            path: ['permissions', 'reads'],
          });
    const s = dup(m.permissions.secrets);
    if (s)
      ctx.addIssue({
        code: 'custom',
        message: `secret ${s} is listed twice`,
        path: ['permissions', 'secrets'],
      });
    const k = dup(m.settings.map((x) => x.key));
    if (k) ctx.addIssue({ code: 'custom', message: `setting ${k} is listed twice`, path: ['settings'] });
  });
export type Manifest = z.infer<typeof ManifestSchema>;

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

/** Check a parsed `cutpilot-plugin.json`; problems read like `permissions.secrets.0: secret names look like …`. */
export function parseManifest(json: unknown): ManifestResult {
  const r = ManifestSchema.safeParse(json);
  if (r.success) return { ok: true, manifest: r.data };
  return {
    ok: false,
    problems: r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)),
  };
}

/** `apiKey` → `CUTPILOT_SETTING_API_KEY`; `ELEVENLABS_API_KEY` → `CUTPILOT_SECRET_ELEVENLABS_API_KEY` */
export const settingEnv = (key: string) => `CUTPILOT_SETTING_${key.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
export const secretEnv = (name: string) => `CUTPILOT_SECRET_${name}`;
