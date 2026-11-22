import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
const id = z.string().min(1);
export const undoFileResultSchema = z.object({
  path: id,
  status: z.enum(['restored', 'already-restored', 'conflict', 'failed', 'unavailable']),
  reason: id,
});
const operationSchema = z.object({
  projectId: id,
  turnId: id,
  operationId: id,
  requestId: id,
  results: z.array(undoFileResultSchema),
});
export const fileUndoReviewSchema = z.object({
  turnId: id,
  files: z.array(
    z.object({
      path: id,
      existedBefore: z.boolean(),
      previousContent: z.string(),
      afterContent: z.string().optional(),
      unavailableReason: id.optional(),
    }),
  ),
  operation: operationSchema.extend({ status: z.enum(['pending', 'completed']) }).optional(),
});
export type FileUndoReview = z.infer<typeof fileUndoReviewSchema>;
export type UndoFileResult = z.infer<typeof undoFileResultSchema>;
export interface UndoRequest {
  readonly turnId: string;
  readonly operationId: string;
  readonly requestId: string;
}
async function request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(runtimeApiUrl(path), init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.object({ message: z.string() }) }).safeParse(payload);
    throw new Error(error.success ? error.data.error.message : '文件撤销请求失败');
  }
  const result = schema.safeParse(payload);
  if (!result.success) throw new Error('文件撤销响应格式不正确');
  return result.data;
}
function base(projectId: string, sessionId: string) {
  return `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}
export function fetchTurnFileReview(projectId: string, sessionId: string, turnId: string) {
  return request(
    `${base(projectId, sessionId)}/file-undo?turnId=${encodeURIComponent(turnId)}`,
    fileUndoReviewSchema,
  );
}
export function undoTurnFiles(projectId: string, sessionId: string, input: UndoRequest) {
  return request(`${base(projectId, sessionId)}/undo`, operationSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}
