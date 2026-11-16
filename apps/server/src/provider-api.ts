import type { Hono } from 'hono';
import type { LlmProviderRegistry } from '@weave/llm';

/** Dependencies needed by the public Provider metadata route. */
export interface ProviderAppOptions {
  readonly providerRegistry?: LlmProviderRegistry | undefined;
}

/** Mounts the read-only Provider metadata route used by Studio. */
export function registerProviderRoutes(app: Hono, options: ProviderAppOptions): void {
  app.get('/settings/providers', (context) => {
    if (options.providerRegistry === undefined) {
      return context.json(
        {
          error: {
            code: 'provider-service-unavailable',
            message: 'Provider service is not available',
          },
        },
        503,
      );
    }

    return context.json({
      providers: options.providerRegistry.list(),
      defaultProvider: 'mock',
    });
  });
}
