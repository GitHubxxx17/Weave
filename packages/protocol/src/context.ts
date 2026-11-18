import { z } from 'zod';

const tokenCountSchema = z.number().int().nonnegative().safe();
const ratioSchema = z.number().min(0).max(1);

/**
 * Estimated token cost of what was sent to the model in one request, split by
 * source. These are deterministic estimates produced while building the send
 * window, not provider-reported usage (that is `TokenUsage`).
 */
export interface ContextCategoryBreakdown {
  /** System instructions injected each run. */
  readonly system: number;
  /** Model-visible tool definitions (JSON schema). */
  readonly tools: number;
  /** User messages. */
  readonly userMessages: number;
  /** Assistant reply text. */
  readonly assistantText: number;
  /** Assistant reasoning (only the current turn; history drops it). */
  readonly assistantReasoning: number;
  /** Assistant tool-call arguments. */
  readonly toolCalls: number;
  /** Tool result messages sent in full. */
  readonly toolResults: number;
  /** Deterministic skeletons that replaced older, compressed turns. */
  readonly skeleton: number;
}

/** Summary of one model request's estimated context usage. */
export interface ContextBreakdown {
  /** Model context window in tokens used for the budget. */
  readonly windowTokens: number;
  /** Estimated tokens actually sent this request. */
  readonly sentTokens: number;
  /** `sentTokens / windowTokens`, clamped to [0, 1]. */
  readonly ratio: number;
  /** Whether any history was skeletonized or truncated to fit. */
  readonly trimmed: boolean;
  readonly categories: ContextCategoryBreakdown;
}

export const contextCategoryBreakdownSchema: z.ZodType<ContextCategoryBreakdown> = z.object({
  system: tokenCountSchema,
  tools: tokenCountSchema,
  userMessages: tokenCountSchema,
  assistantText: tokenCountSchema,
  assistantReasoning: tokenCountSchema,
  toolCalls: tokenCountSchema,
  toolResults: tokenCountSchema,
  skeleton: tokenCountSchema,
});

/** Validates a provider-independent context breakdown. */
export const contextBreakdownSchema: z.ZodType<ContextBreakdown> = z.object({
  windowTokens: tokenCountSchema,
  sentTokens: tokenCountSchema,
  ratio: ratioSchema,
  trimmed: z.boolean(),
  categories: contextCategoryBreakdownSchema,
});
