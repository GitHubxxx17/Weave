import { z } from 'zod';
import { messageSchema } from './messages.js';
import { toolDefinitionSchema } from './tools.js';

const nonNegativeFiniteNumberSchema = z.number().finite().nonnegative();
const tokenCountSchema = z.number().int().nonnegative().safe();

export type FinishReason = 'stop' | 'tool-call' | 'length' | 'content-filter' | 'unknown';

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
}

export const tokenUsageSchema = z
  .object({
    inputTokens: tokenCountSchema.optional(),
    outputTokens: tokenCountSchema.optional(),
    totalTokens: tokenCountSchema.optional(),
    cacheReadTokens: tokenCountSchema.optional(),
    cacheWriteTokens: tokenCountSchema.optional(),
    reasoningTokens: tokenCountSchema.optional(),
  })
  .passthrough();

export interface LlmRequest {
  readonly provider: string;
  readonly model: string;
  readonly messages: readonly z.infer<typeof messageSchema>[];
  readonly tools?: readonly z.infer<typeof toolDefinitionSchema>[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
}

export const llmRequestSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    messages: z.array(messageSchema).readonly(),
    tools: z.array(toolDefinitionSchema).readonly().optional(),
    temperature: nonNegativeFiniteNumberSchema.optional(),
    maxTokens: nonNegativeFiniteNumberSchema.optional(),
    reasoningEffort: z.string().optional(),
  })
  .passthrough();

export type StreamEvent =
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | { readonly type: 'tool-call-start'; readonly id: string; readonly name: string }
  | { readonly type: 'tool-call-delta'; readonly id: string; readonly argumentsDelta: string }
  | {
      readonly type: 'finish';
      readonly reason: FinishReason;
      readonly usage?: TokenUsage;
    };

const textDeltaSchema = z
  .object({
    type: z.literal('text-delta'),
    text: z.string(),
  })
  .passthrough();

const reasoningDeltaSchema = z
  .object({
    type: z.literal('reasoning-delta'),
    text: z.string(),
  })
  .passthrough();

const toolCallStartSchema = z
  .object({
    type: z.literal('tool-call-start'),
    id: z.string(),
    name: z.string(),
  })
  .passthrough();

const toolCallDeltaSchema = z
  .object({
    type: z.literal('tool-call-delta'),
    id: z.string(),
    argumentsDelta: z.string(),
  })
  .passthrough();

const finishSchema = z
  .object({
    type: z.literal('finish'),
    reason: z.enum(['stop', 'tool-call', 'length', 'content-filter', 'unknown']),
    usage: tokenUsageSchema.optional(),
  })
  .passthrough();

export const streamEventSchema = z.discriminatedUnion('type', [
  textDeltaSchema,
  reasoningDeltaSchema,
  toolCallStartSchema,
  toolCallDeltaSchema,
  finishSchema,
]);
