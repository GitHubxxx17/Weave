import { z } from 'zod';

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;
const wellFormed = (value: string): boolean =>
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
function boundedText(points: number, bytes: number, body = false, empty = false) {
  return z.string().refine(
    (value) =>
      (empty || value.length > 0) &&
      wellFormed(value) &&
      [...value].length <= points &&
      utf8Length(value) <= bytes &&
      ![...value].some((point) => {
        const code = point.codePointAt(0)!;
        return code === 127 || (code < 32 && !(body && (code === 9 || code === 10 || code === 13)));
      }),
    'Text exceeds the Unicode/UTF-8 limit or contains unsupported characters',
  );
}
export const memoryIdSchema = z.string().uuid();
export const memoryDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const memoryRevisionSchema = z.number().int().positive().safe();
export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project'), projectId: memoryIdSchema }),
  z.strictObject({ kind: z.literal('user') }),
]);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memoryRefSchema = z.strictObject({
  memoryId: memoryIdSchema,
  revision: memoryRevisionSchema,
  sha256: memoryDigestSchema,
  scope: memoryScopeSchema,
});
export type MemoryRef = z.infer<typeof memoryRefSchema>;
export const memoryReviewSchema = z.enum(['user-reviewed', 'agent-authored']);
export type MemoryReview = z.infer<typeof memoryReviewSchema>;
export function normalizeMemoryText(value: string): string {
  return value.normalize('NFKC').toLowerCase();
}
export const memoryTagsSchema = z
  .array(boundedText(40, 160))
  .max(12)
  .transform((tags) => {
    const unique = new Map<string, string>();
    for (const tag of tags) {
      const key = normalizeMemoryText(tag);
      if (!unique.has(key)) unique.set(key, tag);
    }
    return [...unique]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, display]) => display);
  });
export const memoryContentSchema = z.strictObject({
  title: boundedText(160, 640),
  content: boundedText(8192, 8192, true),
  tags: memoryTagsSchema,
});
export type MemoryContent = z.infer<typeof memoryContentSchema>;
const hostId = boundedText(240, 960);
export const memoryProvenanceSchema = z.discriminatedUnion('actor', [
  z.strictObject({ actor: z.literal('local-user') }),
  z.strictObject({
    actor: z.literal('agent'),
    sessionId: hostId,
    executionId: hostId,
    turnId: hostId,
    toolCallId: hostId,
    lineage: z
      .strictObject({
        taskId: hostId,
        rootSessionId: hostId,
        parentSessionId: hostId,
        childSessionId: hostId,
      })
      .optional(),
  }),
]);
export type MemoryProvenance = z.infer<typeof memoryProvenanceSchema>;
export const memoryCurrentSchema = memoryContentSchema
  .extend({
    ref: memoryRefSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    provenance: memoryProvenanceSchema,
    review: memoryReviewSchema,
  })
  .strict();
export type MemoryCurrent = z.infer<typeof memoryCurrentSchema>;
export const memoryAccessLevelSchema = z.enum(['disabled', 'read-only', 'read-write']);
export type MemoryAccessLevel = z.infer<typeof memoryAccessLevelSchema>;
export const memoryAccessSchema = z.strictObject({
  scope: memoryScopeSchema,
  level: memoryAccessLevelSchema,
  settingRevision: z.number().int().nonnegative().safe(),
});
export type MemoryAccess = z.infer<typeof memoryAccessSchema>;
export const memorySubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('record'),
    scope: memoryScopeSchema,
    memoryId: memoryIdSchema,
    revision: memoryRevisionSchema,
  }),
  z.strictObject({
    kind: z.literal('scope-access'),
    scope: memoryScopeSchema,
    settingRevision: memoryRevisionSchema,
  }),
]);
export type MemorySubject = z.infer<typeof memorySubjectSchema>;
export const memoryOperationSchema = z.enum(['create', 'revise', 'review', 'remove', 'setAccess']);
export type MemoryOperation = z.infer<typeof memoryOperationSchema>;
export const memoryTombstoneSchema = z.strictObject({
  memoryId: memoryIdSchema,
  revision: memoryRevisionSchema,
  deleted: z.literal(true),
});
export type MemoryTombstone = z.infer<typeof memoryTombstoneSchema>;
export const memoryReceiptSchema = z
  .strictObject({
    requestId: memoryIdSchema,
    operation: memoryOperationSchema,
    sequence: memoryRevisionSchema,
    subject: memorySubjectSchema,
    result: z.union([memoryRefSchema, memoryTombstoneSchema, memoryAccessSchema]),
  })
  .superRefine((receipt, ctx) => {
    const valid =
      receipt.operation === 'setAccess'
        ? 'level' in receipt.result && receipt.subject.kind === 'scope-access'
        : receipt.operation === 'remove'
          ? 'deleted' in receipt.result && receipt.subject.kind === 'record'
          : 'sha256' in receipt.result && receipt.subject.kind === 'record';
    const result = receipt.result;
    const subject = receipt.subject;
    const agrees =
      subject.kind === 'record'
        ? 'memoryId' in result &&
          result.memoryId === subject.memoryId &&
          result.revision === subject.revision &&
          (!('scope' in result) || JSON.stringify(result.scope) === JSON.stringify(subject.scope))
        : 'settingRevision' in result &&
          result.settingRevision === subject.settingRevision &&
          JSON.stringify(result.scope) === JSON.stringify(subject.scope);
    if (!valid || !agrees)
      ctx.addIssue({
        code: 'custom',
        message: 'Receipt result must match its operation and subject',
      });
  });
export type MemoryReceipt = z.infer<typeof memoryReceiptSchema>;
const recordFields = {
  requestId: memoryIdSchema,
  title: boundedText(160, 640),
  content: boundedText(8192, 8192, true),
  tags: memoryTagsSchema,
};
export const memoryRecordInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    ...recordFields,
    operation: z.literal('create'),
    expectedRevision: z.literal(0),
  }),
  z.strictObject({
    ...recordFields,
    operation: z.literal('revise'),
    memoryId: memoryIdSchema,
    expectedRevision: memoryRevisionSchema,
  }),
]);
export type MemoryRecordInput = z.infer<typeof memoryRecordInputSchema>;
export const memoryQuerySchema = z.strictObject({
  query: boundedText(512, 2048, false, true).optional(),
  limit: z.number().int().min(1).max(50).default(50),
  cursor: z.string().min(1).max(2048).optional(),
  tag: boundedText(40, 160).optional(),
  includeAgentAuthored: z.boolean().optional(),
});
export type MemoryQuery = z.infer<typeof memoryQuerySchema>;
export const memorySummarySchema = z.strictObject({
  ref: memoryRefSchema,
  title: boundedText(160, 640),
  tags: memoryTagsSchema,
  excerpt: boundedText(512, 512, true, true),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  provenance: memoryProvenanceSchema,
  review: memoryReviewSchema,
});
export type MemorySummary = z.infer<typeof memorySummarySchema>;
export const memoryHistoryEntrySchema = z.strictObject({
  sequence: memoryRevisionSchema,
  subject: memorySubjectSchema,
  kind: z.enum(['created', 'revised', 'reviewed', 'deleted', 'access-changed']),
  occurredAt: z.iso.datetime(),
  provenance: memoryProvenanceSchema,
  ref: memoryRefSchema.optional(),
  review: memoryReviewSchema.optional(),
});
export type MemoryHistoryEntry = z.infer<typeof memoryHistoryEntrySchema>;
export const memoryErrorCodeSchema = z.enum([
  'memory-disabled',
  'memory-read-only',
  'memory-not-found',
  'memory-stale-revision',
  'memory-stale-cursor',
  'memory-invalid-cursor',
  'memory-request-conflict',
  'memory-project-ambiguous',
  'memory-scope-forbidden',
  'memory-limit',
  'memory-persistence-error',
  'memory-persistence-uncertain',
  'memory-busy',
  'memory-cancelled',
]);
export type MemoryErrorCode = z.infer<typeof memoryErrorCodeSchema>;

export const memoryScopesResponseSchema = z.strictObject({
  scopes: z.array(
    z
      .strictObject({
        scope: memoryScopeSchema,
        name: z.string().min(1),
        access: memoryAccessSchema,
      })
      .refine((value) => memoryScopeKey(value.scope) === memoryScopeKey(value.access.scope)),
  ),
  nextCursor: z.string().min(1).max(2048).optional(),
});
export type MemoryScopesPage = z.infer<typeof memoryScopesResponseSchema>;
export type MemoryScopeDescriptor = z.infer<typeof memoryScopesResponseSchema>['scopes'][number];
export const memoryPageSchema = z.strictObject({
  records: z.array(memorySummarySchema).max(50),
  nextCursor: z.string().min(1).max(2048).optional(),
});
export type MemoryPageResult = z.infer<typeof memoryPageSchema>;
export const memoryHistoryPageSchema = z.strictObject({
  entries: z.array(memoryHistoryEntrySchema).max(20),
  nextCursor: z.string().min(1).max(2048).optional(),
});
export type MemoryHistoryPage = z.infer<typeof memoryHistoryPageSchema>;
export function memoryScopeKey(scope: MemoryScope): string {
  return scope.kind === 'user' ? 'user' : `project:${scope.projectId}`;
}
export function sameMemoryRef(a: MemoryRef, b: MemoryRef): boolean {
  return (
    a.memoryId === b.memoryId &&
    a.revision === b.revision &&
    a.sha256 === b.sha256 &&
    memoryScopeKey(a.scope) === memoryScopeKey(b.scope)
  );
}
