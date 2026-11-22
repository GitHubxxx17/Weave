import { z } from 'zod';

const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const tokenSchema = z.string().min(1).max(200);
const positiveSequenceSchema = z.int().positive();
export const managedHeadSchema = z.int().nonnegative();
const intentSchema = z.enum(['activate', 'rollback']);
const declarationNames = z.array(z.string().min(1)).readonly().optional();

const githubRepositorySchema = z
  .string()
  .regex(/^https:\/\/github\.com\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9._-]+$/)
  .refine((repository) => {
    const name = repository.split('/').at(-1)!;
    return name !== '.' && name !== '..' && !name.toLowerCase().endsWith('.git');
  });
const githubSubdirectorySchema = z.string().refine((path) => {
  if (path === '') return true;
  const segments = path.split('/');
  if (segments.length > 8) return false;
  return segments.every((segment) => {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      /[<>:"\\|?*\p{Cc}]/u.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
    )
      return false;
    try {
      encodeURIComponent(segment);
      return true;
    } catch {
      return false;
    }
  });
});
const githubSourceFields = {
  repository: githubRepositorySchema,
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  subdirectory: githubSubdirectorySchema,
};
export const githubPluginSourceInputSchema = z
  .strictObject({
    ...githubSourceFields,
    repository: githubRepositorySchema.transform((repository) => repository.toLowerCase()),
    subdirectory: githubSubdirectorySchema.default(''),
  })
  .readonly();
export const githubPluginSourceSchema = z
  .strictObject({
    ...githubSourceFields,
    repository: githubRepositorySchema.refine(
      (repository) => repository === repository.toLowerCase(),
    ),
  })
  .readonly();
export type GithubPluginSource = z.infer<typeof githubPluginSourceSchema>;

// Preserve the reviewed manifest in full for the activation command.
export const managedManifestSchema = z
  .strictObject({
    id: pluginIdSchema,
    name: z.string().min(1),
    version: versionSchema,
    apiVersion: versionSchema,
    description: z.string().min(1).optional(),
    host: z.enum(['in-process', 'mcp', 'subprocess']).optional(),
    engines: z
      .strictObject({ weave: z.string().min(1) })
      .readonly()
      .optional(),
    capabilities: z
      .array(z.enum(['tool', 'llm-provider', 'prompt', 'event', 'command']))
      .min(1)
      .readonly(),
    contributes: z
      .strictObject({
        tools: declarationNames,
        providers: declarationNames,
        promptSections: declarationNames,
        events: declarationNames,
        commands: declarationNames,
        hooks: declarationNames,
        services: declarationNames,
      })
      .readonly(),
    permissions: z
      .array(
        z.union([
          z.enum(['workspace:read', 'workspace:write', 'process:spawn', 'network:request']),
          z.templateLiteral([
            z.literal('service:'),
            z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
          ]),
        ]),
      )
      .readonly(),
  })
  .readonly();
export type ManagedManifest = z.infer<typeof managedManifestSchema>;

const manifestSchema = managedManifestSchema;

const candidateFields = {
  manifest: manifestSchema,
  digest: digestSchema,
  files: positiveSequenceSchema,
  bytes: managedHeadSchema,
};
const importedCandidateFields = {
  ...candidateFields,
  importSequence: positiveSequenceSchema,
  importedAt: z.iso.datetime(),
};
const candidateSchema = z
  .discriminatedUnion('provenance', [
    z.strictObject({ ...importedCandidateFields, provenance: z.literal('local-directory') }),
    z.strictObject({
      ...importedCandidateFields,
      provenance: z.literal('github'),
      github: githubPluginSourceSchema,
    }),
  ])
  .readonly();
export type ManagedCandidate = z.infer<typeof candidateSchema>;

const previewFields = {
  previewId: tokenSchema,
  expiresAt: z.iso.datetime(),
  expectedInstallSequence: managedHeadSchema,
  candidate: z.strictObject(candidateFields).readonly(),
};
export const managedPreviewSchema = z.strictObject(previewFields).readonly();
export const githubManagedPreviewSchema = z
  .strictObject({ ...previewFields, github: githubPluginSourceSchema })
  .readonly();
export type GithubManagedPreview = z.infer<typeof githubManagedPreviewSchema>;
export type ManagedPreview = z.infer<typeof managedPreviewSchema> | GithubManagedPreview;

const selectionSchema = z
  .strictObject({
    digest: digestSchema,
    candidateImportSequence: positiveSequenceSchema,
    activationSequence: positiveSequenceSchema,
  })
  .readonly();
const trustSchema = z.strictObject({ digest: digestSchema, enabled: z.boolean() }).readonly();
const activeSchema = z
  .strictObject({
    pluginId: pluginIdSchema,
    digest: digestSchema,
    version: z.string().min(1),
    activationSequence: positiveSequenceSchema,
  })
  .readonly();
const pluginSchema = z
  .strictObject({
    pluginId: pluginIdSchema,
    candidates: z.array(candidateSchema).readonly(),
    selection: selectionSchema.nullable(),
    trust: trustSchema.nullable(),
    active: activeSchema.nullable(),
  })
  .refine(({ pluginId, candidates }) =>
    candidates.every(({ manifest }) => manifest.id === pluginId),
  )
  .refine(
    ({ candidates, selection }) =>
      selection === null ||
      candidates.some(
        ({ digest, importSequence }) =>
          digest === selection.digest && importSequence === selection.candidateImportSequence,
      ),
  )
  .refine(({ selection, trust }) => trust === null || trust.digest === selection?.digest)
  .refine(
    ({ active, pluginId, candidates }) =>
      active === null ||
      (active.pluginId === pluginId && candidates.some(({ digest }) => digest === active.digest)),
  )
  .readonly();
export type ManagedPlugin = z.infer<typeof pluginSchema>;

const headsSchema = z
  .strictObject({
    installSequence: managedHeadSchema,
    trustSequence: managedHeadSchema,
    operationSequence: managedHeadSchema,
  })
  .readonly();
export type ManagedHeads = z.infer<typeof headsSchema>;

export const managedIssueSchema = z
  .strictObject({ code: z.string(), message: z.string() })
  .readonly();
const generationBlockSchema = z
  .strictObject({
    code: z.literal('plugin-generation-blocked'),
    message: z.literal('New runs are blocked pending a compliant Generation.'),
  })
  .readonly();
const generationSchema = z
  .strictObject({
    id: positiveSequenceSchema,
    acceptingRuns: z.boolean(),
    blocked: generationBlockSchema.optional(),
  })
  .readonly();
export const managedCatalogSchema = z
  .strictObject({
    heads: headsSchema,
    plugins: z
      .array(pluginSchema)
      .refine((plugins) => new Set(plugins.map(({ pluginId }) => pluginId)).size === plugins.length)
      .readonly(),
    generation: generationSchema,
  })
  .readonly();
export type ManagedCatalog = z.infer<typeof managedCatalogSchema>;

export type ManagedCatalogObservation =
  | { readonly kind: 'enabled'; readonly catalog: ManagedCatalog }
  | { readonly kind: 'disabled' }
  | { readonly kind: 'legacy' };

const targetSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('import'), digest: digestSchema }),
    z.strictObject({ kind: z.literal('activate'), digest: digestSchema, intent: intentSchema }),
    z.strictObject({ kind: z.literal('enable'), digest: digestSchema }),
    z.strictObject({
      kind: z.enum(['disable', 'revoke', 'uninstall']),
      digest: digestSchema.nullable(),
      immediate: z.boolean(),
    }),
  ])
  .readonly();
const decisionSchema = z
  .strictObject({
    requestId: tokenSchema,
    operationSequence: positiveSequenceSchema,
    occurredAt: z.iso.datetime(),
    pluginId: pluginIdSchema,
    changed: z.boolean(),
    target: targetSchema,
    selection: selectionSchema.nullable(),
    trust: trustSchema.nullable(),
    installSequence: managedHeadSchema,
    trustSequence: managedHeadSchema,
    installEventSequence: positiveSequenceSchema.nullable(),
    trustEventSequence: positiveSequenceSchema.nullable(),
  })
  .readonly();
const applicationIssueSchema = z
  .discriminatedUnion('code', [
    z.strictObject({
      code: z.literal('plugin-managed-adoption-failed'),
      message: z.literal('Managed plugin authority could not be applied.'),
    }),
    z.strictObject({
      code: z.literal('plugin-load-failed'),
      message: z.literal('Managed plugin preparation failed'),
    }),
    z.strictObject({
      code: z.literal('plugin-reload-failed'),
      message: z.literal('Managed plugin Generation publication failed.'),
    }),
  ])
  .readonly();
const applicationFields = { generation: generationSchema, active: activeSchema.nullable() };
export const managedMutationResponseSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('committed'),
      decision: decisionSchema,
      application: z
        .discriminatedUnion('status', [
          z.strictObject({ status: z.enum(['not-required', 'applied']), ...applicationFields }),
          z.strictObject({
            status: z.literal('failed'),
            issue: applicationIssueSchema,
            ...applicationFields,
          }),
        ])
        .readonly(),
      current: managedCatalogSchema,
    }),
    z.strictObject({
      kind: z.literal('replayed'),
      decision: decisionSchema,
      application: z.strictObject({ status: z.literal('unknown') }).readonly(),
      current: managedCatalogSchema,
    }),
  ])
  .readonly();
export type ManagedMutationResponse = z.infer<typeof managedMutationResponseSchema>;

type SelectionReview = {
  readonly pluginId: string;
  readonly expectedInstallSequence: number;
  readonly expectedTrustSequence: number;
};

export type ManagedReview =
  | { readonly kind: 'import'; readonly preview: ManagedPreview }
  | (SelectionReview & {
      readonly kind: 'activate';
      readonly digest: string;
      readonly manifest: ManagedManifest;
      readonly previousSelection: string | null;
      readonly intent: 'activate' | 'rollback';
    })
  | (SelectionReview & {
      readonly kind: 'enable';
      readonly selectedDigest: string;
    })
  | (SelectionReview & {
      readonly kind: 'disable' | 'revoke' | 'uninstall';
      readonly selectedDigest: string | null;
      readonly immediate: boolean;
    });

export type PreparedManagedRequest = Readonly<{
  url: string;
  body: string;
  requestId: string;
  pluginId: string;
  target: ManagedMutationResponse['decision']['target'];
}>;
