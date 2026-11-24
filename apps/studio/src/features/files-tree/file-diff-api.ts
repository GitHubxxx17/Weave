import { z } from 'zod';

import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { FileTreeApiError } from './file-tree-api.js';

const fileDiffSchema = z.object({
  path: z.string(),
  oldContent: z.string(),
  newContent: z.string(),
  /** True when the working-tree content differs from the Git base. */
  changed: z.boolean(),
  /** False when the base ref has no such file (new/untracked, or a non-Git folder). */
  tracked: z.boolean(),
});

/** Single-file diff payload returned by `GET /projects/:id/file-diff`. */
export type FileDiff = z.infer<typeof fileDiffSchema>;

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

/**
 * Fetches one file's current content against its Git base (`HEAD`) for the
 * "改动" view. Reuses {@link FileTreeApiError} so the viewer can surface the
 * Server's error code. The browser never touches the filesystem or Git.
 */
export async function fetchFileDiff(
  projectId: string,
  filePath: string,
  options?: { readonly signal?: AbortSignal },
): Promise<FileDiff> {
  const url = runtimeApiUrl(
    `/projects/${encodeURIComponent(projectId)}/file-diff?path=${encodeURIComponent(filePath)}`,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    if (options?.signal?.aborted) throw cause;
    throw new FileTreeApiError('file-diff-network', '无法连接到本地服务', 0);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new FileTreeApiError(
      parsed.success ? parsed.data.error.code : 'file-diff-failed',
      parsed.success ? parsed.data.error.message : '请求失败',
      response.status,
    );
  }
  const result = fileDiffSchema.safeParse(payload);
  if (!result.success) {
    throw new FileTreeApiError('file-diff-invalid', '响应格式不正确', response.status);
  }
  return result.data;
}
