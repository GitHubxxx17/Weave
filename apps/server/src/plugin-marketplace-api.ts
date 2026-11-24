import type { Context, Hono } from 'hono';
import { z } from 'zod';
import type { PluginListItem } from './plugin-catalog.js';
import { serverHostVersion } from './host-version.js';
import { projectPluginMarketplace, type PluginMarketplaceCatalog } from './plugin-marketplace.js';
import {
  MarketplaceSourceError,
  marketplaceSourceNameSchema,
  type PluginMarketplaceManager,
} from './plugin-marketplace-source-types.js';

export interface PluginMarketplaceAppOptions {
  readonly pluginMarketplace?: PluginMarketplaceCatalog;
  readonly pluginMarketplaceManager?: PluginMarketplaceManager;
  readonly pluginCatalog?: (() => readonly PluginListItem[]) | undefined;
}
const maxRequestBytes = 8192;
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sourceRequestIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9-]+$/);
async function readBody<T>(context: Context, schema: z.ZodType<T>): Promise<T> {
  const reader = context.req.raw.body?.getReader();
  if (reader === undefined)
    throw new MarketplaceSourceError(
      400,
      'plugin-marketplace-invalid-request',
      'Expected a JSON request',
    );
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort.signal.addEventListener('abort', () => reject(new Error('Request body timeout')), {
      once: true,
    });
  });
  const chunks: Uint8Array[] = [];
  let length = 0;
  let complete = false;
  try {
    while (true) {
      const next = await Promise.race([reader.read(), interrupted]);
      if (next.done) {
        complete = true;
        break;
      }
      length += next.value.byteLength;
      if (length > maxRequestBytes) throw new Error();
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return schema.parse(value);
  } catch {
    throw new MarketplaceSourceError(
      400,
      'plugin-marketplace-invalid-request',
      'Invalid marketplace source request',
    );
  } finally {
    clearTimeout(timer);
    if (!complete) void reader.cancel().catch(() => undefined);
  }
}
function errorResponse(context: Context, error: unknown): Response {
  const known =
    error instanceof MarketplaceSourceError
      ? error
      : new MarketplaceSourceError(
          503,
          'plugin-marketplace-unavailable',
          'Marketplace sources are unavailable',
        );
  return context.json({ error: { code: known.code, message: known.message } }, known.status);
}
export function registerPluginMarketplaceRoutes(
  app: Hono,
  options: PluginMarketplaceAppOptions,
): void {
  app.get('/plugins/marketplace', (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      const ids = context.req.queries('sourceId');
      if (
        ids !== undefined &&
        (ids.length !== 1 || !sourceRequestIdSchema.safeParse(ids[0]).success)
      )
        throw new MarketplaceSourceError(
          400,
          'plugin-marketplace-invalid-request',
          'Invalid marketplace source',
        );
      if (options.pluginMarketplaceManager !== undefined) {
        const { catalog, indexSource } = options.pluginMarketplaceManager.catalog(ids?.[0]);
        return context.json({
          ...projectPluginMarketplace(catalog, options.pluginCatalog?.() ?? [], serverHostVersion),
          indexSource,
        });
      }
      return context.json(
        projectPluginMarketplace(
          options.pluginMarketplace ?? { communityStatus: 'unconfigured', plugins: [] },
          options.pluginCatalog?.() ?? [],
          serverHostVersion,
        ),
      );
    } catch (error) {
      return errorResponse(context, error);
    }
  });
  app.get('/plugins/marketplace/sources', (context) => {
    context.header('Cache-Control', 'no-store');
    return context.json(
      options.pluginMarketplaceManager?.listSources() ?? {
        schemaVersion: 1,
        revision: 0,
        sources: [],
      },
    );
  });
  if (options.pluginMarketplaceManager === undefined) return;
  const manager = options.pluginMarketplaceManager;
  const mutate = async (context: Context, operation: () => Promise<unknown>): Promise<Response> => {
    context.header('Cache-Control', 'no-store');
    try {
      return context.json(await operation());
    } catch (error) {
      return errorResponse(context, error);
    }
  };
  app.post('/plugins/marketplace/sources/add', (context) =>
    mutate(context, async () => {
      const { revision, ...source } = await readBody(
        context,
        z.strictObject({
          name: marketplaceSourceNameSchema,
          url: z.string().max(2048),
          revision: revisionSchema,
        }),
      );
      return manager.add(source, revision);
    }),
  );
  app.post('/plugins/marketplace/sources/remove', (context) =>
    mutate(context, async () => {
      const body = await readBody(
        context,
        z.strictObject({ id: sourceRequestIdSchema, revision: revisionSchema }),
      );
      return manager.remove(body.id, body.revision);
    }),
  );
  app.post('/plugins/marketplace/sources/reorder', (context) =>
    mutate(context, async () => {
      const body = await readBody(
        context,
        z.strictObject({
          ids: z.array(sourceRequestIdSchema).max(10),
          revision: revisionSchema,
        }),
      );
      return manager.reorder(body.ids, body.revision);
    }),
  );
  app.post('/plugins/marketplace/refresh', (context) =>
    mutate(context, async () =>
      manager.refresh(
        (await readBody(context, z.strictObject({ sourceId: sourceRequestIdSchema }))).sourceId,
      ),
    ),
  );
}
