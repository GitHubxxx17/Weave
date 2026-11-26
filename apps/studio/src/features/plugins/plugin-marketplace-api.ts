import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { PluginApiError } from './plugin-api.js';
import {
  pluginMarketplaceSchema,
  pluginMarketplaceSourcesSchema,
  type PluginMarketplace,
  type PluginMarketplaceSources,
} from './plugin-marketplace-types.js';

const serviceError = z.object({
  error: z.object({ code: z.string().max(200), message: z.string().max(2000) }),
});

async function request<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), init);
  } catch (reason) {
    if (init.signal?.aborted) throw reason;
    throw new PluginApiError('plugin-marketplace-unavailable', '插件市场暂不可用', 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (reason) {
    if (init.signal?.aborted) throw reason;
  }
  if (response.status !== 200) {
    const error = serviceError.safeParse(body);
    throw new PluginApiError(
      error.success ? error.data.error.code : 'plugin-marketplace-unavailable',
      '插件市场请求失败',
      response.status,
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new PluginApiError('plugin-invalid-response', '插件市场响应格式不正确', 200);
  return parsed.data;
}

export function fetchPluginMarketplace(
  signal?: AbortSignal,
  sourceId?: string,
): Promise<PluginMarketplace> {
  return request(
    `/plugins/marketplace${sourceId === undefined ? '' : `?sourceId=${encodeURIComponent(sourceId)}`}`,
    { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    pluginMarketplaceSchema,
  );
}

export function fetchPluginMarketplaceSources(
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return request(
    '/plugins/marketplace/sources',
    { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    pluginMarketplaceSourcesSchema,
  );
}

function mutateSource(
  path: string,
  body: object,
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return request(
    `/plugins/marketplace/${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    },
    pluginMarketplaceSourcesSchema,
  );
}

/** Source list writes carry the revision they were based on; a stale one is answered with 409. */
export function addPluginMarketplaceSource(
  source: { readonly name: string; readonly url: string },
  revision: number,
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return mutateSource('sources/add', { ...source, revision }, signal);
}
export function removePluginMarketplaceSource(
  id: string,
  revision: number,
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return mutateSource('sources/remove', { id, revision }, signal);
}
/** `ids` must list every remote source exactly once, in the new order. */
export function reorderPluginMarketplaceSources(
  ids: readonly string[],
  revision: number,
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return mutateSource('sources/reorder', { ids, revision }, signal);
}
export function refreshPluginMarketplaceSource(
  sourceId: string,
  signal?: AbortSignal,
): Promise<PluginMarketplaceSources> {
  return mutateSource('refresh', { sourceId }, signal);
}
