import type { PluginHostSnapshot, ReloadResult } from '@weave/plugin-host';
import { pluginManifestSchema } from '@weave/plugin';
import { z } from 'zod';

/** The HTTP management boundary contains no Runner or generation resources. */
export interface ServerPluginManager {
  snapshot(): PluginHostSnapshot;
  reload(): Promise<ReloadResult>;
  trust(id: string, digest: string): Promise<ReloadResult>;
  revoke(id: string, options?: { readonly immediate?: boolean }): Promise<ReloadResult>;
  setEnabled(
    id: string,
    enabled: boolean,
    options?: { readonly immediate?: boolean },
  ): Promise<ReloadResult>;
}

/** Public issues deliberately omit internal exceptions and their causes. */
export const pluginIssueSchema = z.object({ code: z.string(), message: z.string() });
export const pluginErrorResponseSchema = z.object({ error: pluginIssueSchema });
export const pluginDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const pluginGenerationSchema = z.object({
  id: z.number().int().positive(),
  acceptingRuns: z.boolean(),
  blocked: pluginIssueSchema.optional(),
});

export const activeLocalPluginSchema = z.object({
  generation: z.number().int().positive(),
  digest: pluginDigestSchema,
  manifest: pluginManifestSchema,
});

export const localPluginMetadataSchema = z.object({
  directory: z.string(),
  digest: pluginDigestSchema.optional(),
  enabled: z.boolean(),
  manifest: pluginManifestSchema.optional(),
  trusted: z
    .object({ digest: pluginDigestSchema, trustedAt: z.string(), manifest: pluginManifestSchema })
    .optional(),
  active: activeLocalPluginSchema.optional(),
});

export const localPluginSummarySchema = z.object({
  directory: z.string(),
  exists: z.boolean(),
  truncated: z.boolean(),
  trustSequence: z.number().int().nonnegative(),
  generation: pluginGenerationSchema.extend({
    plugins: z.array(
      z.object({ id: z.string(), digest: pluginDigestSchema, manifest: pluginManifestSchema }),
    ),
  }),
  error: pluginIssueSchema.optional(),
});

export const pluginReloadResultSchema = z.object({
  generation: z.number().int().positive(),
  unchanged: z.boolean(),
  failed: z.array(z.object({ id: z.string(), error: pluginIssueSchema })),
  error: pluginIssueSchema.optional(),
});

/** Projects one cached snapshot without exposing candidates, entry paths or resources. */
export function describeLocalPluginHost(snapshot: PluginHostSnapshot) {
  return localPluginSummarySchema.parse({
    directory: snapshot.directory,
    exists: snapshot.exists,
    truncated: snapshot.truncated,
    trustSequence: snapshot.trustSequence,
    generation: snapshot.generation,
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  });
}
