import { foldTrust, githubPluginSourceSchema } from '@weave/plugin-host';
import { z } from 'zod';
import type {
  ManagedApplicationFailureKind,
  ManagedRuntimeObservation,
} from './extension-coordinator.js';
import type { ExtensionGenerationSnapshot } from './extension-types.js';
import { localExtensionSourceId } from './local-extension-source.js';
import { currentCandidates } from './managed-artifact-retention.js';
import type { ManagedImportResult } from './managed-plugin-installer.js';
import type { ManagedSelectionResult } from './managed-selection-manager.js';
import { canonicalJson } from './plugin-authority-data.js';
import {
  artifactManifestSchema,
  digestSchema,
  headSchema,
  intentSchema,
  opaqueIdSchema,
  pluginIdSchema,
  type ManagedCandidate,
  type ManagedSelection,
  type ManagedTrustState,
  type PluginAuthoritySnapshot,
  type RecordedManagedOperation,
} from './plugin-authority-types.js';

const linkSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const issueSchema = z.strictObject({ code: z.string(), message: z.string() });
const candidateSchema = z.strictObject({
  manifest: artifactManifestSchema,
  digest: digestSchema,
  files: linkSchema,
  bytes: headSchema,
});
const previewSchema = z.strictObject({
  previewId: opaqueIdSchema,
  expiresAt: z.iso.datetime(),
  expectedInstallSequence: headSchema,
  candidate: candidateSchema,
});
export type ImportPreviewResponse = z.infer<typeof previewSchema>;
export const importPreviewResponseSchema: z.ZodType<ImportPreviewResponse> = previewSchema;
export const githubImportPreviewResponseSchema = previewSchema.extend({
  github: githubPluginSourceSchema,
});

const updateSchema = z.strictObject({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  source: githubPluginSourceSchema,
});
export type ManagedUpdate = z.infer<typeof updateSchema>;

export const updatePreviewResponseSchema = githubImportPreviewResponseSchema.extend({
  pluginId: pluginIdSchema,
  expectedTrustSequence: headSchema,
  previousSelection: digestSchema,
  current: z.strictObject({ digest: digestSchema, manifest: artifactManifestSchema }),
  update: updateSchema,
});

const selectionSchema = z.strictObject({
  digest: digestSchema,
  candidateImportSequence: linkSchema,
  activationSequence: linkSchema,
});
const trustSchema = z.strictObject({ digest: digestSchema, enabled: z.boolean() });
const publishedMemberSchema = z.strictObject({
  pluginId: pluginIdSchema,
  digest: digestSchema,
  version: z.string().min(1),
  activationSequence: linkSchema,
});
const generationSchema = z.strictObject({
  id: linkSchema,
  acceptingRuns: z.boolean(),
  blocked: issueSchema.optional(),
});
const catalogSchema = z.strictObject({
  heads: z.strictObject({
    installSequence: headSchema,
    trustSequence: headSchema,
    operationSequence: headSchema,
  }),
  plugins: z.array(
    z.strictObject({
      pluginId: pluginIdSchema,
      candidates: z.array(
        z.discriminatedUnion('provenance', [
          candidateSchema.extend({
            importSequence: linkSchema,
            importedAt: z.iso.datetime(),
            provenance: z.literal('local-directory'),
          }),
          candidateSchema.extend({
            importSequence: linkSchema,
            importedAt: z.iso.datetime(),
            provenance: z.literal('github'),
            github: githubPluginSourceSchema,
          }),
        ]),
      ),
      selection: selectionSchema.nullable(),
      trust: trustSchema.nullable(),
      active: publishedMemberSchema.nullable(),
      update: updateSchema.optional(),
    }),
  ),
  generation: generationSchema,
});
export type ManagedCatalog = z.infer<typeof catalogSchema>;

const targetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('import'), digest: digestSchema }),
  z.strictObject({ kind: z.literal('activate'), intent: intentSchema, digest: digestSchema }),
  z.strictObject({ kind: z.literal('enable'), digest: digestSchema }),
  z.strictObject({
    kind: z.enum(['disable', 'revoke', 'uninstall']),
    digest: digestSchema.nullable(),
    immediate: z.boolean(),
  }),
]);
const decisionSchema = z.strictObject({
  requestId: opaqueIdSchema,
  operationSequence: linkSchema,
  occurredAt: z.iso.datetime(),
  pluginId: pluginIdSchema,
  changed: z.boolean(),
  target: targetSchema,
  selection: selectionSchema.nullable(),
  trust: trustSchema.nullable(),
  installSequence: headSchema,
  trustSequence: headSchema,
  installEventSequence: linkSchema.nullable(),
  trustEventSequence: linkSchema.nullable(),
});
const applicationFields = {
  generation: generationSchema,
  active: publishedMemberSchema.nullable(),
};
const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('committed'),
    decision: decisionSchema,
    application: z.discriminatedUnion('status', [
      z.strictObject({ status: z.enum(['not-required', 'applied']), ...applicationFields }),
      z.strictObject({ status: z.literal('failed'), issue: issueSchema, ...applicationFields }),
    ]),
    current: catalogSchema,
  }),
  z.strictObject({
    kind: z.literal('replayed'),
    decision: decisionSchema,
    application: z.strictObject({ status: z.literal('unknown') }),
    current: catalogSchema,
  }),
]);
export type ManagedMutationResponse = z.infer<typeof mutationSchema>;
type PublishedMember = z.infer<typeof publishedMemberSchema>;

const generationBlock = {
  code: 'plugin-generation-blocked',
  message: 'New runs are blocked pending a compliant Generation.',
};
const applicationIssues = {
  adoption: {
    code: 'plugin-managed-adoption-failed',
    message: 'Managed plugin authority could not be applied.',
  },
  preparation: { code: 'plugin-load-failed', message: 'Managed plugin preparation failed' },
  publication: {
    code: 'plugin-reload-failed',
    message: 'Managed plugin Generation publication failed.',
  },
} satisfies Record<ManagedApplicationFailureKind, z.infer<typeof issueSchema>>;

function projectGeneration({ id, acceptingRuns, blocked }: ExtensionGenerationSnapshot) {
  return { id, acceptingRuns, ...(blocked === undefined ? {} : { blocked: generationBlock }) };
}

function projectSelection(selection: ManagedSelection | null) {
  if (selection === null) return null;
  const { digest, candidateImportSequence, activationSequence } = selection;
  return { digest, candidateImportSequence, activationSequence };
}

function projectTrust(
  candidates: readonly ManagedCandidate[],
  selection: ManagedSelection | null,
  trust: ManagedTrustState | null | undefined,
) {
  if (selection === null || trust == null || trust.digest !== selection.digest) return null;
  const candidate = candidates.find(
    ({ digest, firstImportSequence }) =>
      firstImportSequence === selection.candidateImportSequence && digest === selection.digest,
  );
  if (candidate === undefined) return null;
  const selectedManifest = artifactManifestSchema.parse(candidate.manifest);
  const trustedManifest = artifactManifestSchema.safeParse(trust.manifest);
  if (
    !trustedManifest.success ||
    canonicalJson(trustedManifest.data) !== canonicalJson(selectedManifest)
  )
    return null;
  return { digest: trust.digest, enabled: trust.enabled };
}

function publishedMembers(
  observed: ManagedRuntimeObservation,
): ReadonlyMap<string, PublishedMember> {
  const members = new Map<string, PublishedMember>();
  for (const { sourceId, origin, pluginId, manifest, managedIdentity } of observed.members) {
    if (sourceId !== localExtensionSourceId || origin !== 'managed') continue;
    if (managedIdentity === undefined) throw new Error('Managed member lacks published identity');
    const { digest, activationSequence } = managedIdentity;
    members.set(pluginId, { pluginId, digest, version: manifest.version, activationSequence });
  }
  return members;
}

function byImportSequence(
  left: { firstImportSequence: number },
  right: { firstImportSequence: number },
) {
  return left.firstImportSequence - right.firstImportSequence;
}

function projectCatalog(
  authority: PluginAuthoritySnapshot,
  generation: z.infer<typeof generationSchema>,
  members: ReadonlyMap<string, PublishedMember>,
  updates: ReadonlyMap<string, ManagedUpdate>,
) {
  const trust = foldTrust(authority.trustEvents);
  const imports = new Map(
    authority.installEvents
      .filter((event) => event.kind === 'imported')
      .map((event) => [event.sequence, event] as const),
  );
  const { installSequence, trustSequence, operationSequence } = authority.heads;
  return {
    heads: { installSequence, trustSequence, operationSequence },
    plugins: [...authority.installations]
      .sort(byImportSequence)
      .map(({ pluginId, candidates, selection }) => ({
        pluginId,
        candidates: [...currentCandidates(authority, pluginId, candidates)]
          .sort(byImportSequence)
          .map(({ digest, manifest, files, bytes, firstImportSequence, provenance }) => {
            const recorded = imports.get(firstImportSequence);
            if (
              recorded === undefined ||
              recorded.pluginId !== pluginId ||
              recorded.digest !== digest
            ) {
              throw new Error('Managed candidate lacks its recorded import');
            }
            return {
              digest,
              manifest,
              files,
              bytes,
              importSequence: firstImportSequence,
              importedAt: recorded.occurredAt,
              ...(provenance.kind === 'local-directory'
                ? { provenance: 'local-directory' as const }
                : {
                    provenance: 'github' as const,
                    github: {
                      repository: provenance.repository,
                      commit: provenance.commit,
                      subdirectory: provenance.subdirectory,
                    },
                  }),
            };
          }),
        selection: projectSelection(selection),
        trust: projectTrust(candidates, selection, trust.get(pluginId)),
        active: members.get(pluginId) ?? null,
        ...(updates.has(pluginId) ? { update: updates.get(pluginId)! } : {}),
      })),
    generation,
  };
}

export function projectManagedCatalog(
  authority: PluginAuthoritySnapshot,
  observed: ManagedRuntimeObservation,
  updates: ReadonlyMap<string, ManagedUpdate> = new Map(),
): ManagedCatalog {
  return catalogSchema.parse(
    projectCatalog(
      authority,
      projectGeneration(observed.generation),
      publishedMembers(observed),
      updates,
    ),
  );
}

function projectTarget({
  command,
  evidence,
}: RecordedManagedOperation): z.infer<typeof targetSchema> {
  switch (command.kind) {
    case 'import':
      if (evidence.kind !== 'import')
        throw new Error('Managed import lacks recorded artifact evidence');
      return { kind: command.kind, digest: evidence.artifact.digest };
    case 'activate':
      return { kind: command.kind, intent: command.intent, digest: command.digest };
    case 'enable':
      return { kind: command.kind, digest: command.selectedDigest };
    case 'disable':
    case 'revoke':
    case 'uninstall':
      return { kind: command.kind, digest: command.selectedDigest, immediate: command.immediate };
  }
}

function projectDecision(operation: RecordedManagedOperation, authority: PluginAuthoritySnapshot) {
  const { requestId, sequence, occurredAt, decision } = operation;
  const { pluginId, changed, after, pluginAfter, links } = decision;
  const candidates =
    authority.installations.find((record) => record.pluginId === pluginId)?.candidates ?? [];
  return {
    requestId,
    operationSequence: sequence,
    occurredAt,
    pluginId,
    changed,
    target: projectTarget(operation),
    selection: projectSelection(pluginAfter.selection),
    trust: projectTrust(candidates, pluginAfter.selection, pluginAfter.trust),
    installSequence: after.installSequence,
    trustSequence: after.trustSequence,
    installEventSequence: links.installEventSequence,
    trustEventSequence: links.trustEventSequence,
  };
}

export function projectManagedMutation(
  result: ManagedSelectionResult | ManagedImportResult,
  updates: ReadonlyMap<string, ManagedUpdate> = new Map(),
): ManagedMutationResponse {
  const { kind, operation, observed } = result;
  const authority = kind === 'committed' ? result.savedAuthority : result.currentAuthority;
  const generation = projectGeneration(observed.generation);
  const members = publishedMembers(observed);
  const current = projectCatalog(authority, generation, members, updates);
  const decision = projectDecision(operation, authority);
  if (kind === 'replayed') {
    return mutationSchema.parse({ kind, decision, application: { status: 'unknown' }, current });
  }
  const { application } = result;
  return mutationSchema.parse({
    kind,
    decision,
    application: {
      status: application.status,
      generation,
      active: members.get(decision.pluginId) ?? null,
      ...(application.status === 'failed'
        ? { issue: applicationIssues[application.failureKind] }
        : {}),
    },
    current,
  });
}
