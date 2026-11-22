import { isAbsolute, join } from 'node:path';
import { pluginManifestSchema, type PluginManifest } from '@weave/plugin';
import {
  githubPluginSourceSchema,
  type GithubPluginSource,
  type PluginTrustStore,
  type RecordedPluginTrustEvent,
} from '@weave/plugin-host';
import { z } from 'zod';

export type Digest = string;
export type Sequence = number;

export interface PluginDatabaseIdentity {
  readonly version: 1;
  readonly databaseId: string;
}

export interface ManagedStoreBinding {
  readonly version: 1;
  readonly databaseId: string;
  readonly databaseFile: string;
  readonly storeId: string;
  readonly storeDirectory: string;
  readonly ownerDatabaseFile: string;
}

export interface ManagedRootRegistration {
  readonly version: 1;
  readonly sequence: 1;
  readonly kind: 'managed-root-registered';
  readonly occurredAt: string;
  readonly binding: ManagedStoreBinding;
}

export interface ManagedRootState {
  readonly databaseId: string;
  readonly databaseFile: string | null;
  readonly registration: ManagedRootRegistration | null;
}

export interface PluginAuthorityExpectation {
  readonly installSequence: Sequence;
  readonly trustSequence: Sequence;
}

export interface PluginAuthorityHeads extends PluginAuthorityExpectation {
  readonly operationSequence: Sequence;
}

export interface LocalDirectoryProvenance {
  readonly kind: 'local-directory';
  readonly sourceDirectory: string;
}

export interface GithubProvenance extends GithubPluginSource {
  readonly kind: 'github';
}

export type PluginProvenance = LocalDirectoryProvenance | GithubProvenance;

export interface ValidatedArtifactIdentity {
  readonly pluginId: string;
  readonly digest: Digest;
  readonly manifest: PluginManifest;
  readonly files: number;
  readonly bytes: number;
}

export interface ManagedSelection {
  readonly digest: Digest;
  readonly candidateImportSequence: Sequence;
  readonly activationSequence: Sequence;
}

export interface ManagedCandidate extends ValidatedArtifactIdentity {
  readonly firstImportSequence: Sequence;
  readonly provenance: PluginProvenance;
}

export interface ManagedPluginRecord {
  readonly pluginId: string;
  readonly firstImportSequence: Sequence;
  readonly candidates: readonly ManagedCandidate[];
  readonly selection: ManagedSelection | null;
}

export interface ManagedRequest {
  readonly requestId: string;
  readonly command: ManagedCommand;
}

export type ManagedCommand =
  | {
      readonly kind: 'import';
      readonly previewId: string;
      readonly expectedInstallSequence: Sequence;
    }
  | {
      readonly kind: 'activate';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly manifest: PluginManifest;
      readonly previousSelection: Digest | null;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
      readonly intent: 'activate' | 'rollback';
    }
  | {
      readonly kind: 'enable';
      readonly pluginId: string;
      readonly selectedDigest: Digest;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
    }
  | {
      readonly kind: 'disable' | 'revoke' | 'uninstall';
      readonly pluginId: string;
      readonly selectedDigest: Digest | null;
      readonly expectedInstallSequence: Sequence;
      readonly expectedTrustSequence: Sequence;
      readonly immediate: boolean;
    };

export type ManagedPreparation =
  | {
      readonly kind: 'import';
      readonly artifact: ValidatedArtifactIdentity;
      readonly provenance: PluginProvenance;
    }
  | { readonly kind: 'activate' | 'enable'; readonly artifact: ValidatedArtifactIdentity }
  | { readonly kind: 'disable' | 'revoke' | 'uninstall' };

export interface ManagedCommitInput {
  readonly request: ManagedRequest;
  readonly prepared: ManagedPreparation;
}

export type PluginInstallEvent =
  | {
      readonly kind: 'imported';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly manifest: PluginManifest;
      readonly files: number;
      readonly bytes: number;
      readonly provenance: PluginProvenance;
    }
  | {
      readonly kind: 'activated';
      readonly pluginId: string;
      readonly digest: Digest;
      readonly candidateImportSequence: Sequence;
      readonly previousSelection: Digest | null;
      readonly trustEventSequence: Sequence;
      readonly intent: 'activate' | 'rollback';
    }
  | {
      readonly kind: 'uninstalled';
      readonly pluginId: string;
      readonly previousSelection: Digest | null;
      readonly trustEventSequence: Sequence;
    };

export type RecordedPluginInstallEvent = PluginInstallEvent & {
  readonly sequence: Sequence;
  readonly occurredAt: string;
  readonly scope: 'user';
  readonly operationSequence: Sequence;
};

export interface ManagedTrustState {
  readonly digest: Digest;
  readonly manifest: PluginManifest;
  readonly enabled: boolean;
}

export interface ManagedPluginState {
  readonly selection: ManagedSelection | null;
  readonly trust: ManagedTrustState | null;
}

export interface ManagedDecision {
  readonly kind: ManagedCommand['kind'];
  readonly pluginId: string;
  readonly changed: boolean;
  readonly before: PluginAuthorityExpectation;
  readonly after: PluginAuthorityExpectation;
  readonly pluginBefore: ManagedPluginState;
  readonly pluginAfter: ManagedPluginState;
  readonly links: {
    readonly installEventSequence: Sequence | null;
    readonly trustEventSequence: Sequence | null;
  };
}

export interface RecordedManagedOperation {
  readonly version: 1;
  readonly sequence: Sequence;
  readonly occurredAt: string;
  readonly scope: 'user';
  readonly requestId: string;
  readonly command: ManagedCommand;
  readonly fingerprint: Digest;
  readonly evidence: ManagedPreparation;
  readonly decision: ManagedDecision;
}

export interface PluginAuthoritySnapshot {
  readonly identity: PluginDatabaseIdentity;
  readonly heads: PluginAuthorityHeads;
  readonly trustEvents: readonly RecordedPluginTrustEvent[];
  readonly installEvents: readonly RecordedPluginInstallEvent[];
  readonly operationEvents: readonly RecordedManagedOperation[];
  readonly installations: readonly ManagedPluginRecord[];
}

export type ManagedLookup =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentSnapshot: PluginAuthoritySnapshot;
    };

export type ManagedCommit =
  | {
      readonly kind: 'committed';
      readonly operation: RecordedManagedOperation;
      readonly afterSnapshot: PluginAuthoritySnapshot;
    }
  | {
      readonly kind: 'replayed';
      readonly operation: RecordedManagedOperation;
      readonly currentSnapshot: PluginAuthoritySnapshot;
    };

export interface PluginAuthorityDatabase {
  readonly identity: PluginDatabaseIdentity;
  readonly trust: PluginTrustStore;
  snapshotSync(): PluginAuthoritySnapshot;
  readStartupAuthoritySync(): {
    readonly snapshot: PluginAuthoritySnapshot;
    readonly registration: ManagedRootRegistration | null;
  };
  lookupSync(request: ManagedRequest): ManagedLookup;
  commitSync(input: ManagedCommitInput): ManagedCommit;
  readManagedRootStateSync(): ManagedRootState;
  registerManagedRootSync(binding: ManagedStoreBinding): ManagedRootRegistration;
  close(): Promise<void>;
}

export interface PluginAuthorityOptions {
  readonly filename: string;
  readonly now?: (() => Date) | undefined;
  readonly newDatabaseId?: (() => string) | undefined;
}

export type PluginAuthorityErrorCode =
  | 'plugin-authority-invalid'
  | 'plugin-authority-request-conflict'
  | 'plugin-authority-conflict'
  | 'plugin-authority-not-found'
  | 'plugin-authority-activation-required'
  | 'plugin-authority-protocol'
  | 'plugin-authority-storage'
  | 'plugin-authority-busy'
  | 'plugin-authority-closed';

export class PluginAuthorityError extends Error {
  constructor(
    readonly code: PluginAuthorityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginAuthorityError';
  }
}

export const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const opaqueIdSchema = z.string().min(1).max(200);
export const headSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const linkSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const intentSchema = z.enum(['activate', 'rollback']);
const commandKindSchema = z.enum([
  'import',
  'activate',
  'enable',
  'disable',
  'revoke',
  'uninstall',
]);
const expectationShape = { installSequence: headSchema, trustSequence: headSchema };
const expectedHeadsShape = {
  expectedInstallSequence: headSchema,
  expectedTrustSequence: headSchema,
};
export const artifactManifestSchema = pluginManifestSchema.refine(
  (manifest) => manifest.contributes !== undefined && manifest.permissions !== undefined,
  { message: 'Managed artifacts require contributes and permissions declarations' },
);
const artifactShape = {
  pluginId: pluginIdSchema,
  digest: digestSchema,
  manifest: artifactManifestSchema,
  files: linkSchema,
  bytes: headSchema,
};
const artifactSchema: z.ZodType<ValidatedArtifactIdentity> = z
  .object(artifactShape)
  .strict()
  .refine((artifact) => artifact.pluginId === artifact.manifest.id, {
    message: 'Artifact plugin ID must equal manifest ID',
    path: ['manifest', 'id'],
  });
const localProvenanceSchema = z
  .object({
    kind: z.literal('local-directory'),
    sourceDirectory: z
      .string()
      .min(1)
      .refine((value) => !value.includes('\0') && isAbsolute(value), {
        message: 'Source directory must be an absolute path without NUL',
      }),
  })
  .strict();
const githubProvenanceSchema = githubPluginSourceSchema.extend({ kind: z.literal('github') });
const provenanceSchema: z.ZodType<PluginProvenance> = z.union([
  localProvenanceSchema,
  githubProvenanceSchema,
]);

function commandSchema(immediate: z.ZodType<boolean>): z.ZodType<ManagedCommand> {
  return z
    .discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('import'),
          previewId: opaqueIdSchema,
          expectedInstallSequence: headSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('activate'),
          pluginId: pluginIdSchema,
          digest: digestSchema,
          manifest: pluginManifestSchema,
          previousSelection: digestSchema.nullable(),
          ...expectedHeadsShape,
          intent: intentSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('enable'),
          pluginId: pluginIdSchema,
          selectedDigest: digestSchema,
          ...expectedHeadsShape,
        })
        .strict(),
      z
        .object({
          kind: z.enum(['disable', 'revoke', 'uninstall']),
          pluginId: pluginIdSchema,
          selectedDigest: digestSchema.nullable(),
          ...expectedHeadsShape,
          immediate,
        })
        .strict(),
    ])
    .refine((command) => command.kind !== 'activate' || command.pluginId === command.manifest.id, {
      message: 'Command plugin ID must equal manifest ID',
      path: ['manifest', 'id'],
    });
}

/** Only static request defaults are applied; evidence is validated separately. */
export const managedRequestSchema: z.ZodType<ManagedRequest> = z
  .object({
    requestId: opaqueIdSchema,
    command: commandSchema(z.boolean().default(false)),
  })
  .strict();

export const managedPreparationSchema: z.ZodType<ManagedPreparation> = z.discriminatedUnion(
  'kind',
  [
    z
      .object({ kind: z.literal('import'), artifact: artifactSchema, provenance: provenanceSchema })
      .strict(),
    z.object({ kind: z.enum(['activate', 'enable']), artifact: artifactSchema }).strict(),
    z.object({ kind: z.enum(['disable', 'revoke', 'uninstall']) }).strict(),
  ],
);

const recordedShape = {
  sequence: linkSchema,
  occurredAt: z.iso.datetime(),
  scope: z.literal('user'),
};

export const recordedPluginInstallEventSchema: z.ZodType<RecordedPluginInstallEvent> = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('imported'),
        ...artifactShape,
        provenance: provenanceSchema,
        ...recordedShape,
        operationSequence: linkSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('activated'),
        pluginId: pluginIdSchema,
        digest: digestSchema,
        candidateImportSequence: linkSchema,
        previousSelection: digestSchema.nullable(),
        trustEventSequence: linkSchema,
        intent: intentSchema,
        ...recordedShape,
        operationSequence: linkSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('uninstalled'),
        pluginId: pluginIdSchema,
        previousSelection: digestSchema.nullable(),
        trustEventSequence: linkSchema,
        ...recordedShape,
        operationSequence: linkSchema,
      })
      .strict(),
  ])
  .refine((event) => event.kind !== 'imported' || event.pluginId === event.manifest.id, {
    message: 'Imported plugin ID must equal manifest ID',
    path: ['manifest', 'id'],
  });

const selectionSchema: z.ZodType<ManagedSelection> = z
  .object({
    digest: digestSchema,
    candidateImportSequence: linkSchema,
    activationSequence: linkSchema,
  })
  .strict();
const pluginStateSchema: z.ZodType<ManagedPluginState> = z
  .object({
    selection: selectionSchema.nullable(),
    trust: z
      .object({
        digest: digestSchema,
        manifest: pluginManifestSchema,
        enabled: z.boolean(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const decisionSchema: z.ZodType<ManagedDecision> = z
  .object({
    kind: commandKindSchema,
    pluginId: pluginIdSchema,
    changed: z.boolean(),
    before: z.object(expectationShape).strict(),
    after: z.object(expectationShape).strict(),
    pluginBefore: pluginStateSchema,
    pluginAfter: pluginStateSchema,
    links: z
      .object({
        installEventSequence: linkSchema.nullable(),
        trustEventSequence: linkSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (decision) =>
      [decision.pluginBefore, decision.pluginAfter].every(
        (state) => state.trust === null || state.trust.manifest.id === decision.pluginId,
      ),
    {
      message: 'Decision trust manifests must match the plugin ID',
    },
  );

export const recordedManagedOperationSchema: z.ZodType<RecordedManagedOperation> = z
  .object({
    version: z.literal(1),
    ...recordedShape,
    requestId: opaqueIdSchema,
    // Persisted commands are already normalized; missing defaults are corrupt data.
    command: commandSchema(z.boolean()),
    fingerprint: digestSchema,
    evidence: managedPreparationSchema,
    decision: decisionSchema,
  })
  .strict()
  .refine(
    (operation) => {
      const { command, evidence, decision } = operation;
      if (command.kind !== evidence.kind || command.kind !== decision.kind) return false;
      if (command.kind !== 'import' && command.pluginId !== decision.pluginId) return false;
      return !('artifact' in evidence) || evidence.artifact.pluginId === decision.pluginId;
    },
    { message: 'Operation command, evidence and decision must name the same kind and plugin' },
  );

export const pluginDatabaseIdentitySchema: z.ZodType<PluginDatabaseIdentity> = z
  .object({
    version: z.literal(1),
    databaseId: z.string().uuid(),
  })
  .strict();

const managedBindingPathSchema = z
  .string()
  .refine((path) => isAbsolute(path) && !path.includes('\0'), {
    message: 'Managed binding paths must be absolute and contain no NUL',
  });

export const managedStoreBindingSchema: z.ZodType<ManagedStoreBinding> = z
  .strictObject({
    version: z.literal(1),
    databaseId: z.string().uuid(),
    databaseFile: managedBindingPathSchema,
    storeId: z.string().uuid(),
    storeDirectory: managedBindingPathSchema,
    ownerDatabaseFile: managedBindingPathSchema,
  })
  .refine(
    (binding) => binding.ownerDatabaseFile === join(binding.storeDirectory, 'ownership.sqlite'),
    {
      message: 'The owner database must be ownership.sqlite inside the managed store',
      path: ['ownerDatabaseFile'],
    },
  );

export const managedRootRegistrationSchema: z.ZodType<ManagedRootRegistration> = z.strictObject({
  version: z.literal(1),
  sequence: z.literal(1),
  kind: z.literal('managed-root-registered'),
  occurredAt: z.iso.datetime(),
  binding: managedStoreBindingSchema,
});

export const pluginAuthorityOptionsSchema: z.ZodType<PluginAuthorityOptions> = z
  .object({
    filename: z.string().min(1),
    now: z.custom<() => Date>((value) => typeof value === 'function').optional(),
    newDatabaseId: z.custom<() => string>((value) => typeof value === 'function').optional(),
  })
  .strict();
