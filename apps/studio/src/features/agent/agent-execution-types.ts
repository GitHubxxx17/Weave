import {
  fileReferencesSchema,
  fileAttachmentSummariesSchema,
} from '../file-context/file-context-types.js';
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
  files: fileReferencesSchema.optional(),
});
export type AgentExecutionInput = z.infer<typeof agentExecutionInputSchema>;
export const agentExecutionStatusSchema = z.enum([
  'queued',
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
    fileAttachments: fileAttachmentSummariesSchema.optional(),
    effectiveSettings: z
      .strictObject({
        useProviderDefaults: z.literal(false),
        temperature: z.number().finite().nonnegative().optional(),
        maxTokens: z.number().finite().nonnegative().optional(),
      })
      .optional(),
    events: z.array(agentRuntimeEventSchema).max(4096).readonly(),
  })
  .strict();
export type AgentExecutionSummary = z.infer<typeof agentExecutionSummarySchema>;
export const agentExecutionQueueEntrySchema = agentExecutionSummarySchema
  .extend({
    preview: z.string().refine((value) => [...value].length <= 240),
    provider: z.string().min(1),
    model: z.string().min(1),
    imageCount: z.number().int().nonnegative().safe(),
    skillCount: z.number().int().nonnegative().max(32),
    fileCount: z.number().int().nonnegative().max(8),
  })
  .strict();
export const agentExecutionQueueSnapshotSchema = z.strictObject({
  sessionId: id,
  revision: z.number().int().nonnegative().safe(),
  cursor: z
    .string()
    .max(2500)
    .regex(/^[^:]+:[^:]+:(?:0|[1-9][0-9]*)$/)
    .refine((cursor) => Number.isSafeInteger(Number(cursor.split(':')[2]))),
  active: agentExecutionSummarySchema.nullable(),
  queued: z.array(agentExecutionQueueEntrySchema).max(10).readonly(),
  scheduler: z.enum(['ready', 'closing', 'blocked']),
  limits: z.strictObject({ sessionQueued: z.literal(10), globalQueued: z.literal(100) }),
  error: errorSchema.optional(),
});
export type AgentExecutionQueueSnapshot = z.infer<typeof agentExecutionQueueSnapshotSchema>;
export const agentExecutionQueuedCancelSchema = z.strictObject({
  requestId: id,
  expectedRevision: z.number().int().nonnegative().safe(),
});
export const agentExecutionQueueReorderSchema = agentExecutionQueuedCancelSchema
  .extend({
    executionIds: z
      .array(id)
      .max(10)
      .readonly()
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .strict();
export type AgentExecutionQueuedCancel = z.infer<typeof agentExecutionQueuedCancelSchema>;
export type AgentExecutionQueueReorder = z.infer<typeof agentExecutionQueueReorderSchema>;
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
