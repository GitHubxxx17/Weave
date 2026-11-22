import { lstat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readFileEvidence } from './workspace-file-evidence.js';
import type { SafeFileSnapshot, FileUndoResult } from '@weave/session';
import { resolveLexicalPath, resolveRealRoot } from './workspace-access.js';
import type { WorkspacePolicy } from './workspace-policy.js';
import {
  fileContentDigest,
  workspaceFileIdentity,
  workspaceRootIdentity,
  withWorkspaceMutation,
} from './workspace-mutation.js';

export type RestorableFileSnapshot = SafeFileSnapshot;
export type RestoreFileOutcome = FileUndoResult;

export async function restoreFileSnapshot(
  snapshot: RestorableFileSnapshot,
  workspace: WorkspacePolicy,
): Promise<RestoreFileOutcome> {
  return withWorkspaceMutation(workspace.root, () =>
    restoreFileSnapshotLocked(snapshot, workspace),
  );
}

/** Caller must hold the canonical-root mutation queue. */
export async function restoreFileSnapshotLocked(
  snapshot: RestorableFileSnapshot,
  workspace: WorkspacePolicy,
): Promise<RestoreFileOutcome> {
  const result = (status: FileUndoResult['status'], reason: string): FileUndoResult => ({
    path: snapshot.path,
    status,
    reason,
  });
  if (
    snapshot.unavailableReason !== undefined ||
    snapshot.rootIdentity === undefined ||
    snapshot.fileIdentity === undefined ||
    snapshot.beforeDigest === undefined ||
    snapshot.afterDigest === undefined ||
    snapshot.afterContent === undefined
  )
    return result('unavailable', snapshot.unavailableReason ?? 'incomplete-evidence');
  if (
    fileContentDigest(snapshot.previousContent) !== snapshot.beforeDigest ||
    fileContentDigest(snapshot.afterContent) !== snapshot.afterDigest ||
    (!snapshot.existedBefore && snapshot.previousContent !== '')
  )
    return result('unavailable', 'snapshot-integrity');
  if (
    Buffer.byteLength(snapshot.previousContent, 'utf8') > 1_000_000 ||
    Buffer.byteLength(snapshot.afterContent, 'utf8') > 1_000_000
  )
    return result('unavailable', 'snapshot-size');
  try {
    if ((await workspaceRootIdentity(workspace.root)) !== snapshot.rootIdentity)
      return result('unavailable', 'workspace-root-changed');
    const root = await resolveRealRoot(workspace.root);
    const candidate = resolveLexicalPath(workspace, snapshot.path, 'write');
    const segments = path.relative(workspace.root, candidate.absolutePath).split(path.sep);
    let target = root;
    let metadata;
    for (let i = 0; i < segments.length; i++) {
      target = path.join(target, segments[i]!);
      try {
        metadata = await lstat(target);
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
          return result(
            !snapshot.existedBefore && i === segments.length - 1 ? 'already-restored' : 'conflict',
            'file-missing',
          );
        throw error;
      }
      if (metadata.isSymbolicLink()) return result('conflict', 'symlink-path');
      if (i < segments.length - 1 && !metadata.isDirectory())
        return result('conflict', 'parent-not-directory');
    }
    if (!metadata?.isFile()) return result('conflict', 'not-regular-file');
    if (metadata.nlink !== 1) return result('conflict', 'multiple-hardlinks');
    if (metadata.size > 1_000_000) return result('conflict', 'current-file-too-large');
    const current = await readFileEvidence(target);
    const digest = fileContentDigest(current);
    if (snapshot.existedBefore && digest === snapshot.beforeDigest)
      return result('already-restored', 'before-state-present');
    if (digest !== snapshot.afterDigest) return result('conflict', 'current-content-changed');
    if (
      snapshot.fileIdentity !== undefined &&
      (await workspaceFileIdentity(target)) !== snapshot.fileIdentity
    )
      return result('conflict', 'file-identity-changed');
    if (snapshot.existedBefore)
      await writeFile(target, snapshot.previousContent, { encoding: 'utf8', flag: 'w' });
    else await unlink(target);
    return result('restored', 'restored-before-state');
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      (error.code.includes('outside-root') || error.code.includes('invalid-input'))
    )
      return result('conflict', 'unsafe-path');
    return result('failed', 'filesystem-error');
  }
}
