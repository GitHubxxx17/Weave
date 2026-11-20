import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  commandListResponseSchema,
  pluginListResponseSchema,
  pluginMutationResponseSchema,
  projectPluginCatalog,
  type CommandListItem,
  type PluginListItem,
} from './plugin-catalog.js';
import {
  describeLocalPluginHost,
  pluginDigestSchema,
  pluginErrorResponseSchema,
  type ServerPluginManager,
} from './plugin-management-types.js';
import { pluginWriteGuard } from './plugin-write-guard.js';
import { PluginHostError, type ReloadResult } from '@weave/plugin-host';
import { PluginTrustStoreError } from './plugin-trust-store.js';

/** Dependencies of the plugin catalog and local plugin control plane. */
export interface PluginAppOptions {
  readonly pluginCatalog?: (() => readonly PluginListItem[]) | undefined;
  readonly commandCatalog?: (() => readonly CommandListItem[]) | undefined;
  readonly pluginManager?: ServerPluginManager | undefined;
  readonly studioOrigin?: string | undefined;
}

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const emptyBodySchema = z.object({}).strict();
const trustBodySchema = z.object({ digest: pluginDigestSchema }).strict();
const immediateSchema = z.enum(['true', 'false']).optional();

class PluginRequestError extends Error {
  readonly code = 'plugin-invalid-request';
}

function noImmediate(context: Context): void {
  if (context.req.queries('immediate') !== undefined)
    throw new PluginRequestError('Immediate is not supported for this operation');
}

function immediate(context: Context): { readonly immediate?: boolean } | undefined {
  const values = context.req.queries('immediate');
  if (values !== undefined && values.length !== 1)
    throw new PluginRequestError('Invalid immediate query');
  const value = immediateSchema.safeParse(values?.[0]);
  if (!value.success) throw new PluginRequestError('Invalid immediate query');
  return value.data === undefined ? undefined : { immediate: value.data === 'true' };
}

async function readBody<T>(context: Context, schema: z.ZodType<T>, allowEmpty = false): Promise<T> {
  const text = await context.req.text();
  let value: unknown;
  try {
    value = text.length === 0 && allowEmpty ? {} : JSON.parse(text);
  } catch {
    throw new PluginRequestError('Request body must be valid JSON');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PluginRequestError('Invalid plugin management request');
  return parsed.data;
}

function respondError(context: Context, error: unknown): Response {
  let status: 400 | 404 | 409 | 500 | 503 = 500;
  let issue = { code: 'plugin-management-failed', message: 'Plugin management is unavailable' };
  if (error instanceof PluginRequestError) {
    status = 400;
    issue = { code: error.code, message: error.message };
  } else if (error instanceof PluginHostError || error instanceof PluginTrustStoreError) {
    issue = { code: error.code, message: error.message };
    switch (issue.code) {
      case 'plugin-not-found':
      case 'plugin-management-disabled':
        status = 404;
        break;
      case 'plugin-not-trusted':
      case 'plugin-not-loadable':
      case 'plugin-digest-mismatch':
      case 'plugin-generation-blocked':
        status = 409;
        break;
      case 'plugin-host-disposed':
      case 'plugin-trust-closed':
        status = 503;
        break;
      case 'plugin-trust-invalid':
        status = 400;
        break;
    }
  }
  return context.json(pluginErrorResponseSchema.parse({ error: issue }), status);
}

function listPlugins(options: PluginAppOptions) {
  const snapshot = options.pluginManager?.snapshot();
  const catalog = options.pluginCatalog?.() ?? [];
  return pluginListResponseSchema.parse(
    snapshot === undefined
      ? { plugins: catalog }
      : {
          plugins: projectPluginCatalog(catalog, snapshot),
          local: describeLocalPluginHost(snapshot),
        },
  );
}

/** Registers cached catalog reads and guarded management writes without invoking tools. */
export function registerPluginRoutes(app: Hono, options: PluginAppOptions): void {
  app.use('/plugins/*', pluginWriteGuard(options.studioOrigin));
  app.get('/plugins', (context) => {
    try {
      return context.json(listPlugins(options));
    } catch (error: unknown) {
      return respondError(context, error);
    }
  });
  app.get('/commands', (context) =>
    context.json(commandListResponseSchema.parse({ commands: options.commandCatalog?.() ?? [] })),
  );

  const mutate = async (
    context: Context,
    operation: (manager: ServerPluginManager) => Promise<ReloadResult>,
  ): Promise<Response> => {
    try {
      if (options.pluginManager === undefined) {
        return context.json(
          pluginErrorResponseSchema.parse({
            error: {
              code: 'plugin-management-disabled',
              message: 'Local plugin management is not enabled',
            },
          }),
          404,
        );
      }
      const result = await operation(options.pluginManager);
      // Capture current desired state and catalog together after awaiting the decision.
      return context.json(pluginMutationResponseSchema.parse({ ...listPlugins(options), result }));
    } catch (error: unknown) {
      return respondError(context, error);
    }
  };
  const pluginId = (context: Context): string => {
    const parsed = idSchema.safeParse(context.req.param('id'));
    if (!parsed.success) throw new PluginRequestError('Invalid plugin id');
    return parsed.data;
  };
  app.post('/plugins/reload', (context) =>
    mutate(context, async (manager) => {
      noImmediate(context);
      await readBody(context, emptyBodySchema, true);
      return manager.reload();
    }),
  );
  app.post('/plugins/:id/trust', (context) =>
    mutate(context, async (manager) => {
      noImmediate(context);
      const id = pluginId(context);
      const body = await readBody(context, trustBodySchema);
      return manager.trust(id, body.digest);
    }),
  );
  app.delete('/plugins/:id/trust', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      const options = immediate(context);
      await readBody(context, emptyBodySchema, true);
      return manager.revoke(id, options);
    }),
  );
  app.post('/plugins/:id/enable', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      noImmediate(context);
      await readBody(context, emptyBodySchema, true);
      return manager.setEnabled(id, true);
    }),
  );
  app.post('/plugins/:id/disable', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      const options = immediate(context);
      await readBody(context, emptyBodySchema, true);
      return manager.setEnabled(id, false, options);
    }),
  );
}
