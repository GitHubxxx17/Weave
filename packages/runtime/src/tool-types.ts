import { z } from 'zod';
import type { ApprovalRisk } from './approval-types.js';

const nonEmptyStringSchema = z.string().min(1);
const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
const approvalRiskSchema = z.enum(['low', 'medium', 'high']);

/**
 * Context supplied to every tool implementation by the shared pipeline.
 */
export interface ToolExecutionContext {
  /** Cooperative cancellation signal for the current invocation. */
  readonly signal: AbortSignal;
  /** Session associated with the invocation, when one exists. */
  readonly sessionId?: string | undefined;
}

/** Metadata and redacted summary required before a tool can execute. */
export interface ToolApprovalRequirement<TInput = unknown> {
  /** Stable operation identifier used by the approval control plane. */
  readonly operation: string;
  /** Risk level shown to the caller before approval. */
  readonly risk: ApprovalRisk;
  /** Converts validated input into safe, user-facing approval metadata. */
  readonly summarize: (input: TInput) => {
    readonly summary: string;
    readonly inputSummary: unknown;
  };
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
  /** Optional approval gate evaluated before `execute` is called. */
  readonly approval?: ToolApprovalRequirement<TInput> | undefined;
  /** Tool implementation invoked only by the Tool Pipeline. */
  readonly execute: (input: TInput, context: ToolExecutionContext) => Promise<TOutput> | TOutput;
}

/** Type-erased definition used by registries that do not know tool input types. */
export type RegisteredToolDefinition = ToolDefinition<never, unknown>;

/** Input accepted by one Tool Pipeline invocation. */
export interface ToolExecutionRequest {
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
}

/** Validates external Tool Pipeline input before lookup or execution. */
export const toolExecutionRequestSchema: z.ZodType<ToolExecutionRequest> = z
  .object({
    toolCallId: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    arguments: z.string(),
    sessionId: nonEmptyStringSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
    timeoutMs: nonNegativeFiniteNumberSchema.optional(),
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
    approval: z
      .object({
        operation: nonEmptyStringSchema,
        risk: approvalRiskSchema,
        summarize: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
      })
      .optional(),
    execute: z.custom<(...args: never[]) => unknown>((value) => typeof value === 'function'),
  })
  .passthrough();

/** Stable failure categories exposed by the Tool Pipeline boundary. */
export type ToolExecutionErrorCode =
  | 'tool-invalid-input'
  | 'tool-not-found'
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
