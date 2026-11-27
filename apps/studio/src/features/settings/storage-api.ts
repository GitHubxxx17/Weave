import { z } from 'zod';

import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** A stable failure raised by the browser-side storage settings client. */
export class StorageApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StorageApiError';
    this.code = code;
    this.status = status;
  }
}

const storageLocationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  path: z.string().min(1),
  exists: z.boolean(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  error: z.enum(['permission-denied', 'read-failed', 'kind-mismatch']).optional(),
});

const storageSettingsSchema = z.object({
  dataDirectory: z.string().min(1),
  locations: z.array(storageLocationSchema),
});

const errorPayloadSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});

export type StorageLocation = z.infer<typeof storageLocationSchema>;
export type StorageSettings = z.infer<typeof storageSettingsSchema>;

/** Reads `GET /settings/storage`; resolves to validated data or throws {@link StorageApiError}. */
export async function fetchStorageSettings(signal?: AbortSignal): Promise<StorageSettings> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl('/settings/storage'), signal ? { signal } : {});
  } catch (error: unknown) {
    if (signal?.aborted === true) throw error;
    throw new StorageApiError('storage-api-network', '无法连接到本地服务', 0, { cause: error });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    throw new StorageApiError('storage-api-protocol', '本地服务返回了无效响应', response.status, {
      cause: error,
    });
  }
  if (!response.ok) {
    const parsedError = errorPayloadSchema.safeParse(payload);
    if (parsedError.success) {
      throw new StorageApiError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        response.status,
      );
    }
    throw new StorageApiError('storage-api-protocol', '本地服务错误响应格式无效', response.status);
  }
  const parsed = storageSettingsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new StorageApiError(
      'storage-api-protocol',
      '本地服务返回的数据格式无效',
      response.status,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
