import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  mcpIssueSchema,
  mcpManagementSnapshotSchema,
  mcpMutationResultSchema,
  type McpManagementSnapshot,
  type McpMutationResult,
  type McpServerConfig,
} from './mcp-types.js';
export class McpApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'McpApiError';
  }
}
const errorSchema = z.object({ error: mcpIssueSchema });
function isAbort(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    signal?.aborted === true ||
    (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError')
  );
}
async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), init);
  } catch (error) {
    if (isAbort(error, init.signal)) throw error;
    throw new McpApiError('mcp-network', '无法连接到本地服务', 0);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (isAbort(error, init.signal)) throw error;
  }
  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw parsed.success
      ? new McpApiError(parsed.data.error.code, parsed.data.error.message, response.status)
      : new McpApiError('mcp-request-failed', 'MCP 请求失败', response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success)
    throw new McpApiError('mcp-invalid-response', 'MCP 响应的格式不正确', response.status);
  return parsed.data;
}
function write(
  path: string,
  body: object,
  signal?: AbortSignal,
  method = 'POST',
): Promise<McpMutationResult> {
  return request(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    },
    mcpMutationResultSchema,
  );
}
const serverPath = (id: string) => `/mcp/servers/${encodeURIComponent(id)}`;
export function fetchMcpCatalog(signal?: AbortSignal): Promise<McpManagementSnapshot> {
  return request(
    '/mcp',
    { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    mcpManagementSnapshotSchema,
  );
}
export function configureMcpServer(
  expectedSequence: number,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<McpMutationResult> {
  return write('/mcp/servers', { expectedSequence, config }, signal);
}
export function updateMcpServer(
  id: string,
  expectedSequence: number,
  config: McpServerConfig,
  signal?: AbortSignal,
): Promise<McpMutationResult> {
  return write(serverPath(id), { expectedSequence, config }, signal, 'PUT');
}
export function trustMcpServer(
  id: string,
  expectedSequence: number,
  configDigest: string,
  signal?: AbortSignal,
): Promise<McpMutationResult> {
  return write(`${serverPath(id)}/trust`, { expectedSequence, configDigest }, signal);
}
export function enableMcpServer(
  id: string,
  expectedSequence: number,
  configDigest: string,
  signal?: AbortSignal,
): Promise<McpMutationResult> {
  return write(`${serverPath(id)}/enable`, { expectedSequence, configDigest }, signal);
}
export interface McpDecisionOptions {
  readonly immediate?: boolean;
  readonly signal?: AbortSignal;
}
function decision(
  operation: string,
  id: string,
  expectedSequence: number,
  options: McpDecisionOptions,
): Promise<McpMutationResult> {
  return write(
    `${serverPath(id)}/${operation}`,
    {
      expectedSequence,
      ...(options.immediate === undefined ? {} : { immediate: options.immediate }),
    },
    options.signal,
  );
}
export function disableMcpServer(
  id: string,
  expectedSequence: number,
  options: McpDecisionOptions = {},
): Promise<McpMutationResult> {
  return decision('disable', id, expectedSequence, options);
}
export function revokeMcpServer(
  id: string,
  expectedSequence: number,
  options: McpDecisionOptions = {},
): Promise<McpMutationResult> {
  return decision('revoke', id, expectedSequence, options);
}
export function removeMcpServer(
  id: string,
  expectedSequence: number,
  options: McpDecisionOptions = {},
): Promise<McpMutationResult> {
  return decision('remove', id, expectedSequence, options);
}
export function reloadMcpServers(
  expectedSequence: number,
  signal?: AbortSignal,
): Promise<McpMutationResult> {
  return write('/mcp/reload', { expectedSequence }, signal);
}
