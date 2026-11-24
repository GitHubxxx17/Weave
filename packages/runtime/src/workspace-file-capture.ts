import { fileReferencesSchema, type FileReference } from '@weave/protocol';
import type { CapturedFileContext } from '@weave/session';
import { AgentExecutionError } from './agent-execution-types.js';
import { captureWorkspaceText, WorkspaceTextCaptureError } from './workspace-text-capture.js';

function executionFailure(error: unknown, signal: AbortSignal): AgentExecutionError {
  const code = signal.aborted
    ? 'cancelled'
    : error instanceof WorkspaceTextCaptureError
      ? error.code
      : 'io';
  switch (code) {
    case 'invalid-path':
      return new AgentExecutionError('execution-invalid-input', 'File references are invalid');
    case 'file-limit':
    case 'batch-limit':
      return new AgentExecutionError(
        'execution-file-too-large',
        'Referenced files exceed the capture size limit',
      );
    case 'unsafe-file':
    case 'unavailable':
      return new AgentExecutionError(
        'execution-file-unavailable',
        'A referenced file is not available for capture',
      );
    case 'invalid-utf8':
    case 'binary':
      return new AgentExecutionError(
        'execution-file-invalid-utf8',
        'A referenced file is not valid UTF-8 text',
      );
    case 'changed':
    case 'root-changed':
      return new AgentExecutionError(
        'execution-file-changed',
        'A referenced file or workspace changed during capture',
      );
    case 'cancelled':
      return new AgentExecutionError(
        'execution-file-capture-timeout',
        'File capture was cancelled before acceptance',
      );
    case 'io':
      return new AgentExecutionError('execution-file-capture-failed', 'File capture failed');
  }
}

export async function captureWorkspaceFiles(
  root: string,
  files: readonly FileReference[],
  { signal }: { readonly signal: AbortSignal },
): Promise<Omit<CapturedFileContext, 'projectId'>> {
  const references = fileReferencesSchema.safeParse(files);
  if (!references.success)
    throw new AgentExecutionError('execution-invalid-input', 'File references are invalid');
  try {
    const result = await captureWorkspaceText(
      root,
      references.data.map(({ path }) => path),
      {
        signal,
        expectedRootDigest: undefined,
        maxFileBytes: 65_536,
        maxBatchBytes: 262_144,
        allowFileSkips: false,
      },
    );
    return {
      version: 1,
      rootIdentity: result.rootIdentity,
      files: result.entries.map((entry) => {
        if ('error' in entry) throw entry.error;
        return { ...entry.file, encoding: 'utf-8' as const };
      }),
    };
  } catch (error) {
    throw executionFailure(error, signal);
  }
}
