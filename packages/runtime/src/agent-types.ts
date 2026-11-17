import type { LlmClient, LlmProviderRegistry } from '@weave/llm';
import {
  toolCallSchema,
  userMessageSchema,
  type ToolCall,
  type UserMessage,
} from '@weave/protocol';
import type { SessionEventStore } from '@weave/session';
import { z } from 'zod';
import type { ToolExecutionResult } from './tool-types.js';
import type { ToolPipeline } from './tool-pipeline.js';
import type { ToolRegistry } from './tool-registry.js';

const nonEmptyStringSchema = z.string().min(1);

export interface AgentRunRequest {
  readonly sessionId: string;
  readonly userMessage: UserMessage;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Input contract for one provider-independent Agent Runner execution.
 */
export const agentRunRequestSchema: z.ZodType<AgentRunRequest> = z
  .object({
    sessionId: nonEmptyStringSchema,
    userMessage: userMessageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    temperature: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    reasoningEffort: nonEmptyStringSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .passthrough();

/**
 * Transient events emitted while an Agent Runner execution is in progress.
 */
export type AgentRuntimeEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call'; readonly toolCall: ToolCall }
  | { readonly type: 'tool-executing'; readonly toolCall: ToolCall }
  | {
      readonly type: 'tool-result';
      readonly result: ToolExecutionResult;
      /** `failed` marks a recoverable tool failure that was returned to the model. */
      readonly status?: 'completed' | 'failed' | undefined;
      /** Stable error code for a failed result. */
      readonly errorCode?: string | undefined;
    }
  | { readonly type: 'completed'; readonly turnId: string };

export const agentRuntimeEventSchema: z.ZodType<AgentRuntimeEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), toolCall: toolCallSchema }),
  z.object({ type: z.literal('tool-executing'), toolCall: toolCallSchema }),
  z.object({
    type: z.literal('tool-result'),
    result: z.object({
      toolCallId: z.string().min(1),
      name: z.string().min(1),
      content: z.string(),
      truncated: z.boolean(),
    }),
    status: z.enum(['completed', 'failed']).optional(),
    errorCode: z.string().min(1).optional(),
  }),
  z.object({
    type: z.literal('completed'),
    turnId: nonEmptyStringSchema,
  }),
]);

/** Stable failure categories exposed by the Agent Runner boundary. */
export type AgentRunErrorCode =
  | 'agent-invalid-input'
  | 'agent-provider-unavailable'
  | 'agent-stream-protocol'
  | 'agent-tool-call-unsupported'
  | 'agent-tool-call-invalid'
  | 'agent-step-limit';

/** Error raised when an Agent Runner execution cannot continue. */
export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;

  constructor(code: AgentRunErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AgentRunError';
    this.code = code;
  }
}

/** Runtime boundary for executing one Agent turn. */
export interface AgentRunner {
  /** Starts one queued Session turn and streams transient runtime events. */
  run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent>;
}

/** Services required to construct an Agent Runner. */
export interface AgentRunnerOptions {
  /** Provider-independent model stream implementation. */
  readonly llm?: LlmClient | undefined;
  /** Registry used to route each request to its selected Provider. */
  readonly llmRegistry?: LlmProviderRegistry | undefined;
  /** Append-only Session Event Store used for durable turn facts. */
  readonly sessionStore: SessionEventStore;
  /** Model-visible and executable tool registry; must pair with `toolPipeline`. */
  readonly toolRegistry?: ToolRegistry | undefined;
  /** Shared validation, approval, timeout, cancellation, and execution boundary. */
  readonly toolPipeline?: ToolPipeline | undefined;
  /** Maximum number of model steps allowed in one turn; defaults to eight. */
  readonly maxSteps?: number | undefined;
}
