import { fileReferencesSchema, type FileReference } from '../file-context/file-context-types.js';
import { z } from 'zod';
import type { AgentExecutionSnapshot, AgentExecutionStatusFrame } from './agent-execution-types.js';
import { skillRefsSchema, type SkillRef } from '../skills/skill-types.js';
import {
  contextBreakdownSchema,
  planSchema,
  type AgentPlan,
  type ContextBreakdown,
} from '../workspace/workspace-types.js';

const nonEmptyStringSchema = z.string().min(1);

const toolCallSchema = z
  .object({
    id: nonEmptyStringSchema,
    name: nonEmptyStringSchema,
    arguments: z.string(),
  })
  .passthrough();

const userContentPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('image'), mediaType: z.string(), data: z.string() }),
]);

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: z.array(userContentPartSchema).readonly(),
});

/** Request body accepted by the Agent HTTP stream endpoint. */
export interface AgentRunRequestInput {
  readonly sessionId: string;
  readonly userMessage: {
    readonly role: 'user';
    readonly content: readonly (
      | { readonly type: 'text'; readonly text: string }
      | { readonly type: 'image'; readonly mediaType: string; readonly data: string }
    )[];
  };
  readonly provider: string;
  readonly model: string;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly useProviderDefaults?: boolean | undefined;
  readonly skills?: readonly SkillRef[] | undefined;
  readonly files?: readonly FileReference[] | undefined;
  /** Provider-specific reasoning effort hint; omit for the provider default. */
  readonly reasoningEffort?: string | undefined;
  /** Approval mode for this run. */
  readonly permissionMode?: 'ask' | 'trust' | 'yolo' | undefined;
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
    }
  | { readonly type: 'plan'; readonly plan: AgentPlan };

/** Validates the browser-facing request before serializing it for fetch. */
export const agentRunRequestSchema: z.ZodType<AgentRunRequestInput> = z
  .object({
    sessionId: nonEmptyStringSchema,
    userMessage: userMessageSchema,
    provider: nonEmptyStringSchema,
    model: nonEmptyStringSchema,
    temperature: z.number().finite().nonnegative().optional(),
    maxTokens: z.number().finite().nonnegative().optional(),
    useProviderDefaults: z.boolean().optional(),
    skills: skillRefsSchema.optional(),
    files: fileReferencesSchema.optional(),
    reasoningEffort: nonEmptyStringSchema.optional(),
    permissionMode: z.enum(['ask', 'trust', 'yolo']).optional(),
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
  z.object({ type: z.literal('plan'), plan: planSchema }),
]);

/** Shape of an error event emitted after the SSE stream has started. */
export const agentStreamErrorPayloadSchema = z.object({
  error: z.object({
    code: nonEmptyStringSchema,
    message: nonEmptyStringSchema,
  }),
});

export interface AgentStreamHandlers {
  /** HTTP transport accepted this run; this is not a model application receipt. */
  readonly onAccepted?: (() => void) | undefined;
  readonly onEvent: (event: AgentRuntimeEvent) => void;
  readonly onReceipt?: ((snapshot: AgentExecutionSnapshot) => void) | undefined;
  readonly onSnapshot?: ((snapshot: AgentExecutionSnapshot) => void) | undefined;
  readonly onStatus?: ((status: AgentExecutionStatusFrame) => void) | undefined;
  readonly onConnection?:
    ((state: 'connecting' | 'connected' | 'reconnecting') => void) | undefined;
}
