import { z } from 'zod';
import type { ToolDefinition, ToolExecutionContext } from './tool-types.js';
import type { WorkspacePolicy } from './workspace-policy.js';

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();

/** Input accepted by the `read_file` Runtime tool. */
export interface ReadFileInput {
  /** Workspace-relative UTF-8 text file path. */
  readonly path: string;
  /** Optional per-call maximum UTF-8 byte length. */
  readonly maxBytes?: number | undefined;
}

/** Input accepted by the `write_file` Runtime tool. */
export interface WriteFileInput {
  /** Workspace-relative UTF-8 text file path. */
  readonly path: string;
  /** UTF-8 text to write. */
  readonly content: string;
  /** Allows replacing an existing regular file when explicitly enabled. */
  readonly overwrite?: boolean | undefined;
  /** Optional per-call maximum UTF-8 byte length. */
  readonly maxBytes?: number | undefined;
}

/** Stable result returned after a successful `write_file` invocation. */
export interface WriteFileResult {
  /** Workspace-relative path used by the operation. */
  readonly path: string;
  /** Number of UTF-8 bytes written. */
  readonly bytesWritten: number;
  /** Whether an existing file was replaced. */
  readonly overwritten: boolean;
}

/** Byte limits shared by both Workspace file tool construction modes. */
export interface WorkspaceFileToolLimits {
  /** Default maximum UTF-8 bytes accepted by `read_file`. */
  readonly maxReadBytes?: number | undefined;
  /** Default maximum UTF-8 bytes accepted by `write_file`. */
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
 * Limits and Workspace boundary supplied when file tools are created.
 *
 * Supply either a fixed `workspace` or a per-invocation `resolveWorkspace`.
 */
export type WorkspaceFileToolOptions = WorkspaceFileToolLimits &
  (
    | {
        /** Lexical Workspace path policy used before filesystem access. */
        readonly workspace: WorkspacePolicy;
        readonly resolveWorkspace?: undefined;
      }
    | {
        readonly workspace?: undefined;
        /** Resolves the Workspace path policy for each invocation. */
        readonly resolveWorkspace: WorkspaceResolver;
      }
  );

/** The two file tools exposed by the Runtime. */
export interface WorkspaceFileTools {
  readonly readFile: ToolDefinition<ReadFileInput, string>;
  readonly writeFile: ToolDefinition<WriteFileInput, WriteFileResult>;
}

/** Stable errors exposed by the Workspace file boundary. */
export type WorkspaceFileErrorCode =
  | 'workspace-file-invalid-input'
  | 'workspace-file-unavailable'
  | 'workspace-file-not-found'
  | 'workspace-file-outside-root'
  | 'workspace-file-symlink-outside-root'
  | 'workspace-file-is-directory'
  | 'workspace-file-already-exists'
  | 'workspace-file-too-large'
  | 'workspace-file-permission-denied'
  | 'workspace-file-cancelled'
  | 'workspace-file-read-failed'
  | 'workspace-file-write-failed';

/** Error raised when a file operation violates the Workspace file contract. */
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
  maxBytes: nonNegativeFiniteNumberSchema.optional(),
});

/** Validates input for the `write_file` tool before filesystem access. */
export const writeFileInputSchema: z.ZodType<WriteFileInput> = z.object({
  path: nonEmptyStringSchema,
  content: z.string(),
  overwrite: z.boolean().optional(),
  maxBytes: nonNegativeFiniteNumberSchema.optional(),
});
