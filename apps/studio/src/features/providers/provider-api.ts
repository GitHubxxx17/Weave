import { z } from 'zod';

import { providerSettingsSchema, type ProviderSettings } from './provider-types.js';

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

async function requestJson<T>(input: RequestInfo | URL, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { method: 'GET' });
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

/** Browser client for the Server-owned Provider metadata API. */
export interface ProviderApi {
  listProviders(): Promise<ProviderSettings>;
}

/** Creates the default HTTP-backed Provider API client. */
export function createProviderApi(): ProviderApi {
  return {
    listProviders() {
      return requestJson('/settings/providers', providerSettingsSchema);
    },
  };
}
