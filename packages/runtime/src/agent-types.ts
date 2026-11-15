import type { LlmClient } from '@weave/llm';
import { userMessageSchema } from '@weave/protocol';
import type { SessionEventStore } from '@weave/session';
import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);

/**
 * Input contract for one provider-independent Agent Runner execution.
 */
export const agentRunRequestSchema = z
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

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

/**
 * Transient events emitted while an Agent Runner execution is in progress.
 */
export const agentRuntimeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({
    type: z.literal('completed'),
    turnId: nonEmptyStringSchema,
  }),
]);

export type AgentRuntimeEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'completed'; readonly turnId: string };

/** Stable failure categories exposed by the Agent Runner boundary. */
export type AgentRunErrorCode =
  'agent-invalid-input' | 'agent-stream-protocol' | 'agent-tool-call-unsupported';

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
  run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent>;
}

/** Services required to construct an Agent Runner. */
export interface AgentRunnerOptions {
  readonly llm: LlmClient;
  readonly sessionStore: SessionEventStore;
}
