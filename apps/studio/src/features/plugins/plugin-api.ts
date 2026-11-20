import { z } from 'zod';

import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  pluginCatalogSchema,
  pluginIssueSchema,
  pluginMutationResponseSchema,
  type PluginCatalog,
  type PluginListItem,
  type PluginMutationResponse,
} from './plugin-types.js';

/** A typed failure from the Studio plugin client. */
export class PluginApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PluginApiError';
  }
}

export interface PluginDecisionOptions {
  readonly immediate?: boolean;
  readonly signal?: AbortSignal;
}

const errorResponseSchema = z.object({ error: pluginIssueSchema });

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
  );
}

async function requestPlugin<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), init);
  } catch (error: unknown) {
    if (isAbort(error, init.signal ?? undefined)) {
      throw error;
    }
    throw new PluginApiError('plugin-network', '无法连接到本地服务', 0);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    if (isAbort(error, init.signal ?? undefined)) {
      throw error;
    }
  }
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(payload);
    throw parsedError.success
      ? new PluginApiError(
          parsedError.data.error.code,
          parsedError.data.error.message,
          response.status,
        )
      : new PluginApiError('plugin-request-failed', '插件请求失败', response.status);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PluginApiError('plugin-invalid-response', '插件响应的格式不正确', response.status);
  }
  return parsed.data;
}

export function fetchPluginCatalog(signal?: AbortSignal): Promise<PluginCatalog> {
  return requestPlugin(
    '/plugins',
    { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    pluginCatalogSchema,
  );
}

/** Compatibility for readers that only need plugin rows. */
export async function fetchPlugins(signal?: AbortSignal): Promise<readonly PluginListItem[]> {
  return (await fetchPluginCatalog(signal)).plugins;
}

function writePlugin(
  path: string,
  method: 'POST' | 'DELETE',
  body: object,
  signal?: AbortSignal,
): Promise<PluginMutationResponse> {
  return requestPlugin(
    path,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    },
    pluginMutationResponseSchema,
  );
}

export function reloadPlugins(signal?: AbortSignal): Promise<PluginMutationResponse> {
  return writePlugin('/plugins/reload', 'POST', {}, signal);
}

export function trustPlugin(
  id: string,
  digest: string,
  signal?: AbortSignal,
): Promise<PluginMutationResponse> {
  return writePlugin(`/plugins/${encodeURIComponent(id)}/trust`, 'POST', { digest }, signal);
}

export function setPluginEnabled(
  id: string,
  enabled: boolean,
  options: PluginDecisionOptions = {},
): Promise<PluginMutationResponse> {
  if (enabled && options.immediate === true) {
    return Promise.reject(
      new PluginApiError('plugin-invalid-request', '启用插件不支持立即生效选项', 0),
    );
  }
  const query = options.immediate === true ? '?immediate=true' : '';
  return writePlugin(
    `/plugins/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}${query}`,
    'POST',
    {},
    options.signal,
  );
}

export function revokePluginTrust(
  id: string,
  options: PluginDecisionOptions = {},
): Promise<PluginMutationResponse> {
  const query = options.immediate === true ? '?immediate=true' : '';
  return writePlugin(
    `/plugins/${encodeURIComponent(id)}/trust${query}`,
    'DELETE',
    {},
    options.signal,
  );
}
