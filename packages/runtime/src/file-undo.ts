import { rm, writeFile } from 'node:fs/promises';

import { resolveExistingTarget, resolveLexicalPath, resolveRealRoot } from './workspace-access.js';
import type { WorkspacePolicy } from './workspace-policy.js';

/** A pre-write original captured for undo. */
export interface RestorableFileSnapshot {
  /** Path relative to the Workspace root (posix). */
  readonly path: string;
  readonly existedBefore: boolean;
  /** Original UTF-8 content; ignored when `existedBefore` is false. */
  readonly previousContent: string;
}

/** Outcome of restoring one snapshot. */
export type RestoreFileOutcome = 'restored' | 'deleted' | 'skipped';

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'workspace-file-not-found'
  );
}

/**
 * Restores one file to the captured original: rewrites `previousContent` when
 * the file existed before, or deletes it when the Agent had created it.
 *
 * Path resolution reuses the Workspace policy so a restore can never write
 * outside the project root. A created file that is already gone is a no-op.
 */
export async function restoreFileSnapshot(
  snapshot: RestorableFileSnapshot,
  workspace: WorkspacePolicy,
): Promise<RestoreFileOutcome> {
  const candidate = resolveLexicalPath(workspace, snapshot.path, 'write');
  const root = await resolveRealRoot(workspace.root);
  let target: string;
  try {
    target = await resolveExistingTarget(root, candidate, 'write');
  } catch (error: unknown) {
    if (!snapshot.existedBefore && isNotFound(error)) {
      return 'skipped';
    }
    throw error;
  }

  if (snapshot.existedBefore) {
    await writeFile(target, snapshot.previousContent, { encoding: 'utf8', flag: 'w' });
    return 'restored';
  }
  await rm(target);
  return 'deleted';
}
