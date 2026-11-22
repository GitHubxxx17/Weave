import type { LlmClient, LlmProviderRegistry } from '@weave/llm';
import {
  contextBreakdownSchema,
  planSchema,
  toolCallSchema,
  userMessageSchema,
  skillRefsSchema,
  fileReferencesSchema,
  type FileReference,
  type SkillRef,
  type AgentPlan,
  type ContextBreakdown,
  type LlmRequest,
  type StreamEvent,
  type TokenUsage,
  type ToolCall,
  type UserMessage,
} from '@weave/protocol';
import type { SessionEventStore } from '@weave/session';
import { z } from 'zod';
import {
  toolPermissionModeSchema,
  type ToolExecutionResult,
  type ToolPermissionMode,
} from './tool-types.js';
import type { ToolPipeline } from './tool-pipeline.js';
import type { ToolRegistry } from './tool-registry.js';

const nonEmptyStringSchema = z.string().min(1);

export interface AgentRunRequest {
  /** Internal host identity; external HTTP request schemas never accept this port. */
  readonly executionIdentity?:
    | { readonly executionId: string; readonly turnId: string; readonly userMessageId: string }
    | undefined;
  readonly skills?: readonly SkillRef[] | undefined;
  readonly files?: readonly FileReference[] | undefined;
  readonly sessionId: string;
  readonly userMessage: UserMessage;
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  /** False preserves a captured sampling snapshot, including absent values. */
  readonly useProviderDefaults?: boolean | undefined;
  readonly maxTokens?: number | undefined;
  readonly reasoningEffort?: string | undefined;
  /** Tools available to this run; defaults to `workspace`. */
  readonly permissionMode?: ToolPermissionMode | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Input contract for one provider-independent Agent Runner execution.
 */
export const agentRunRequestSchema: z.ZodType<AgentRunRequest> = z
  .object({
    executionIdentity: z
      .object({
        executionId: nonEmptyStringSchema,
        turnId: nonEmptyStringSchema,
        userMessageId: nonEmptyStringSchema,
      })
      .strict()
      .optional(),
    sessionId: nonEmptyStringSchema,
    userMessage: userMessageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    temperature: z.number().finite().nonnegative().optional(),
    useProviderDefaults: z.boolean().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    reasoningEffort: nonEmptyStringSchema.optional(),
    permissionMode: toolPermissionModeSchema.optional(),
    skills: skillRefsSchema.optional(),
    files: fileReferencesSchema.optional(),
    signal: z.instanceof(AbortSignal).optional(),
  })
  .passthrough();

/**
 * Why a turn completed without a final model answer.
 *
 * `agent-step-limit`: the run reached `maxSteps`; completed tool results are
 * kept and the user can ask the Agent to continue.
 */
export type AgentCompletionReason = 'agent-step-limit';

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
  | {
      readonly type: 'completed';
      readonly turnId: string;
      /** Set when the turn ended without a final answer, such as at the step limit. */
      readonly reason?: AgentCompletionReason | undefined;
    }
  | {
      /** Usage of one finished model step; a Turn may emit several. */
      readonly type: 'usage';
      readonly usage: AgentTokenUsage;
      readonly provider: string;
      readonly model: string;
    }
  | {
      /** Estimated send-window composition for one model step, before streaming. */
      readonly type: 'context';
      readonly breakdown: ContextBreakdown;
      readonly provider: string;
      readonly model: string;
    }
  | {
      /** Current task plan after an `update_plan` tool call. */
      readonly type: 'plan';
      readonly plan: AgentPlan;
    };

/** Token usage carried by the `usage` runtime event. */
export type AgentTokenUsage = { readonly [Field in keyof TokenUsage]?: number | undefined };

const tokenCountSchema = z.number().int().nonnegative().safe();
const agentTokenUsageSchema = z.object({
  inputTokens: tokenCountSchema.optional(),
  outputTokens: tokenCountSchema.optional(),
  totalTokens: tokenCountSchema.optional(),
  cacheReadTokens: tokenCountSchema.optional(),
  cacheWriteTokens: tokenCountSchema.optional(),
  reasoningTokens: tokenCountSchema.optional(),
});

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
    reason: z.literal('agent-step-limit').optional(),
  }),
  z.object({
    type: z.literal('usage'),
    usage: agentTokenUsageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('context'),
    breakdown: contextBreakdownSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('plan'),
    plan: planSchema,
  }),
]);

/** Stable failure categories exposed by the Agent Runner boundary. */
export type AgentRunErrorCode =
  | 'agent-invalid-input'
  | 'agent-provider-unavailable'
  | 'agent-stream-protocol'
  | 'agent-tool-call-unsupported'
  | 'agent-tool-call-invalid'
  | 'agent-step-limit'
  | 'agent-context-overflow';

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
/** One model request as a {@link LlmMiddleware} sees it. */
export interface LlmCall {
  readonly request: LlmRequest;
  /** Aborted when the run is cancelled; a middleware should stop when it fires. */
  readonly signal: AbortSignal;
}

/**
 * Middleware around the model stream of one step: it sees the request, may
 * adjust the messages and sampling parameters it passes on, call `next` again
 * to retry, or answer from elsewhere, and it may transform the stream it gets
 * back. It wraps the whole stream, not each chunk.
 *
 * The runner keeps its guarantees around the middleware. The provider and the
 * model of the request cannot change, because the user chose them and the
 * conversation goes only there. Every event the middleware yields is checked
 * against the stream protocol. The run's cancellation always reaches the
 * model. Events the middleware has already yielded have reached the consumer,
 * so a retry after that point repeats them; retry before yielding anything.
 */
export type LlmMiddleware = (
  call: LlmCall,
  next: (call: LlmCall) => AsyncIterable<StreamEvent>,
) => AsyncIterable<StreamEvent> | PromiseLike<AsyncIterable<StreamEvent>>;

export interface AgentRunnerOptions {
  /** Provider-independent model stream implementation. */
  readonly llm?: LlmClient | undefined;
  /** Registry used to route each request to its selected Provider. */
  readonly llmRegistry?: LlmProviderRegistry | undefined;
  /** Middleware around every model stream; see {@link LlmMiddleware}. */
  readonly llmMiddleware?: LlmMiddleware | undefined;
  /** Append-only Session Event Store used for durable turn facts. */
  readonly sessionStore: SessionEventStore;
  /** Host serialization around Session read and the durable turn-start batch only. */
  readonly turnAdmission?:
    ((sessionId: string, start: () => Promise<void>) => Promise<void>) | undefined;
  /** Model-visible and executable tool registry; must pair with `toolPipeline`. */
  readonly toolRegistry?: ToolRegistry | undefined;
  /** Shared validation, approval, timeout, cancellation, and execution boundary. */
  readonly toolPipeline?: ToolPipeline | undefined;
  /**
   * Maximum number of model steps allowed in one turn; defaults to fifty.
   * Reaching it completes the turn with reason `agent-step-limit`.
   */
  readonly maxSteps?: number | undefined;
  /**
   * Returns the system instructions for one run, resolved once before the
   * first model step. They are sent with every model request of the run but
   * are never written to the Session by the Runner, so they can reflect
   * current state such as the Session's Workspace folder and the run's
   * permission mode. `turnId` is the turn whose `turn.started` is already
   * recorded, so a host that must record what it is about to apply can tie it
   * to that turn. A failure here fails the turn before any model call.
   */
  readonly instructions?:
    | ((context: AgentInstructionsContext) => string | undefined | Promise<string | undefined>)
    | undefined;
  /**
   * Tuning for deterministic, fidelity-preserving context compression applied
   * before every model request. The per-Provider context window comes from the
   * Provider descriptor (`contextWindowTokens`) and falls back to
   * `defaultWindowTokens` here.
   */
  readonly context?: AgentContextOptions | undefined;
}

/** Facts captured after queue admission, owned by this exact turn. */
export interface AgentInstructionsContext {
  readonly sessionId: string;
  readonly permissionMode: ToolPermissionMode;
  readonly turnId: string;
  readonly skills: readonly SkillRef[];
  readonly signal: AbortSignal;
  readonly maxToolResultTokens: number;
}

/** Budget knobs for the Agent Runner's send-window builder. */
export interface AgentContextOptions {
  /** Window used when the Provider descriptor omits one; defaults to 128000. */
  readonly defaultWindowTokens?: number | undefined;
  /** Tokens reserved for model output when the request sets no `maxTokens`. */
  readonly reserveOutputTokens?: number | undefined;
  /** Safety margin as a fraction of the window; defaults to 0.05. */
  readonly marginRatio?: number | undefined;
  /** A single tool result above this many tokens is head/tail truncated. */
  readonly maxToolResultTokens?: number | undefined;
}
