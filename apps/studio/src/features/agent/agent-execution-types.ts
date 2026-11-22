import { z } from 'zod';
import { skillRefsSchema } from '../skills/skill-types.js';
import { agentRuntimeEventSchema } from './agent-types.js';

const id = z.string().min(1).max(240);
export const agentExecutionInputSchema = z.strictObject({
  userMessage: z.strictObject({
    role: z.literal('user'),
    content: z
      .array(
        z.discriminatedUnion('type', [
          z.strictObject({ type: z.literal('text'), text: z.string() }),
          z.strictObject({ type: z.literal('reasoning'), text: z.string() }),
          z.strictObject({ type: z.literal('image'), mediaType: z.string(), data: z.string() }),
        ]),
      )
      .readonly(),
  }),
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().finite().nonnegative().optional(),
  maxTokens: z.number().finite().nonnegative().optional(),
  useProviderDefaults: z.boolean().optional(),
  reasoningEffort: z.string().min(1).optional(),
  permissionMode: z.enum(['ask', 'trust', 'yolo']),
  skills: skillRefsSchema.optional(),
});
export type AgentExecutionInput = z.infer<typeof agentExecutionInputSchema>;
export const agentExecutionStatusSchema = z.enum([
  'accepted',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'persistence-error',
]);
export type AgentExecutionStatus = z.infer<typeof agentExecutionStatusSchema>;
export const agentExecutionCursorSchema = z
  .string()
  .max(600)
  .regex(/^[^:]+:[^:]+:(?:0|[1-9][0-9]*)$/)
  .refine((cursor) => Number.isSafeInteger(Number(cursor.split(':')[2])));
const errorSchema = z.strictObject({ code: z.string().min(1), message: z.string() });
export const agentExecutionSummarySchema = z.strictObject({
  executionId: id,
  requestId: id,
  sessionId: id,
  turnId: id,
  userMessageId: id,
  createdAt: z.iso.datetime(),
  status: agentExecutionStatusSchema,
  cursor: agentExecutionCursorSchema,
  durableThroughSequence: z.number().int().positive().safe().optional(),
  error: errorSchema.optional(),
});
export const agentExecutionSnapshotSchema = agentExecutionSummarySchema
  .extend({
    input: agentExecutionInputSchema,
    events: z.array(agentRuntimeEventSchema).max(4096).readonly(),
  })
  .strict();
export type AgentExecutionSummary = z.infer<typeof agentExecutionSummarySchema>;
export type AgentExecutionSnapshot = z.infer<typeof agentExecutionSnapshotSchema>;
export const agentExecutionStatusFrameSchema = z.strictObject({
  cursor: agentExecutionCursorSchema,
  status: agentExecutionStatusSchema,
  durableThroughSequence: z.number().int().positive().safe().optional(),
  error: errorSchema.optional(),
});
export type AgentExecutionStatusFrame = z.infer<typeof agentExecutionStatusFrameSchema>;
export const agentExecutionEventFrameSchema = z.strictObject({
  cursor: agentExecutionCursorSchema,
  event: agentRuntimeEventSchema,
});
export function isTerminalExecution(status: AgentExecutionStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}
