import {
  memoryAccessLevelSchema,
  memoryContentSchema,
  memoryIdSchema,
  memoryQuerySchema,
  memoryRefSchema,
  memoryRevisionSchema,
} from '@weave/protocol';
import { z } from 'zod';

const scopeSelection = z.enum(['project', 'user']).optional();
export const memoryAgentSearchSchema = memoryQuerySchema
  .extend({
    scope: scopeSelection,
    includeUser: z.boolean().optional(),
  })
  .strict()
  .refine((input) => !(input.scope === 'user' && input.includeUser === true));
export const memoryAgentReadSchema = z.strictObject({
  scope: scopeSelection,
  memoryId: memoryIdSchema,
  ref: memoryRefSchema.optional(),
  cursor: z.string().min(1).max(2048).optional(),
});
export const memoryAgentSaveSchema = z.discriminatedUnion('operation', [
  memoryContentSchema
    .extend({
      scope: scopeSelection,
      operation: z.literal('create'),
      expectedRevision: z.literal(0),
    })
    .strict(),
  memoryContentSchema
    .extend({
      scope: scopeSelection,
      operation: z.literal('revise'),
      memoryId: memoryIdSchema,
      expectedRevision: memoryRevisionSchema,
    })
    .strict(),
]);
export const memoryAgentDeleteSchema = z.strictObject({
  scope: scopeSelection,
  memoryId: memoryIdSchema,
  expectedRevision: memoryRevisionSchema,
  reason: z.string().max(512).optional(),
});
export const memoryReviewInputSchema = z.strictObject({
  requestId: memoryIdSchema,
  targetRef: memoryRefSchema,
});
export const memoryDeleteInputSchema = memoryAgentDeleteSchema
  .omit({ scope: true })
  .extend({ requestId: memoryIdSchema })
  .strict();
export const memoryAccessInputSchema = z.strictObject({
  requestId: memoryIdSchema,
  level: memoryAccessLevelSchema,
  expectedSettingRevision: z.number().int().nonnegative().safe(),
});
export const memoryHistoryQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(20).default(20),
  cursor: z.string().min(1).max(2048).optional(),
});
export type MemoryAgentSearchInput = z.input<typeof memoryAgentSearchSchema>;
export type MemoryAgentReadInput = z.infer<typeof memoryAgentReadSchema>;
export type MemoryAgentSaveInput = z.infer<typeof memoryAgentSaveSchema>;
export type MemoryAgentDeleteInput = z.infer<typeof memoryAgentDeleteSchema>;
