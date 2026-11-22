import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';
import type { WorkspacePolicy } from './workspace-policy.js';

const nonEmptyStringSchema = z.string().min(1);
const positiveLineSchema = z.number().int().positive();

/** Lines returned by one `read_file` page when the caller sets no `limit`. */
export const defaultReadLineLimit = 2000;

/** Input accepted by the `read_file` Runtime tool. */
export interface ReadFileInput {
  /** Workspace-relative UTF-8 text file path. */
  readonly path: string;
  /** First line to return, starting at 1. */
  readonly offset?: number | undefined;
  /** Maximum number of lines to return. */
  readonly limit?: number | undefined;
}

/** Input accepted by the `write_file` Runtime tool. */
export interface WriteFileInput {
  /** Workspace-relative UTF-8 text file path. */
  readonly path: string;
  /** UTF-8 text to write. */
  readonly content: string;
  /** Allows replacing an existing regular file when explicitly enabled. */
  readonly overwrite?: boolean | undefined;
}

/** Stable result returned after a successful `write_file` invocation. */
export interface WriteFileResult {
  /** Workspace-relative path used by the operation. */
  readonly path: string;
  /** Number of UTF-8 bytes written. */
  readonly bytesWritten: number;
  readonly undoUnavailableReason?: string | undefined;
  /** Whether an existing file was replaced. */
  readonly overwritten: boolean;
  /** Workspace-relative directories created for the file, when any were missing. */
  readonly createdDirectories?: readonly string[] | undefined;
}

/** Input accepted by the `edit_file` Runtime tool. */
export interface EditFileInput {
  /** Workspace-relative path of an existing UTF-8 text file. */
  readonly path: string;
  /** Exact text to replace; must match the file verbatim. */
  readonly oldText: string;
  /** Replacement text. */
  readonly newText: string;
  /** Replaces every occurrence instead of requiring exactly one. */
  readonly replaceAll?: boolean | undefined;
}

/** Stable result returned after a successful `edit_file` invocation. */
export interface EditFileResult {
  /** Workspace-relative path used by the operation. */
  readonly path: string;
  /** Number of replaced occurrences. */
  readonly replacements: number;
  readonly undoUnavailableReason?: string | undefined;
  /** Lines present only after the edit. */
  readonly linesAdded: number;
  /** Lines present only before the edit. */
  readonly linesRemoved: number;
  /** Numbered lines around the first change, as they read after the edit. */
  readonly snippet: string;
}

/** Byte limits shared by both Workspace file tool construction modes. */
export interface WorkspaceFileToolLimits {
  /** Maximum UTF-8 bytes of a file `read_file` and `edit_file` will open. */
  readonly maxReadBytes?: number | undefined;
  /** Maximum UTF-8 bytes `write_file` and `edit_file` will write. */
  readonly maxWriteBytes?: number | undefined;
}

/**
 * Resolves the Workspace for one tool invocation, usually from its Session.
 *
 * Returning `undefined` means the Session has no Workspace and the call fails
 * with `workspace-file-unavailable`.
 */
export type WorkspaceResolver = (
  context: ToolExecutionContext,
) => WorkspacePolicy | undefined | Promise<WorkspacePolicy | undefined>;

/**
 * Where a Workspace-aware tool finds its root.
 *
 * Supply either a fixed `workspace` or a per-invocation `resolveWorkspace`.
 */
export type WorkspaceSource =
  | {
      /** Lexical Workspace path policy used before filesystem access. */
      readonly workspace: WorkspacePolicy;
      readonly resolveWorkspace?: undefined;
    }
  | {
      readonly workspace?: undefined;
      /** Resolves the Workspace path policy for each invocation. */
      readonly resolveWorkspace: WorkspaceResolver;
    };

/** A pre-write snapshot of a workspace file, used to undo the change. */
export interface WorkspaceFileWriteIntent {
  readonly sessionId?: string | undefined;
  readonly snapshotId: string;
  readonly turnId: string;
  readonly toolCallId: string;
  readonly rootIdentity: string;
  readonly path: string;
}
export interface WorkspaceFileWriteOutcome extends WorkspaceFileWriteIntent {
  readonly status: 'succeeded' | 'failed';
  readonly captureStatus: 'captured' | 'unavailable';
  readonly afterContent?: string | undefined;
  readonly afterDigest?: string | undefined;
  readonly fileIdentity?: string | undefined;
  readonly reason?: string | undefined;
}
export interface WorkspaceFileSnapshot {
  readonly snapshotId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly rootIdentity?: string | undefined;
  readonly beforeDigest?: string | undefined;
  readonly sessionId?: string | undefined;
  /** Path relative to the Workspace root (posix). */
  readonly path: string;
  readonly existedBefore: boolean;
  /** Original UTF-8 content; empty when the file did not exist. */
  readonly previousContent: string;
}

/** Optional hook invoked before `write_file`/`edit_file` change a file. */
export interface WorkspaceFileSnapshotHook {
  /** Durable barrier: failure rejects the write before mutation. */
  readonly onFileWriteIntent?:
    ((intent: WorkspaceFileWriteIntent) => void | Promise<void>) | undefined;
  readonly onFileWriteOutcome?:
    ((outcome: WorkspaceFileWriteOutcome) => void | Promise<void>) | undefined;
  /** Records the pre-write original. A failure here must not block the write. */
  readonly onFileSnapshot?: ((snapshot: WorkspaceFileSnapshot) => void | Promise<void>) | undefined;
}

/** Limits and Workspace boundary supplied when file tools are created. */
export type WorkspaceFileToolOptions = WorkspaceFileToolLimits &
  WorkspaceFileSnapshotHook &
  WorkspaceSource;

/** The file tools exposed by the Runtime. */
export interface WorkspaceFileTools {
  readonly readFile: ToolDefinition<ReadFileInput, string>;
  readonly writeFile: ToolDefinition<WriteFileInput, WriteFileResult>;
  readonly editFile: ToolDefinition<EditFileInput, EditFileResult>;
}

/** Stable errors exposed by the Workspace tool boundary. */
export type WorkspaceFileErrorCode =
  | 'workspace-file-invalid-input'
  | 'workspace-file-unavailable'
  | 'workspace-file-not-found'
  | 'workspace-file-outside-root'
  | 'workspace-file-symlink-outside-root'
  | 'workspace-file-is-directory'
  | 'workspace-file-not-directory'
  | 'workspace-file-already-exists'
  | 'workspace-file-too-large'
  | 'workspace-file-binary'
  | 'workspace-file-permission-denied'
  | 'workspace-file-cancelled'
  | 'workspace-file-read-failed'
  | 'workspace-file-write-failed'
  | 'workspace-edit-no-match'
  | 'workspace-edit-ambiguous'
  | 'workspace-edit-noop'
  | 'workspace-search-invalid-pattern'
  | 'workspace-search-failed'
  | 'workspace-command-spawn-failed';

/** Error raised when an operation violates the Workspace tool contract. */
export class WorkspaceFileError extends Error {
  readonly code: WorkspaceFileErrorCode;

  constructor(code: WorkspaceFileErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WorkspaceFileError';
    this.code = code;
  }
}

/** Validates input for the `read_file` tool before filesystem access. */
export const readFileInputSchema: z.ZodType<ReadFileInput> = z.object({
  path: nonEmptyStringSchema,
  offset: positiveLineSchema.optional(),
  limit: positiveLineSchema.optional(),
});

/** Validates input for the `write_file` tool before filesystem access. */
export const writeFileInputSchema: z.ZodType<WriteFileInput> = z.object({
  path: nonEmptyStringSchema,
  content: z.string(),
  overwrite: z.boolean().optional(),
});

/** Validates input for the `edit_file` tool before filesystem access. */
export const editFileInputSchema: z.ZodType<EditFileInput> = z.object({
  path: nonEmptyStringSchema,
  oldText: z.string().min(1),
  newText: z.string(),
  replaceAll: z.boolean().optional(),
});
