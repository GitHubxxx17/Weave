import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import nodePath from 'node:path';
import { readFileEvidence } from './workspace-file-evidence.js';
import {
  fileContentDigest,
  workspaceFileIdentity,
  workspaceRootIdentity,
} from './workspace-mutation.js';
import { resolvePolicy } from './workspace-access.js';
import type {
  WorkspaceFileToolOptions,
  WorkspaceFileWriteIntent,
  WorkspaceFileWriteOutcome,
} from './workspace-file-types.js';
import type { ToolExecutionContext } from './tool-types.js';

/** Minimal intent is a durable barrier; content hooks remain best effort. */
export async function runCapturedWrite(
  options: WorkspaceFileToolOptions,
  context: ToolExecutionContext,
  target: string,
  path: string,
  existedBefore: boolean,
  afterContent: string,
  write: () => Promise<void>,
): Promise<string | undefined> {
  let intent: WorkspaceFileWriteIntent | undefined;
  if (options.onFileWriteIntent !== undefined) {
    if (
      context.sessionId === undefined ||
      context.turnId === undefined ||
      context.toolCallId === undefined
    )
      throw new Error('Safe file capture requires Session, Turn and Tool Call identity');
    const workspace = await resolvePolicy(options, context);
    intent = {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      snapshotId: randomUUID(),
      rootIdentity: await workspaceRootIdentity(workspace.root),
      path: nodePath
        .relative(await realpath(workspace.root), existedBefore ? await realpath(target) : target)
        .split(nodePath.sep)
        .join('/'),
    };
    await options.onFileWriteIntent(intent);
  }
  let reason: string | undefined;
  if (options.onFileSnapshot !== undefined) {
    try {
      const previousContent = existedBefore
        ? new TextDecoder('utf-8', { fatal: true }).decode(await readFileEvidence(target))
        : '';
      await options.onFileSnapshot({
        ...intent,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        path: intent?.path ?? path,
        existedBefore,
        previousContent,
        ...(intent === undefined ? {} : { beforeDigest: fileContentDigest(previousContent) }),
      });
    } catch {
      reason = 'snapshot-capture-failed';
    }
  } else if (intent !== undefined) reason = 'snapshot-capture-unavailable';
  let writeError: unknown;
  try {
    await write();
  } catch (error) {
    writeError = error;
  }
  if (intent !== undefined) {
    try {
      let outcome: WorkspaceFileWriteOutcome;
      if (writeError !== undefined)
        outcome = {
          ...intent,
          status: 'failed',
          captureStatus: 'unavailable',
          reason: 'write-failed',
        };
      else {
        const actual = await readFileEvidence(target);
        if (fileContentDigest(actual) !== fileContentDigest(afterContent))
          reason = 'write-readback-changed';
        outcome = {
          ...intent,
          status: 'succeeded',
          captureStatus: reason === undefined ? 'captured' : 'unavailable',
          afterContent,
          afterDigest: fileContentDigest(afterContent),
          fileIdentity: await workspaceFileIdentity(target),
          ...(reason === undefined ? {} : { reason }),
        };
      }
      if (options.onFileWriteOutcome === undefined) reason = 'write-outcome-unavailable';
      else await options.onFileWriteOutcome(outcome);
    } catch {
      reason = 'write-outcome-recording-failed';
    }
  }
  if (writeError !== undefined) throw writeError;
  return reason;
}
