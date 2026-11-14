import { z } from 'zod';
import { contentPartSchema } from './content.js';
import { toolCallSchema } from './tools.js';

const contentSchema = z.array(contentPartSchema).readonly();

export const systemMessageSchema = z
  .object({
    role: z.literal('system'),
    content: contentSchema,
  })
  .passthrough();

export const userMessageSchema = z
  .object({
    role: z.literal('user'),
    content: contentSchema,
  })
  .passthrough();

export const assistantMessageSchema = z
  .object({
    role: z.literal('assistant'),
    content: contentSchema,
    toolCalls: z.array(toolCallSchema).readonly().optional(),
  })
  .passthrough();

export const toolMessageSchema = z
  .object({
    role: z.literal('tool'),
    toolCallId: z.string(),
    content: contentSchema,
  })
  .passthrough();

export type SystemMessage = z.infer<typeof systemMessageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;
export type ToolMessage = z.infer<typeof toolMessageSchema>;
export type Message = z.infer<typeof messageSchema>;

export const messageSchema = z.discriminatedUnion('role', [
  systemMessageSchema,
  userMessageSchema,
  assistantMessageSchema,
  toolMessageSchema,
]);
