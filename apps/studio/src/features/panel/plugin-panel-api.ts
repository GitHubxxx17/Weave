import type { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  panelCatalogSchema,
  panelDataSchema,
  preparedCommandSchema,
  panelErrorSchema,
  prepareRequestSchema,
  type PanelCatalog,
  type PanelData,
  type PrepareRequest,
  type PreparedCommand,
} from './plugin-panel-types.js';
export class PanelApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PanelApiError';
  }
}
function invalid(status: number): PanelApiError {
  return new PanelApiError('panel-invalid-response', '面板响应格式无效或超过大小限制', status);
}
async function boundedJson(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) throw invalid(response.status);
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > limit) {
        void reader.cancel().catch(() => undefined);
        throw invalid(response.status);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(count);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (signal.aborted) throw error;
    throw invalid(response.status);
  } finally {
    reader.releaseLock();
  }
}
async function request<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
  limit: number,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), { ...init, signal, cache: 'no-store' });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new PanelApiError('panel-network', '无法连接到本地面板服务', 0);
  }
  signal.throwIfAborted();
  const payload = await boundedJson(response, response.ok ? limit : 1024, signal);
  signal.throwIfAborted();
  if (!response.ok) {
    const error = panelErrorSchema.safeParse(payload);
    if (!error.success) throw invalid(response.status);
    throw new PanelApiError(error.data.error.code, error.data.error.message, response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalid(response.status);
  return parsed.data;
}
export function fetchPanelCatalog(signal: AbortSignal): Promise<PanelCatalog> {
  return request('/plugins/panels', { method: 'GET' }, panelCatalogSchema, 1048576, signal);
}
function sessionPath(sessionId: string, panelRef: string): string {
  if (sessionId.length < 1 || sessionId.length > 128 || !/^[A-Za-z0-9_-]{32}$/.test(panelRef))
    throw new PanelApiError('panel-invalid-input', '面板请求参数无效', 400);
  return `/sessions/${encodeURIComponent(sessionId)}/plugin-panels/${encodeURIComponent(panelRef)}`;
}
export async function fetchPanelData(
  sessionId: string,
  panelRef: string,
  signal: AbortSignal,
): Promise<PanelData> {
  const data = await request(
    sessionPath(sessionId, panelRef),
    { method: 'GET' },
    panelDataSchema,
    65536,
    signal,
  );
  if (data.sessionId !== sessionId || data.panelRef !== panelRef) throw invalid(200);
  return data;
}
export async function preparePanelCommand(
  sessionId: string,
  panelRef: string,
  input: PrepareRequest,
  signal: AbortSignal,
): Promise<PreparedCommand> {
  const parsed = prepareRequestSchema.safeParse(input);
  if (!parsed.success) throw new PanelApiError('panel-invalid-input', '表单数据无效', 400);
  const body = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(body).byteLength > 16384)
    throw new PanelApiError('panel-request-too-large', '表单数据过大', 413);
  const result = await request(
    `${sessionPath(sessionId, panelRef)}/prepare-command`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
    preparedCommandSchema,
    262144,
    signal,
  );
  if (
    result.sessionId !== sessionId ||
    result.panelRef !== panelRef ||
    result.formId !== input.formId
  )
    throw invalid(200);
  return result;
}
