import { z } from 'zod';
import type { ApprovalRisk } from './approval-types.js';
import type { AgentToolAuthority } from './agent-tool-authority.js';
import type { RetrievalErrorCode } from '@weave/protocol';
import type { MemoryErrorCode } from './memory-errors.js';

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
const approvalRiskSchema = z.enum(['low', 'medium', 'high']);

/** Validates a permission mode crossing the Runner or Pipeline boundary. */
export const toolPermissionModeSchema = z.enum(['ask', 'trust', 'yolo']);

/**
 * Permission mode of one Agent run. Every mode exposes all registered tools;
 * the mode only decides whether a protected tool waits for Approval.
 *
 * `ask` requests Approval for every protected tool (read-only tools run freely).
 * `trust` auto-approves routine protected tools and only asks for high-risk ones
 * (see `classifyApprovalRisk`). `yolo` runs every tool without Approval.
 */
export type ToolPermissionMode = z.infer<typeof toolPermissionModeSchema>;

/**
 * Context supplied to every tool implementation by the shared pipeline.
 */
export interface ToolExecutionContext {
  readonly turnId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly toolAuthority?: AgentToolAuthority | undefined;
  readonly toolCallId?: string | undefined;
  /** Cooperative cancellation signal for the current invocation. */
  readonly signal: AbortSignal;
  /** Session associated with the invocation, when one exists. */
  readonly sessionId?: string | undefined;
}

/** Safe, user-facing description of one protected invocation. */
export interface ToolApprovalSummary {
  readonly summary: string;
  readonly inputSummary: unknown;
}

/** Metadata and redacted summary required before a tool can execute. */
export interface ToolApprovalRequirement<TInput = unknown> {
  /** Stable operation identifier used by the approval control plane. */
  readonly operation: string;
  /** Risk level shown to the caller before approval. */
  readonly risk: ApprovalRisk;
  /**
   * Optional per-call filter. When present and it returns `false` for the
   * validated input, this call needs no Approval from the tool itself (a policy
   * vote of `ask` still forces one). Omitted means every call is protected.
   * It may be asynchronous so it can inspect the filesystem through `context`
   * (for example to resolve a symbolic link).
   */
  readonly appliesTo?:
    ((input: TInput, context: ToolExecutionContext) => boolean | Promise<boolean>) | undefined;
  /**
   * Optional per-call check for `trust` mode. When it returns `true` the call
   * asks for Approval even though the mode-level classification would run it
   * directly (for example a write whose real target is a sensitive file). It
   * is not consulted in `ask` mode (already asks) or `yolo` mode (never asks).
   */
  readonly asksInTrust?:
    ((input: TInput, context: ToolExecutionContext) => boolean | Promise<boolean>) | undefined;
  /**
   * Converts validated input into safe, user-facing approval metadata.
   *
   * It may inspect the filesystem through `context` (for example to build a
   * diff) and may therefore be asynchronous. An error thrown here fails the
   * tool call before any Approval is created.
   */
  readonly summarize: (
    input: TInput,
    context: ToolExecutionContext,
  ) => ToolApprovalSummary | Promise<ToolApprovalSummary>;
}

/**
 * Executable tool definition registered with the Runtime.
 *
 * `parameters` describes the model-facing schema, while `inputSchema`
 * validates parsed arguments before `execute` is called.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable name used by model tool calls. */
  readonly name: string;
  /** Human- and model-readable tool description. */
  readonly description: string;
  /** Provider-neutral schema exposed to the model. */
  readonly parameters: unknown;
  /** Runtime validator for parsed JSON arguments. */
  readonly inputSchema: z.ZodType<TInput>;
  /**
   * Whether the tool only reads state. It is currently used only to grant
   * read-only access to delegated sub-tasks; permission modes do not filter
   * tools by it. The default is `false` so an undeclared plugin tool is never
   * treated as safe.
   */
  readonly readOnly?: boolean | undefined;
  /** Optional approval gate evaluated before `execute` is called. */
  readonly approval?: ToolApprovalRequirement<TInput> | undefined;
  /**
   * Reserved for a future structured marker: description and results come from a
   * third party. Not read by the protocol or LLM layers yet; today MCP tools mark
   * untrusted content with text only.
   */
  readonly trust?: 'untrusted' | undefined;
  /** Tool implementation invoked only by the Tool Pipeline. */
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput> | TOutput;
}

/** Type-erased definition used by registries that do not know tool input types. */
export type RegisteredToolDefinition = ToolDefinition<never, unknown>;

/** Input accepted by one Tool Pipeline invocation. */
export interface ToolExecutionRequest {
  readonly turnId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly toolAuthority?: AgentToolAuthority | undefined;
  /** Provider-generated id used to correlate the tool result. */
  readonly toolCallId: string;
  /** Registered tool name. */
  readonly name: string;
  /** Complete JSON argument text assembled from model deltas. */
  readonly arguments: string;
  /** Optional Session id for future audit and durable event integration. */
  readonly sessionId?: string | undefined;
  /** External cooperative cancellation signal. */
  readonly signal?: AbortSignal | undefined;
  /** Request-specific timeout in milliseconds. */
  readonly timeoutMs?: number | undefined;
  /** Permission mode of the calling run; defaults to `ask`. All modes expose
   * every tool; the mode only decides which protected calls need Approval. */
  readonly permissionMode?: ToolPermissionMode | undefined;
}

/** Validates external Tool Pipeline input before lookup or execution. */
export const toolExecutionRequestSchema: z.ZodType<ToolExecutionRequest> = z
  .object({
    toolCallId: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    arguments: z.string(),
    sessionId: nonEmptyStringSchema.optional(),
    turnId: nonEmptyStringSchema.optional(),
    executionId: nonEmptyStringSchema.optional(),
    toolAuthority: z
      .custom<AgentToolAuthority>((value) => typeof value === 'object' && value !== null)
      .optional(),
    signal: z.instanceof(AbortSignal).optional(),
    timeoutMs: nonNegativeFiniteNumberSchema.optional(),
    permissionMode: toolPermissionModeSchema.optional(),
  })
  .passthrough();

/**
 * Validates the executable parts of a registered tool definition.
 *
 * The model-facing `parameters` value remains intentionally provider-neutral.
 */
export const toolDefinitionSchema = z
  .object({
    name: nonEmptyStringSchema,
    description: z.string(),
    parameters: z.unknown(),
    inputSchema: z.custom<z.ZodTypeAny>((value) => value instanceof z.ZodType),
    readOnly: z.boolean().optional(),
    approval: z
      .object({
        operation: nonEmptyStringSchema,
        risk: approvalRiskSchema,
        appliesTo: z
          .custom<(...args: never[]) => unknown>((value) => typeof value === 'function')
          .optional(),
        asksInTrust: z
          .custom<(...args: never[]) => unknown>((value) => typeof value === 'function')
          .optional(),
        summarize: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
      })
      .optional(),
    execute: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
  })
  .passthrough();

/** Stable failure categories exposed by the Tool Pipeline boundary. */
export type ToolExecutionErrorCode =
  | RetrievalErrorCode
  | MemoryErrorCode
  | 'tool-invalid-input'
  | 'tool-not-found'
  | 'tool-not-permitted'
  | 'tool-denied'
  | 'tool-invalid-json'
  | 'tool-invalid-arguments'
  | 'tool-cancelled'
  | 'tool-timeout'
  | 'tool-approval-required'
  | 'tool-approval-rejected'
  | 'tool-approval-cancelled'
  | 'tool-approval-expired'
  | 'tool-execution-failed'
  | 'tool-result-serialization-failed';

/** Error raised when a Tool Pipeline invocation cannot continue. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;

  constructor(code: ToolExecutionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}

/** Normalized result returned after a tool invocation completes. */
export interface ToolExecutionResult {
  /** Original tool call id. */
  readonly toolCallId: string;
  /** Registered tool name. */
  readonly name: string;
  /** Serialized and possibly truncated result content. */
  readonly content: string;
  /** Whether the content exceeded the configured byte limit. */
  readonly truncated: boolean;
}
