import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { pluginListSchema, type PluginListItem } from './plugin-types.js';

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

/** Loads the plugins loaded for the Agent the Server is running (`GET /plugins`). */
export async function fetchPlugins(signal?: AbortSignal): Promise<readonly PluginListItem[]> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl('/plugins'), {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error: unknown) {
    if (signal?.aborted === true) {
      throw error;
    }
    throw new PluginApiError('plugin-network', '无法连接到本地服务', 0);
  }
  if (!response.ok) {
    throw new PluginApiError('plugin-request-failed', '读取插件列表失败', response.status);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  const parsed = pluginListSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PluginApiError(
      'plugin-invalid-response',
      '插件列表的响应格式不正确',
      response.status,
    );
  }
  return parsed.data.plugins;
}
