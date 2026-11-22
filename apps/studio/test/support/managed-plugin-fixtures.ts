import type {
  ManagedCandidate,
  ManagedCatalog,
  ManagedManifest,
  ManagedMutationResponse,
  ManagedPlugin,
  ManagedPreview,
} from '../../src/features/plugins/managed-plugin-types.js';

export const managedPluginId = 'notes-tool';
export const firstDigest = 'b'.repeat(64);
export const secondDigest = 'a'.repeat(64);
const occurredAt = '2026-11-22T04:30:00.000Z';

export const managedManifest = {
  id: managedPluginId,
  name: 'Notes',
  version: '1.0.0',
  apiVersion: '1.0.0',
  description: 'Local notes commands',
  host: 'in-process',
  engines: { weave: '>=0.1.0 <2.0.0' },
  capabilities: ['tool', 'command', 'event'],
  contributes: {
    tools: ['write-note', 'read-note'],
    providers: [],
    promptSections: [],
    events: ['notes-tool/write', 'notes-tool/read'],
    commands: ['write-note', 'read-note'],
    hooks: [],
    services: ['notes.writer', 'notes.reader'],
  },
  permissions: ['workspace:write', 'service:notes.reader', 'workspace:read'],
} satisfies ManagedManifest;

export const firstCandidate = {
  manifest: managedManifest,
  digest: firstDigest,
  files: 2,
  bytes: 984,
  importSequence: 1,
  importedAt: occurredAt,
  provenance: 'local-directory',
} satisfies ManagedCandidate;

export const secondCandidate = {
  ...firstCandidate,
  digest: secondDigest,
  manifest: { ...managedManifest, version: '2.0.0', contributes: {}, permissions: [] },
  importSequence: 3,
} satisfies ManagedCandidate;

export const managedPreview = {
  previewId: 'preview-1',
  expiresAt: '2026-11-22T04:31:00.000Z',
  expectedInstallSequence: 3,
  candidate: { digest: secondDigest, manifest: secondCandidate.manifest, files: 2, bytes: 984 },
} satisfies ManagedPreview;

export const firstSelection = {
  digest: firstDigest,
  candidateImportSequence: 1,
  activationSequence: 2,
};
export const secondSelection = {
  digest: secondDigest,
  candidateImportSequence: 3,
  activationSequence: 4,
};
export const firstActive = {
  pluginId: managedPluginId,
  digest: firstDigest,
  version: '1.0.0',
  activationSequence: 2,
};
export const managedPlugin = {
  pluginId: managedPluginId,
  candidates: [firstCandidate, secondCandidate],
  selection: secondSelection,
  trust: { digest: secondDigest, enabled: true },
  active: firstActive,
} satisfies ManagedPlugin;

export const managedGeneration = { id: 5, acceptingRuns: true };
export const managedCatalog = {
  heads: { installSequence: 4, trustSequence: 5, operationSequence: 6 },
  plugins: [managedPlugin],
  generation: managedGeneration,
} satisfies ManagedCatalog;

export function managedDecision(target: ManagedMutationResponse['decision']['target']) {
  return {
    requestId: 'review-1',
    operationSequence: 6,
    occurredAt,
    pluginId: managedPluginId,
    changed: true,
    target,
    selection: secondSelection,
    trust: managedPlugin.trust,
    installSequence: 4,
    trustSequence: 5,
    installEventSequence: 4,
    trustEventSequence: 5,
  } satisfies ManagedMutationResponse['decision'];
}
