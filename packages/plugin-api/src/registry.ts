/**
 * The plugin store's catalog (P3-046): one `index.json`, signed with ed25519 (`index.json.sig`,
 * base64 over the exact bytes). The app checks the signature, then each package's SHA-256.
 */
import { z } from 'zod';
import {
  CONTRACT_VERSION,
  PermissionsSchema,
  PluginIdSchema,
  PluginKindSchema,
  type Permissions,
} from './manifest.js';
import { compareVersions, parseRange, parseVersion, satisfies, VERSION_RE } from './version.js';

export const REGISTRY_SCHEMA = 1;
/** a package this big is refused before it is downloaded */
export const MAX_PACKAGE_BYTES = 200 * 1024 * 1024;

/** An https URL, or a path relative to the index (packages mirrored next to it). */
const Href = z
  .string()
  .min(1)
  .max(2000)
  .refine(
    (u) =>
      /^https:\/\/[^\s]+$/.test(u) ||
      (/^[A-Za-z0-9._~/-]+$/.test(u) && !u.startsWith('/') && !u.split('/').includes('..')),
    'an https URL or a path relative to the index',
  );
const WebUrl = z.string().regex(/^https:\/\/[^\s]+$/, 'an https URL');

export const PublisherSchema = z.object({
  name: z.string().min(1).max(60),
  /** the store checked who this is (NodCut itself, or a known author) */
  verified: z.boolean().default(false),
});

export const RegistryVersionSchema = z.object({
  version: z.string().regex(VERSION_RE, 'versions are semver'),
  nodcut: z.string().refine((r) => parseRange(r) !== null, 'a semver range'),
  contract: z.number().int().positive(),
  /**
   * the kinds of this version; any name, so a kind added later doesn't make an older NodCut
   * refuse the whole catalog (P3-067): `latestCompatible` passes over a version it can't run
   */
  kinds: z.array(z.string().min(1).max(60)).default([]),
  permissions: PermissionsSchema.default({ network: [], secrets: [], reads: [] }),
  url: Href,
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex SHA-256'),
  bytes: z.number().int().positive().max(MAX_PACKAGE_BYTES),
  /** ISO date */
  published: z.string().min(10).max(40),
  /** what changed, one short paragraph */
  changes: z.string().max(2000).optional(),
});
export type RegistryVersion = z.infer<typeof RegistryVersionSchema>;

export const RegistryPluginSchema = z
  .object({
    id: PluginIdSchema,
    name: z.string().min(1).max(60),
    publisher: PublisherSchema,
    description: z.string().min(1).max(300),
    categories: z.array(z.string().min(1).max(30)).max(5).default([]),
    icon: Href.optional(),
    homepage: WebUrl.optional(),
    repository: WebUrl.optional(),
    license: z.string().min(1).max(60),
    /** the plugin's page, Markdown (the app renders a safe subset) */
    readme: z.string().max(50_000).default(''),
    versions: z.array(RegistryVersionSchema).min(1),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    p.versions.forEach((v, i) => {
      if (seen.has(v.version))
        ctx.addIssue({
          code: 'custom',
          message: `version ${v.version} is listed twice`,
          path: ['versions', i, 'version'],
        });
      seen.add(v.version);
    });
  });
export type RegistryPlugin = z.infer<typeof RegistryPluginSchema>;

export const RegistryIndexSchema = z
  .object({
    schema: z.literal(REGISTRY_SCHEMA),
    /** ISO date the index was built */
    generated: z.string().min(10).max(40),
    plugins: z.array(RegistryPluginSchema),
  })
  .superRefine((x, ctx) => {
    const seen = new Set<string>();
    x.plugins.forEach((p, i) => {
      if (seen.has(p.id))
        ctx.addIssue({
          code: 'custom',
          message: `plugin ${p.id} is listed twice`,
          path: ['plugins', i, 'id'],
        });
      seen.add(p.id);
    });
  });
export type RegistryIndex = z.infer<typeof RegistryIndexSchema>;

const byVersionDesc = (a: RegistryVersion, b: RegistryVersion) =>
  compareVersions(parseVersion(b.version)!, parseVersion(a.version)!);

/** Versions newest first. */
export const sortedVersions = (p: RegistryPlugin): RegistryVersion[] => [...p.versions].sort(byVersionDesc);

/** Kinds this plugin-api knows; a version with another kind is for a newer NodCut. */
const knownKind = (k: string) => PluginKindSchema.safeParse(k).success;

/** The newest version this engine can run (its contract, engine range and kinds), or null. */
export function latestCompatible(p: RegistryPlugin, engineVersion: string): RegistryVersion | null {
  return (
    sortedVersions(p).find(
      (v) =>
        v.contract === CONTRACT_VERSION && satisfies(engineVersion, v.nodcut) && v.kinds.every(knownKind),
    ) ?? null
  );
}

/** Is `candidate` newer than `installed`? */
export const isNewer = (candidate: string, installed: string) => {
  const [a, b] = [parseVersion(candidate), parseVersion(installed)];
  return !!a && !!b && compareVersions(a, b) > 0;
};

/** A package or icon URL, absolute. */
export const resolveHref = (indexUrl: string, href: string) =>
  /^https:\/\//.test(href) ? href : indexUrl.slice(0, indexUrl.lastIndexOf('/') + 1) + href;

/** What `next` may do that `prev` couldn't (an update that asks for these needs approval again). */
export function addedPermissions(prev: Permissions, next: Permissions): Permissions {
  const add = <T>(a: readonly T[], b: readonly T[]) => b.filter((x) => !a.includes(x));
  return {
    network: add(prev.network, next.network),
    secrets: add(prev.secrets, next.secrets),
    reads: add(prev.reads, next.reads),
  };
}

export const noPermissions = (p: Permissions) => !p.network.length && !p.secrets.length && !p.reads.length;
