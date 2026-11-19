import { z } from 'zod';

import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** A typed failure from the Studio file-tree client. */
export class FileTreeApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'FileTreeApiError';
  }
}

const listingSchema = z.object({
  files: z.array(z.string()),
  source: z.enum(['git', 'walk']),
  truncated: z.boolean(),
});

/** Flat listing returned by `GET /projects/:id/tree`. */
export type FileTreeListing = z.infer<typeof listingSchema>;

const contentSchema = z.object({
  path: z.string(),
  content: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
});

/** File content returned by `GET /projects/:id/file`. */
export type FileContent = z.infer<typeof contentSchema>;

const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

async function requestJson<T>(url: string, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'GET' });
  } catch {
    throw new FileTreeApiError('file-tree-network', '无法连接到本地服务', 0);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new FileTreeApiError(
      parsed.success ? parsed.data.error.code : 'file-tree-failed',
      parsed.success ? parsed.data.error.message : '请求失败',
      response.status,
    );
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new FileTreeApiError('file-tree-invalid', '响应格式不正确', response.status);
  }
  return result.data;
}

/** Fetches the project's file listing for the tree. */
export function fetchFileTree(projectId: string): Promise<FileTreeListing> {
  return requestJson(
    runtimeApiUrl(`/projects/${encodeURIComponent(projectId)}/tree`),
    listingSchema,
  );
}

/** Fetches one file's text content for the viewer. */
export function fetchFileContent(projectId: string, filePath: string): Promise<FileContent> {
  return requestJson(
    runtimeApiUrl(
      `/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(filePath)}`,
    ),
    contentSchema,
  );
}
