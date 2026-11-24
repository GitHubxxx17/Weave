import { z } from 'zod';

import {
  githubPluginSourceSchema,
  managedManifestSchema,
  type GithubPluginSource,
  type ManagedManifest,
} from './managed-plugin-types.js';

const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const indexUrl = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === ''
    );
  });
export const marketplaceIndexSourceSchema = z
  .strictObject({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(300),
    url: indexUrl.nullable(),
  })
  .readonly();
const marketplaceSourceSchema = marketplaceIndexSourceSchema
  .unwrap()
  .extend({
    kind: z.enum(['builtin', 'local', 'remote']),
    status: z.enum(['ready', 'unfetched', 'unavailable']),
    stale: z.boolean(),
    removable: z.boolean(),
    fetchedAt: z.iso.datetime().optional(),
    errorCode: z
      .enum(['network', 'timeout', 'too-large', 'invalid-index', 'settings-unavailable'])
      .optional(),
  })
  .superRefine((source, ctx) => {
    if (
      (source.kind === 'remote') !== (source.url !== null) ||
      source.removable !== (source.kind === 'remote')
    ) {
      ctx.addIssue({ code: 'custom', message: 'Invalid marketplace source identity' });
    }
  })
  .readonly();
export const pluginMarketplaceSourcesSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: z.number().int().min(0),
    sources: z.array(marketplaceSourceSchema).max(12).readonly(),
  })
  .superRefine(({ sources }, ctx) => {
    if (new Set(sources.map(({ id }) => id)).size !== sources.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate marketplace source' });
  })
  .readonly();
export type MarketplaceIndexSource = z.infer<typeof marketplaceIndexSourceSchema>;
export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;
export type PluginMarketplaceSources = z.infer<typeof pluginMarketplaceSourcesSchema>;
const fields = {
  id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(1).max(300),
  description: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(10).readonly(),
};

const releaseSchema = z
  .strictObject({
    manifest: managedManifestSchema,
    source: githubPluginSourceSchema,
    compatibility: z.enum(['compatible', 'incompatible']),
  })
  .readonly();

const builtinSchema = z
  .strictObject({
    ...fields,
    kind: z.literal('builtin'),
    category: z.literal('official'),
    publisher: z.literal('Weave'),
    version,
  })
  .readonly();
const githubSchema = z
  .strictObject({
    ...fields,
    kind: z.literal('github'),
    category: z.enum(['official', 'community']),
    publisher: z.string().min(1).max(300),
    releases: z.array(releaseSchema).min(1).max(20).readonly(),
  })
  .readonly();

export const pluginMarketplaceSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    hostVersion: version,
    communityStatus: z.enum(['unconfigured', 'ready', 'unavailable']),
    indexSource: marketplaceIndexSourceSchema.optional(),
    entries: z
      .array(z.discriminatedUnion('kind', [builtinSchema, githubSchema]))
      .max(105)
      .readonly(),
  })
  .superRefine(({ entries }, ctx) => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', message: 'Duplicate plugin ID' });
      ids.add(entry.id);
      if (entry.kind === 'github') {
        if (entry.category === 'official' && entry.publisher !== 'Weave') {
          ctx.addIssue({ code: 'custom', message: 'Invalid official publisher' });
        }
        const versions = new Set<string>();
        for (const release of entry.releases) {
          if (release.manifest.id !== entry.id || versions.has(release.manifest.version)) {
            ctx.addIssue({ code: 'custom', message: 'Invalid release identity' });
          }
          versions.add(release.manifest.version);
        }
      }
    }
  })
  .readonly();

export type PluginMarketplace = z.infer<typeof pluginMarketplaceSchema>;
export type MarketplaceEntry = PluginMarketplace['entries'][number];
export type MarketplaceRelease = z.infer<typeof releaseSchema>;
export interface MarketplaceInstallSelection {
  readonly publisher: string;
  readonly manifest: ManagedManifest;
  readonly source: GithubPluginSource;
}

/** Compare all JSON manifest fields without depending on object insertion order. */
export function marketplaceValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => marketplaceValueEqual(value, right[index]))
    );
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false;
  const a = Object.entries(left).filter(([, value]) => value !== undefined);
  const b = Object.entries(right).filter(([, value]) => value !== undefined);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) &&
        marketplaceValueEqual(value, (right as Record<string, unknown>)[key]),
    )
  );
}
