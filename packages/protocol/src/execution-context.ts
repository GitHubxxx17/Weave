import { z } from 'zod';

/** Upper bounds shared by the Server capture and the durable snapshot schema. */
export const executionContextLimits = {
  /** `git status` plus `git diff HEAD`, UTF-8 bytes. */
  gitChangesBytes: 131_072,
  /** Project file list, UTF-8 bytes. */
  projectTreeBytes: 65_536,
  projectTreeEntries: 2000,
} as const;

/**
 * A workspace context the Server captures when it accepts an execution. The
 * request names only the kind; content and authority stay on the Server.
 */
export const executionContextSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git-changes') }).strict(),
  z.object({ kind: z.literal('project-tree') }).strict(),
]);
export type ExecutionContext = z.infer<typeof executionContextSchema>;

/** At most one entry per kind. */
export const executionContextsSchema = z
  .array(executionContextSchema)
  .min(1)
  .max(2)
  .readonly()
  .refine(
    (contexts) => new Set(contexts.map(({ kind }) => kind)).size === contexts.length,
    'Execution contexts must have unique kinds',
  );

/** Safe metadata for a captured context; the captured text stays internal. */
export const executionContextSummarySchema = z
  .object({
    kind: z.enum(['git-changes', 'project-tree']),
    capturedAt: z.iso.datetime(),
    byteLength: z.number().int().nonnegative().max(executionContextLimits.gitChangesBytes),
    truncated: z.boolean(),
  })
  .strict();
export type ExecutionContextSummary = z.infer<typeof executionContextSummarySchema>;
