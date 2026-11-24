import { z } from 'zod';
import { extensionGenerationSchema } from '../mcp/mcp-types.js';
import { managedManifestSchema } from './managed-plugin-types.js';

const nameListSchema = z.array(z.string()).readonly();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const generationSchema = z.number().int().positive();

export const pluginIssueSchema = z.object({ code: z.string(), message: z.string() }).readonly();
export type PluginIssue = z.infer<typeof pluginIssueSchema>;

export const pluginDeclarationsSchema = z
  .object({
    tools: nameListSchema.optional(),
    providers: nameListSchema.optional(),
    promptSections: nameListSchema.optional(),
    events: nameListSchema.optional(),
    commands: nameListSchema.optional(),
    skills: nameListSchema.optional(),
    panels: nameListSchema.optional(),
    hooks: nameListSchema.optional(),
    services: nameListSchema.optional(),
  })
  .readonly();
export type PluginDeclarations = z.infer<typeof pluginDeclarationsSchema>;

/** Display projections deliberately accept future declaration and version strings. */
export const pluginManifestProjectionSchema = z.preprocess(
  (value, context) => {
    if (
      typeof value === 'object' &&
      value !== null &&
      'host' in value &&
      value.host === 'declarative' &&
      !managedManifestSchema.safeParse(value).success
    )
      context.addIssue({ code: 'custom', message: 'Invalid declarative Skill package manifest' });
    return value;
  },
  z
    .object({
      id: z.string(),
      name: z.string(),
      version: z.string(),
      apiVersion: z.string(),
      description: z.string().optional(),
      host: z.string().optional(),
      capabilities: nameListSchema,
      engines: z.object({ weave: z.string() }).readonly().optional(),
      contributes: pluginDeclarationsSchema.optional(),
      permissions: nameListSchema.optional(),
    })
    .readonly(),
);
export type PluginManifestProjection = z.infer<typeof pluginManifestProjectionSchema>;

export const localPluginMetadataSchema = z
  .object({
    directory: z.string(),
    digest: digestSchema.optional(),
    enabled: z.boolean(),
    manifest: pluginManifestProjectionSchema.optional(),
    trusted: z
      .object({
        digest: digestSchema,
        trustedAt: z.string(),
        manifest: pluginManifestProjectionSchema,
      })
      .readonly()
      .optional(),
    active: z
      .object({
        generation: generationSchema,
        digest: digestSchema,
        manifest: pluginManifestProjectionSchema,
      })
      .readonly()
      .optional(),
  })
  .readonly();
export type LocalPluginMetadata = z.infer<typeof localPluginMetadataSchema>;

/** One cached Server row; unknown states and origins remain readable. */
export const pluginListItemSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.string(),
    description: z.string().optional(),
    origin: z.string(),
    host: z.string(),
    state: z.string().default('loaded'),
    capabilities: nameListSchema,
    engines: z.object({ weave: z.string() }).readonly().optional(),
    contributes: pluginDeclarationsSchema.optional(),
    permissions: nameListSchema.optional(),
    /** High-risk hooks subscribed without declaration; inactive until the user confirms. */
    pendingHooks: nameListSchema.optional(),
    error: pluginIssueSchema.optional(),
    local: localPluginMetadataSchema.optional(),
    /** Actual contributions, independent of the desired and retained manifests. */
    provides: z
      .object({
        tools: nameListSchema,
        providers: nameListSchema,
        promptSections: nameListSchema,
        events: nameListSchema.default([]).readonly(),
        commands: nameListSchema.default([]).readonly(),
        skills: nameListSchema.optional(),
        panels: nameListSchema.optional(),
        hooks: nameListSchema.default([]).readonly(),
        services: nameListSchema,
      })
      .readonly(),
  })
  .readonly();
export type PluginListItem = z.infer<typeof pluginListItemSchema>;

export const localPluginHostSummarySchema = z
  .object({
    directory: z.string(),
    exists: z.boolean(),
    truncated: z.boolean(),
    trustSequence: z.number().int().nonnegative(),
    generation: z
      .object({
        id: generationSchema,
        acceptingRuns: z.boolean(),
        plugins: z
          .array(
            z
              .object({
                id: z.string(),
                digest: digestSchema,
                manifest: pluginManifestProjectionSchema,
              })
              .readonly(),
          )
          .readonly(),
        blocked: pluginIssueSchema.optional(),
      })
      .readonly(),
    error: pluginIssueSchema.optional(),
  })
  .readonly();
export type LocalPluginHostSummary = z.infer<typeof localPluginHostSummarySchema>;

export const pluginCatalogSchema = z
  .object({
    plugins: z.array(pluginListItemSchema).readonly(),
    local: localPluginHostSummarySchema.optional(),
    generation: extensionGenerationSchema.optional(),
  })
  .readonly();
export type PluginCatalog = z.infer<typeof pluginCatalogSchema>;

/** Backwards-compatible name for callers that only read the list. */
export const pluginListSchema = pluginCatalogSchema;

export const pluginReloadResultSchema = z
  .object({
    generation: generationSchema,
    unchanged: z.boolean(),
    failed: z.array(z.object({ id: z.string(), error: pluginIssueSchema }).readonly()).readonly(),
    error: pluginIssueSchema.optional(),
  })
  .readonly();
export type PluginReloadResult = z.infer<typeof pluginReloadResultSchema>;

export const pluginMutationResponseSchema = z
  .object({
    plugins: z.array(pluginListItemSchema).readonly(),
    local: localPluginHostSummarySchema,
    generation: extensionGenerationSchema.optional(),
    result: pluginReloadResultSchema,
  })
  .readonly();
export type PluginMutationResponse = z.infer<typeof pluginMutationResponseSchema>;
