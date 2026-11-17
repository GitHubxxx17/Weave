import { z } from 'zod';

import {
  providerSettingsSchema,
  providerDescriptorSchema,
  type ProviderSettings,
  type ProviderSettingsInput,
  type ProviderSettingsPatch,
  type ProviderDescriptor,
} from './provider-types.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** A stable failure raised by the browser-side Provider API client. */
export class ProviderApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProviderApiError';
    this.code = code;
    this.status = status;
  }
}

const errorPayloadSchema = z.object({
  error: z.object({
    code: z.string().trim().min(1),
    message: z.string().trim().min(1),
  }),
});

const providerResponseSchema = z.object({ provider: providerDescriptorSchema }).strict();
const emptyResponseSchema = z.object({}).strict();

async function requestJson<T>(path: string, init: RequestInit, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), init);
  } catch (error: unknown) {
    throw new ProviderApiError('provider-api-network', '无法连接到本地服务', 0, {
      cause: error,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error: unknown) {
    throw new ProviderApiError('provider-api-protocol', '本地服务返回了无效响应', response.status, {
      cause: error,
    });
  }

  if (!response.ok) {
    const parsedError = errorPayloadSchema.safeParse(payload);
    if (parsedError.success) {
      throw new ProviderApiError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        response.status,
      );
    }
    throw new ProviderApiError(
      'provider-api-protocol',
      '本地服务错误响应格式无效',
      response.status,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ProviderApiError(
      'provider-api-protocol',
      '本地服务返回的数据格式无效',
      response.status,
      { cause: parsed.error },
    );
  }

  return parsed.data;
}

async function requestEmpty(path: string, init: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetch(runtimeApiUrl(path), init);
  } catch (error: unknown) {
    throw new ProviderApiError('provider-api-network', '无法连接到本地服务', 0, {
      cause: error,
    });
  }

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error: unknown) {
      throw new ProviderApiError(
        'provider-api-protocol',
        '本地服务返回了无效响应',
        response.status,
        { cause: error },
      );
    }
    const parsedError = errorPayloadSchema.safeParse(payload);
    if (parsedError.success) {
      throw new ProviderApiError(
        parsedError.data.error.code,
        parsedError.data.error.message,
        response.status,
      );
    }
    throw new ProviderApiError(
      'provider-api-protocol',
      '本地服务错误响应格式无效',
      response.status,
    );
  }

  if (response.status !== 204) {
    try {
      const payload = await response.json();
      const parsed = emptyResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw parsed.error;
      }
    } catch (error: unknown) {
      throw new ProviderApiError(
        'provider-api-protocol',
        '本地服务返回了无效响应',
        response.status,
        { cause: error },
      );
    }
  }
}

function jsonRequest(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** Browser client for the Server-owned Provider metadata API. */
export interface ProviderApi {
  listProviders(): Promise<ProviderSettings>;
  createProvider(input: ProviderSettingsInput): Promise<ProviderDescriptor>;
  updateProvider(id: string, input: ProviderSettingsPatch): Promise<ProviderDescriptor>;
  deleteProvider(id: string): Promise<void>;
  setDefaultProvider(id: string): Promise<ProviderSettings>;
}

/** Creates the default HTTP-backed Provider API client. */
export function createProviderApi(): ProviderApi {
  return {
    listProviders() {
      return requestJson('/settings/providers', { method: 'GET' }, providerSettingsSchema);
    },

    createProvider(input) {
      return requestJson(
        '/settings/providers',
        jsonRequest('POST', input),
        providerResponseSchema,
      ).then((response) => response.provider);
    },

    updateProvider(id, input) {
      return requestJson(
        `/settings/providers/${encodeURIComponent(id)}`,
        jsonRequest('PATCH', input),
        providerResponseSchema,
      ).then((response) => response.provider);
    },

    deleteProvider(id) {
      return requestEmpty(`/settings/providers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },

    setDefaultProvider(id) {
      return requestJson(
        `/settings/providers/${encodeURIComponent(id)}/default`,
        { method: 'POST' },
        providerSettingsSchema,
      );
    },
  };
}
