import { z } from 'zod';

const id = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const fileCaptureIdentitySchema = z.object({
  snapshotId: id,
  turnId: id,
  toolCallId: id,
  rootIdentity: id,
});
export const fileWriteIntentPayloadSchema = fileCaptureIdentitySchema.extend({ path: id });
export const fileWritePayloadSchema = fileCaptureIdentitySchema
  .extend({
    path: id,
    status: z.enum(['succeeded', 'failed']),
    captureStatus: z.enum(['captured', 'unavailable']),
    reason: id.optional(),
    afterContent: z.string().max(1_000_000).optional(),
    afterDigest: digest.optional(),
    fileIdentity: id.optional(),
  })
  .refine(
    (value) =>
      value.status !== 'succeeded' ||
      (value.afterContent !== undefined &&
        value.afterDigest !== undefined &&
        value.fileIdentity !== undefined),
    'Successful writes require after evidence',
  );
export const fileUndoResultSchema = z.object({
  path: id,
  status: z.enum(['restored', 'already-restored', 'conflict', 'failed', 'unavailable']),
  reason: id,
});
export const fileUndoRequestSchema = z.object({
  projectId: id,
  turnId: id,
  operationId: id,
  requestId: id,
});
export const fileUndoStartedPayloadSchema = fileUndoRequestSchema.extend({ rootIdentity: id });
export const fileUndoFilePayloadSchema = fileUndoRequestSchema.extend({
  result: fileUndoResultSchema,
});
export const fileUndoCompletedPayloadSchema = fileUndoRequestSchema.extend({
  results: z.array(fileUndoResultSchema),
});
export type FileUndoResult = z.infer<typeof fileUndoResultSchema>;
