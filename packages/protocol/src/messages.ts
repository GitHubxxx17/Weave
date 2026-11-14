import { z } from 'zod';
import { contentPartSchema } from './content.js';
import { toolCallSchema } from './tools.js';

const contentSchema = z.array(contentPartSchema).readonly();

/** A system instruction message sent to the model. */
export const systemMessageSchema = z
  .object({
    role: z.literal('system'),
    content: contentSchema,
  })
  .passthrough();

/** A user-authored message sent to the model. */
export const userMessageSchema = z
  .object({
    role: z.literal('user'),
    content: contentSchema,
  })
  .passthrough();

/** An assistant message, optionally containing complete tool calls. */
export const assistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: contentSchema,
    toolCalls: z.array(toolCallSchema).readonly().optional(),
  })
  .passthrough();

/** A tool result associated with a previous assistant tool call. */
export const toolMessageSchema = z
  .object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    content: contentSchema,
  })
  .passthrough();

/** The inferred system message contract. */
export type SystemMessage = z.infer<typeof systemMessageSchema>;
/** The inferred user message contract. */
export type UserMessage = z.infer<typeof userMessageSchema>;
/** The inferred assistant message contract. */
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
/** The inferred tool result message contract. */
export type ToolMessage = z.infer<typeof toolMessageSchema>;
/** Any message accepted by the LLM boundary. */
export type Message = z.infer<typeof messageSchema>;

/**
 * Validates messages accepted by the provider-independent LLM protocol.
 */
export const messageSchema = z.discriminatedUnion('role', [
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);
