import { createHash } from 'node:crypto';
import {
  executionContextLimits,
  type ExecutionContext,
  type ExecutionContextSummary,
} from '@weave/protocol';
import { z } from 'zod';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);

const snapshotFields = {
  capturedAt: z.iso.datetime(),
  content: z.string(),
  byteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  sha256: digestSchema,
};

function exactText(snapshot: {
  readonly content: string;
  readonly byteLength: number;
  readonly sha256: string;
}): boolean {
  if (snapshot.content.includes('\0')) return false;
  const bytes = Buffer.from(snapshot.content, 'utf8');
  return (
    bytes.length === snapshot.byteLength &&
    createHash('sha256').update(bytes).digest('hex') === snapshot.sha256
  );
}

const gitChangesSnapshotSchema = z
  .object({ kind: z.literal('git-changes'), ...snapshotFields })
  .strict()
  .refine(
    (snapshot) =>
      snapshot.byteLength <= executionContextLimits.gitChangesBytes && exactText(snapshot),
    'Git changes snapshot must preserve exact UTF-8 bytes within the size limit',
  );

const projectTreeSnapshotSchema = z
  .object({
    kind: z.literal('project-tree'),
    ...snapshotFields,
    entryCount: z.number().int().nonnegative().max(executionContextLimits.projectTreeEntries),
  })
  .strict()
  .refine(
    (snapshot) =>
      snapshot.byteLength <= executionContextLimits.projectTreeBytes && exactText(snapshot),
    'Project tree snapshot must preserve exact UTF-8 bytes within the size limit',
  );

const contextSnapshotSchema = z.discriminatedUnion('kind', [
  gitChangesSnapshotSchema,
  projectTreeSnapshotSchema,
]);
export type CapturedContextSnapshot = z.infer<typeof contextSnapshotSchema>;

/** The single durable copy of the workspace contexts captured before acceptance. */
export const capturedWorkspaceContextSchema = z
  .object({
    version: z.literal(1),
    projectId: z.string().min(1).max(240),
    snapshots: z.array(contextSnapshotSchema).min(1).max(2).readonly(),
  })
  .strict()
  .refine(
    ({ snapshots }) => new Set(snapshots.map(({ kind }) => kind)).size === snapshots.length,
    'Captured workspace context must have unique kinds',
  );
export type CapturedWorkspaceContext = z.infer<typeof capturedWorkspaceContextSchema>;

/** Whether the captured kinds are exactly the requested kinds, in order. */
export function workspaceContextMatches(
  requested: readonly ExecutionContext[],
  captured: CapturedWorkspaceContext,
): boolean {
  return (
    requested.length === captured.snapshots.length &&
    requested.every(({ kind }, index) => kind === captured.snapshots[index]?.kind)
  );
}

export function workspaceContextSummaries(
  context: CapturedWorkspaceContext,
): readonly ExecutionContextSummary[] {
  return context.snapshots.map(({ kind, capturedAt, byteLength, truncated }) => ({
    kind,
    capturedAt,
    byteLength,
    truncated,
  }));
}
