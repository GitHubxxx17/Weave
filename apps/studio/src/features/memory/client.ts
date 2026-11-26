import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  memoryAccessLevelSchema,
  memoryAccessSchema,
  memoryCurrentSchema,
  memoryHistoryPageSchema,
  memoryIdSchema,
  memoryPageSchema,
  memoryQuerySchema,
  memoryReceiptSchema,
  memoryRecordInputSchema,
  memoryRefSchema,
  memoryRevisionSchema,
  memoryScopeKey,
  memoryScopeSchema,
  memoryScopesResponseSchema,
  sameMemoryRef,
  type MemoryAccess,
  type MemoryAccessLevel,
  type MemoryCurrent,
  type MemoryHistoryPage,
  type MemoryPageResult,
  type MemoryQuery,
  type MemoryReceipt,
  type MemoryRecordInput,
  type MemoryRef,
  type MemoryScope,
  type MemoryScopesPage,
} from './types.js';

export class MemoryApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MemoryApiError';
  }
}
const errors = z.strictObject({
  error: z.strictObject({ code: z.string().min(1).max(100), message: z.string().min(1).max(512) }),
});
const receiptResponse = z.strictObject({ receipt: memoryReceiptSchema });
function protocol(): never {
  throw new MemoryApiError('memory-api-protocol', '本地服务返回的记忆数据无效', 0);
}
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), {
      method: body === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MemoryApiError('memory-api-network', '无法连接本地记忆服务，可以重试同一操作', 0);
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return protocol();
  }
  if (!response.ok) {
    const parsed = errors.safeParse(value);
    if (!parsed.success) return protocol();
    throw new MemoryApiError(
      parsed.data.error.code,
      response.status === 409
        ? '记忆版本已变更。草稿已保留，请先重新加载当前版本。'
        : parsed.data.error.message,
      response.status,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return protocol();
  return parsed.data;
}
function scopeQuery(scope: MemoryScope): URLSearchParams {
  const parsed = memoryScopeSchema.parse(scope);
  return new URLSearchParams(
    parsed.kind === 'user' ? { scope: 'user' } : { scope: 'project', projectId: parsed.projectId },
  );
}
function path(scope: MemoryScope, suffix: string, query: Record<string, unknown> = {}): string {
  const params = scopeQuery(scope);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  return `/memory/${suffix}?${params}`;
}
function recordPath(memoryId: string): string {
  return `records/${encodeURIComponent(memoryIdSchema.parse(memoryId))}`;
}
function sameScope(scope: MemoryScope, actual: MemoryScope): boolean {
  return memoryScopeKey(scope) === memoryScopeKey(actual);
}
function assertReceipt(scope: MemoryScope, receipt: MemoryReceipt): MemoryReceipt {
  if (!sameScope(scope, receipt.subject.scope)) protocol();
  return receipt;
}
export interface MemoryClient {
  scopes(cursor?: string, signal?: AbortSignal): Promise<MemoryScopesPage>;
  access(scope: MemoryScope, signal?: AbortSignal): Promise<MemoryAccess>;
  setAccess(
    scope: MemoryScope,
    input: { requestId: string; level: MemoryAccessLevel; expectedSettingRevision: number },
    signal?: AbortSignal,
  ): Promise<MemoryReceipt>;
  list(
    scope: MemoryScope,
    query: Partial<MemoryQuery>,
    signal?: AbortSignal,
  ): Promise<MemoryPageResult>;
  read(
    scope: MemoryScope,
    memoryId: string,
    ref?: MemoryRef,
    signal?: AbortSignal,
  ): Promise<MemoryCurrent>;
  history(
    scope: MemoryScope,
    memoryId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<MemoryHistoryPage>;
  save(scope: MemoryScope, input: MemoryRecordInput, signal?: AbortSignal): Promise<MemoryReceipt>;
  review(
    scope: MemoryScope,
    input: { requestId: string; targetRef: MemoryRef },
    signal?: AbortSignal,
  ): Promise<MemoryReceipt>;
  remove(
    scope: MemoryScope,
    input: { requestId: string; memoryId: string; expectedRevision: number; reason?: string },
    signal?: AbortSignal,
  ): Promise<MemoryReceipt>;
}
/** Browser-only DTO validators mirror the guarded HTTP contract without workspace imports. */
export function createMemoryClient(): MemoryClient {
  return {
    async scopes(cursor, signal) {
      const query = new URLSearchParams(cursor === undefined ? {} : { cursor });
      return request(
        query.size === 0 ? '/memory/scopes' : `/memory/scopes?${query}`,
        memoryScopesResponseSchema,
        signal,
      );
    },
    async access(scope, signal) {
      const { access } = await request(
        path(scope, 'access'),
        z.strictObject({ access: memoryAccessSchema }),
        signal,
      );
      if (!sameScope(scope, access.scope)) protocol();
      return access;
    },
    async setAccess(scope, input, signal) {
      const parsed = z
        .strictObject({
          requestId: memoryIdSchema,
          level: memoryAccessLevelSchema,
          expectedSettingRevision: z.number().int().nonnegative().safe(),
        })
        .parse(input);
      const { receipt } = await request('/memory/access', receiptResponse, signal, {
        scope: memoryScopeSchema.parse(scope),
        ...parsed,
      });
      if (
        receipt.operation !== 'setAccess' ||
        receipt.requestId !== parsed.requestId ||
        !('level' in receipt.result) ||
        receipt.result.level !== parsed.level ||
        receipt.result.settingRevision !== parsed.expectedSettingRevision + 1
      )
        protocol();
      return assertReceipt(scope, receipt);
    },
    async list(scope, raw, signal) {
      const query = memoryQuerySchema.parse(raw);
      const page = await request(path(scope, 'records', query), memoryPageSchema, signal);
      if (page.records.some((item) => !sameScope(scope, item.ref.scope))) protocol();
      return page;
    },
    async read(scope, memoryId, rawRef, signal) {
      const ref = rawRef === undefined ? undefined : memoryRefSchema.parse(rawRef);
      if (ref !== undefined && (!sameScope(scope, ref.scope) || ref.memoryId !== memoryId))
        protocol();
      const { record } = await request(
        path(
          scope,
          recordPath(memoryId),
          ref === undefined ? {} : { revision: ref.revision, sha256: ref.sha256 },
        ),
        z.strictObject({ record: memoryCurrentSchema }),
        signal,
      );
      if (
        !sameScope(scope, record.ref.scope) ||
        record.ref.memoryId !== memoryId ||
        (ref !== undefined && !sameMemoryRef(ref, record.ref))
      )
        protocol();
      return record;
    },
    async history(scope, memoryId, cursor, signal) {
      const page = await request(
        path(scope, recordPath(memoryId) + '/history', { limit: 20, cursor }),
        memoryHistoryPageSchema,
        signal,
      );
      if (
        page.entries.some(
          (item) =>
            !sameScope(scope, item.subject.scope) ||
            item.subject.kind !== 'record' ||
            item.subject.memoryId !== memoryId ||
            (item.ref !== undefined &&
              (!sameScope(scope, item.ref.scope) || item.ref.memoryId !== memoryId)),
        )
      )
        protocol();
      return page;
    },
    async save(scope, raw, signal) {
      const input = memoryRecordInputSchema.parse(raw);
      const { receipt } = await request('/memory/records', receiptResponse, signal, {
        scope: memoryScopeSchema.parse(scope),
        ...input,
      });
      if (
        receipt.operation !== input.operation ||
        receipt.requestId !== input.requestId ||
        (input.operation === 'revise' &&
          receipt.subject.kind === 'record' &&
          receipt.subject.memoryId !== input.memoryId)
      )
        protocol();
      return assertReceipt(scope, receipt);
    },
    async review(scope, raw, signal) {
      const input = z
        .strictObject({ requestId: memoryIdSchema, targetRef: memoryRefSchema })
        .parse(raw);
      if (!sameScope(scope, input.targetRef.scope)) protocol();
      const { receipt } = await request(
        '/memory/' + recordPath(input.targetRef.memoryId) + '/review',
        receiptResponse,
        signal,
        { scope, ...input },
      );
      if (
        receipt.operation !== 'review' ||
        receipt.requestId !== input.requestId ||
        !('sha256' in receipt.result) ||
        receipt.result.memoryId !== input.targetRef.memoryId ||
        receipt.result.revision !== input.targetRef.revision + 1 ||
        receipt.result.sha256 !== input.targetRef.sha256
      )
        protocol();
      return assertReceipt(scope, receipt);
    },
    async remove(scope, raw, signal) {
      const { memoryId, ...input } = z
        .strictObject({
          requestId: memoryIdSchema,
          memoryId: memoryIdSchema,
          expectedRevision: memoryRevisionSchema,
          reason: z.string().max(512).optional(),
        })
        .parse(raw);
      const { receipt } = await request(
        '/memory/' + recordPath(memoryId) + '/delete',
        receiptResponse,
        signal,
        { scope: memoryScopeSchema.parse(scope), ...input },
      );
      if (
        receipt.operation !== 'remove' ||
        receipt.requestId !== input.requestId ||
        receipt.subject.kind !== 'record' ||
        receipt.subject.memoryId !== memoryId
      )
        protocol();
      return assertReceipt(scope, receipt);
    },
  };
}
