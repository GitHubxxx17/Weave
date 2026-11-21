import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type {
  ManagedCommitInput,
  PluginAuthoritySnapshot,
  ValidatedArtifactIdentity,
} from '../../src/plugin-authority-types.js';

export const digestA = 'a'.repeat(64);
export const digestB = 'b'.repeat(64);

export function artifact(digest = digestA, version = '1.0.0'): ValidatedArtifactIdentity {
  return {
    pluginId: 'notes',
    digest,
    manifest: {
      id: 'notes',
      name: 'Notes',
      version,
      apiVersion: '1.0.0',
      capabilities: ['command'],
      contributes: { commands: ['notes'] },
      permissions: ['workspace:read'],
    },
    files: 2,
    bytes: 128,
  };
}

export function importInput(
  requestId: string,
  expectedInstallSequence: number,
  identity: ValidatedArtifactIdentity = artifact(),
): ManagedCommitInput {
  return {
    request: {
      requestId,
      command: { kind: 'import', previewId: requestId, expectedInstallSequence },
    },
    prepared: {
      kind: 'import',
      artifact: identity,
      provenance: {
        kind: 'local-directory',
        sourceDirectory: resolve(tmpdir(), 'weave-authority-fixtures', 'notes'),
      },
    },
  };
}

export function activateInput(
  requestId: string,
  snapshot: PluginAuthoritySnapshot,
  identity: ValidatedArtifactIdentity = artifact(),
  intent: 'activate' | 'rollback' = 'activate',
): ManagedCommitInput {
  const installation = snapshot.installations.find(
    (record) => record.pluginId === identity.pluginId,
  );
  return {
    request: {
      requestId,
      command: {
        kind: 'activate',
        pluginId: identity.pluginId,
        digest: identity.digest,
        manifest: identity.manifest,
        previousSelection: installation?.selection?.digest ?? null,
        expectedInstallSequence: snapshot.heads.installSequence,
        expectedTrustSequence: snapshot.heads.trustSequence,
        intent,
      },
    },
    prepared: { kind: 'activate', artifact: identity },
  };
}

export function decisionInput(
  kind: 'enable' | 'disable' | 'revoke' | 'uninstall',
  requestId: string,
  snapshot: PluginAuthoritySnapshot,
  immediate = false,
): ManagedCommitInput {
  const installation = snapshot.installations.find((record) => record.pluginId === 'notes');
  const selectedDigest = installation?.selection?.digest ?? null;
  const review = {
    pluginId: 'notes',
    expectedInstallSequence: snapshot.heads.installSequence,
    expectedTrustSequence: snapshot.heads.trustSequence,
  };
  if (kind === 'enable') {
    if (selectedDigest === null) throw new Error('Authority fixture enable requires a selection');
    const selected = installation?.candidates.find(
      (candidate) => candidate.digest === selectedDigest,
    );
    if (selected === undefined) throw new Error('Authority fixture selection requires a candidate');
    return {
      request: { requestId, command: { kind, ...review, selectedDigest } },
      prepared: {
        kind,
        artifact: {
          pluginId: selected.pluginId,
          digest: selected.digest,
          manifest: selected.manifest,
          files: selected.files,
          bytes: selected.bytes,
        },
      },
    };
  }
  return {
    request: { requestId, command: { kind, ...review, selectedDigest, immediate } },
    prepared: { kind },
  };
}
