import { z } from 'zod';
import { contextBreakdownSchema, type ContextBreakdown } from '../workspace/workspace-types.js';

const nonEmptyStringSchema = z.string().min(1);

const toolCallSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    arguments: z.string(),
  })
  .passthrough();

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.tuple([z.object({ type: z.literal('text'), text: z.string() })]).readonly(),
});

/** Request body accepted by the Agent HTTP stream endpoint. */
export interface AgentRunRequestInput {
  readonly sessionId: string;
  readonly userMessage: {
    readonly role: 'user';
    readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  };
  readonly provider: string;
  readonly model: string;
}

/** Runtime event payloads that Studio can render without importing Runtime. */
export type AgentRuntimeEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
    }
  | {
      readonly type: 'tool-executing';
      readonly toolCall: { readonly id: string; readonly name: string; readonly arguments: string };
    }
  | {
      readonly type: 'tool-result';
      readonly result: {
        readonly toolCallId: string;
        readonly name: string;
        readonly content: string;
        readonly truncated: boolean;
      };
      readonly status?: 'completed' | 'failed' | undefined;
      readonly errorCode?: string | undefined;
    }
  | { readonly type: 'completed'; readonly turnId: string }
  | {
      readonly type: 'usage';
      readonly usage: {
        readonly inputTokens?: number | undefined;
        readonly outputTokens?: number | undefined;
        readonly totalTokens?: number | undefined;
        readonly cacheReadTokens?: number | undefined;
        readonly cacheWriteTokens?: number | undefined;
        readonly reasoningTokens?: number | undefined;
      };
      readonly provider: string;
      readonly model: string;
    }
  | {
      readonly type: 'context';
      readonly breakdown: ContextBreakdown;
      readonly provider: string;
      readonly model: string;
    };

/** Validates the browser-facing request before serializing it for fetch. */
export const agentRunRequestSchema: z.ZodType<AgentRunRequestInput> = z
  .object({
    sessionId: nonEmptyStringSchema,
    userMessage: userMessageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
  })
  .strict();

/** Validates normal SSE events at the browser trust boundary. */
export const agentRuntimeEventSchema: z.ZodType<AgentRuntimeEvent> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), toolCall: toolCallSchema }),
  z.object({ type: z.literal('tool-executing'), toolCall: toolCallSchema }),
  z.object({
    type: z.literal('tool-result'),
    result: z.object({
      toolCallId: nonEmptyStringSchema,
      name: nonEmptyStringSchema,
      content: z.string(),
      truncated: z.boolean(),
    }),
    status: z.enum(['completed', 'failed']).optional(),
    errorCode: z.string().min(1).optional(),
  }),
  z.object({ type: z.literal('completed'), turnId: nonEmptyStringSchema }),
  z.object({
    type: z.literal('usage'),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
      totalTokens: z.number().int().nonnegative().optional(),
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(),
    }),
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal('context'),
    breakdown: contextBreakdownSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
  }),
]);

/** Shape of an error event emitted after the SSE stream has started. */
export const agentStreamErrorPayloadSchema = z.object({
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
  }),
});

export interface AgentStreamHandlers {
  readonly onEvent: (event: AgentRuntimeEvent) => void;
}
