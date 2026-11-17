import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { LlmProviderRegistry } from '@weave/llm';
import { z } from 'zod';
import {
  createProviderSettingsInputSchema,
  providerSettingsDescriptorSchema,
  updateProviderSettingsInputSchema,
  type ProviderSettingsDescriptor,
} from './provider-settings-types.js';
import {
  ProviderSettingsManagerError,
  type ProviderSettingsManager,
} from './provider-settings-manager.js';

/** Dependencies needed by the public and Desktop Provider settings routes. */
export interface ProviderAppOptions {
  readonly providerRegistry?: LlmProviderRegistry | undefined;
  readonly defaultProvider?: string | undefined;
  readonly providerSettingsManager?: ProviderSettingsManager | undefined;
  readonly canManageProviders?: boolean | undefined;
}

const statusByCode: Record<ProviderSettingsManagerError['code'], number> = {
  'provider-settings-invalid': 400,
  'provider-settings-not-found': 404,
  'provider-settings-duplicate': 409,
  'provider-settings-protected': 409,
  'provider-settings-secret-unavailable': 503,
  'provider-settings-secret-invalid': 503,
  'provider-settings-provider-invalid': 422,
  'provider-settings-storage': 500,
};

function canManage(options: ProviderAppOptions): boolean {
  return options.canManageProviders ?? options.providerSettingsManager !== undefined;
}

function publicDescriptor(
  descriptor: ReturnType<LlmProviderRegistry['list']>[number],
): ProviderSettingsDescriptor {
  return providerSettingsDescriptorSchema.parse({
    ...descriptor,
    hasApiKey: descriptor.type !== 'mock',
    editable: false,
  });
}

function mapManagerError(error: unknown): {
  readonly status: number;
  readonly body: { readonly error: { readonly code: string; readonly message: string } };
} {
  if (error instanceof ProviderSettingsManagerError) {
    return {
      status: statusByCode[error.code],
      body: {
        error: {
          code: error.code,
          message: error.message,
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'provider-settings-storage',
        message: 'Provider 配置服务不可用',
      },
    },
  };
}

async function readJson(context: Context): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    throw new ProviderSettingsManagerError('provider-settings-invalid', '请求体必须是有效 JSON');
  }
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      throw new ProviderSettingsManagerError(
        'provider-settings-invalid',
        'Provider configuration is invalid',
        { cause: error },
      );
    }
    throw error;
  }
}

async function listSettings(options: ProviderAppOptions): Promise<{
  readonly providers: readonly ProviderSettingsDescriptor[];
  readonly defaultProvider: string;
  readonly canManage: boolean;
}> {
  if (options.providerSettingsManager !== undefined) {
    return {
      providers: await options.providerSettingsManager.list(),
      defaultProvider:
        options.providerSettingsManager.getDefaultProvider() ?? options.defaultProvider ?? 'mock',
      canManage: canManage(options),
    };
  }

  if (options.providerRegistry === undefined) {
    throw new ProviderSettingsManagerError(
      'provider-settings-storage',
      'Provider service is not available',
    );
  }

  return {
    providers: options.providerRegistry.list().map(publicDescriptor),
    defaultProvider: options.defaultProvider ?? 'mock',
    canManage: false,
  };
}

async function respondManagerError<T>(
  context: Context,
  operation: () => Promise<T>,
  successStatus = 200,
): Promise<Response> {
  try {
    const value = await operation();
    return context.json(value, successStatus as never);
  } catch (error: unknown) {
    const mapped = mapManagerError(error);
    return context.json(mapped.body, mapped.status as never);
  }
}

/** Mounts Provider metadata and Desktop Provider configuration routes. */
export function registerProviderRoutes(app: Hono, options: ProviderAppOptions): void {
  const manager = options.providerSettingsManager;

  app.get('/settings/providers', async (context) => {
    try {
      return context.json(await listSettings(options));
    } catch (error: unknown) {
      const mapped = mapManagerError(error);
      return context.json(mapped.body, mapped.status as never);
    }
  });

  app.post('/settings/providers', async (context) => {
    if (!canManage(options) || manager === undefined) {
      return context.json(
        {
          error: {
            code: 'provider-settings-desktop-only',
            message: 'Provider 密钥只能在 Desktop 设置中管理',
          },
        },
        403,
      );
    }

    return respondManagerError(
      context,
      async () => {
        const parsed = parseInput(createProviderSettingsInputSchema, await readJson(context));
        const provider = await manager.create(parsed);
        return { provider };
      },
      201,
    );
  });

  app.patch('/settings/providers/:providerId', async (context) => {
    if (!canManage(options) || manager === undefined) {
      return context.json(
        {
          error: {
            code: 'provider-settings-desktop-only',
            message: 'Provider 密钥只能在 Desktop 设置中管理',
          },
        },
        403,
      );
    }

    return respondManagerError(context, async () => {
      const parsed = parseInput(updateProviderSettingsInputSchema, await readJson(context));
      const provider = await manager.update(context.req.param('providerId'), parsed);
      return { provider };
    });
  });

  app.delete('/settings/providers/:providerId', async (context) => {
    if (!canManage(options) || manager === undefined) {
      return context.json(
        {
          error: {
            code: 'provider-settings-desktop-only',
            message: 'Provider 密钥只能在 Desktop 设置中管理',
          },
        },
        403,
      );
    }

    try {
      await manager.remove(context.req.param('providerId'));
      return new Response(null, { status: 204 });
    } catch (error: unknown) {
      const mapped = mapManagerError(error);
      return context.json(mapped.body, mapped.status as never);
    }
  });

  app.post('/settings/providers/:providerId/default', async (context) => {
    if (!canManage(options) || manager === undefined) {
      return context.json(
        {
          error: {
            code: 'provider-settings-desktop-only',
            message: 'Provider 密钥只能在 Desktop 设置中管理',
          },
        },
        403,
      );
    }

    return respondManagerError(context, async () => {
      await manager.setDefault(context.req.param('providerId'));
      return listSettings(options);
    });
  });
}
