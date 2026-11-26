import { z } from 'zod';

/** Mirrors the Server contract: the request names the kind, the Server captures content. */
export const executionContextKindSchema = z.enum(['git-changes', 'project-tree']);
export type ExecutionContextKind = z.infer<typeof executionContextKindSchema>;

export const executionContextSchema = z.strictObject({ kind: executionContextKindSchema });
export type ExecutionContext = z.infer<typeof executionContextSchema>;

export const executionContextsSchema = z
  .array(executionContextSchema)
  .min(1)
  .max(2)
  .readonly()
  .refine((contexts) => new Set(contexts.map(({ kind }) => kind)).size === contexts.length);

/** Safe metadata the Server returns for a context it captured at acceptance. */
export const executionContextSummarySchema = z.strictObject({
  kind: executionContextKindSchema,
  capturedAt: z.iso.datetime(),
  byteLength: z.number().int().nonnegative().max(131_072),
  truncated: z.boolean(),
});
export const executionContextSummariesSchema = z
  .array(executionContextSummarySchema)
  .min(1)
  .max(2)
  .readonly();
export type ExecutionContextSummary = z.infer<typeof executionContextSummarySchema>;

export const executionContextLabels: Readonly<Record<ExecutionContextKind, string>> = {
  'git-changes': 'Git 变更',
  'project-tree': '项目目录',
};
