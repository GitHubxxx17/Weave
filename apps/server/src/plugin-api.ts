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
import { ManagedReviewRequiredError } from './plugin-trust-sqlite.js';
import type { ExtensionGenerationSnapshot } from './extension-types.js';
import { registerManagedPluginRoutes } from './managed-plugin-api.js';
import { hookImpacts } from '@weave/plugin';
import type { PluginHookConfirmationStore } from './plugin-hook-confirmation-store.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
import type { ManagedPluginUpdater } from './managed-plugin-updater.js';

/** Dependencies of the plugin catalog and local plugin control plane. */
export interface PluginAppOptions {
  readonly pluginCatalog?: (() => readonly PluginListItem[]) | undefined;
  readonly commandCatalog?: (() => readonly CommandListItem[]) | undefined;
  readonly pluginManager?: ServerPluginManager | undefined;
  readonly managedPluginInstaller?: ManagedPluginInstaller | undefined;
  readonly managedPluginUpdater?: ManagedPluginUpdater | undefined;
  readonly assertManualPluginIdSync?: ((id: string) => void) | undefined;
  readonly studioOrigin?: string | undefined;
  readonly generationSnapshot?: (() => ExtensionGenerationSnapshot) | undefined;
  readonly hookConfirmations?: PluginHookConfirmationStore | undefined;
}

const idSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const emptyBodySchema = z.object({}).strict();
const trustBodySchema = z.object({ digest: pluginDigestSchema }).strict();
const hookConfirmationBodySchema = z
  .object({ digest: pluginDigestSchema, hooks: z.array(z.string().min(1).max(128)).min(1).max(16) })
  .strict();
const immediateSchema = z.enum(['true', 'false']).optional();

/** `GET /plugins/hook-confirmations`: undeclared high-risk hooks waiting for the user. */
export const hookConfirmationListResponseSchema = z.object({
  plugins: z.array(
    z.object({
      pluginId: z.string(),
      digest: pluginDigestSchema,
      hooks: z.array(
        z.object({
          id: z.string(),
          level: z.enum(['high', 'medium', 'low']),
          description: z.string(),
        }),
      ),
    }),
  ),
});

class PluginRequestError extends Error {
  readonly code = 'plugin-invalid-request';
}

class HookConfirmationNotPendingError extends Error {
  readonly code = 'plugin-hook-confirmation-not-pending';
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
  } else if (error instanceof HookConfirmationNotPendingError) {
    status = 409;
    issue = {
      code: error.code,
      message: 'These hooks are not waiting for confirmation for the current plugin content.',
    };
  } else if (error instanceof ManagedReviewRequiredError) {
    status = 409;
    issue = {
      code: 'plugin-managed-review-required',
      message: 'Use the managed plugin review to change this plugin.',
    };
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

function respondManagementDisabled(context: Context): Response {
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

function listPlugins(options: PluginAppOptions) {
  const snapshot = options.pluginManager?.snapshot();
  const catalog = options.pluginCatalog?.() ?? [];
  const generation = options.generationSnapshot?.();
  return pluginListResponseSchema.parse({
    ...(generation === undefined ? {} : { generation }),
    ...(snapshot === undefined
      ? { plugins: catalog }
      : {
          plugins: projectPluginCatalog(catalog, snapshot),
          local: describeLocalPluginHost(snapshot),
        }),
  });
}

/** Registers cached catalog reads and guarded management writes without invoking tools. */
export function registerPluginRoutes(app: Hono, options: PluginAppOptions): void {
  app.use('/plugins/*', pluginWriteGuard(options.studioOrigin));
  registerManagedPluginRoutes(app, options.managedPluginInstaller, options.managedPluginUpdater);
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

  const pendingHookConfirmations = () =>
    listPlugins(options).plugins.flatMap((plugin) =>
      plugin.origin === 'local' &&
      plugin.state === 'loaded' &&
      plugin.local?.digest !== undefined &&
      (plugin.pendingHooks?.length ?? 0) > 0
        ? [{ pluginId: plugin.id, digest: plugin.local.digest, hooks: plugin.pendingHooks ?? [] }]
        : [],
    );
  app.get('/plugins/hook-confirmations', (context) => {
    try {
      return context.json(
        hookConfirmationListResponseSchema.parse({
          plugins: pendingHookConfirmations().map((entry) => ({
            ...entry,
            hooks: entry.hooks.map((id) => ({
              id,
              level: hookImpacts[id]?.level ?? 'high',
              description: hookImpacts[id]?.description ?? '未登记的钩子',
            })),
          })),
        }),
      );
    } catch (error: unknown) {
      return respondError(context, error);
    }
  });

  const mutate = async (
    context: Context,
    operation: (manager: ServerPluginManager | undefined) => Promise<ReloadResult | undefined>,
  ): Promise<Response> => {
    try {
      const result = await operation(options.pluginManager);
      if (result === undefined) return respondManagementDisabled(context);
      // Capture current desired state and catalog together after awaiting the decision.
      return context.json(pluginMutationResponseSchema.parse({ ...listPlugins(options), result }));
    } catch (error: unknown) {
      if (options.pluginManager === undefined && error instanceof PluginRequestError) {
        return respondManagementDisabled(context);
      }
      return respondError(context, error);
    }
  };
  const pluginId = (context: Context): string => {
    const parsed = idSchema.safeParse(context.req.param('id'));
    if (!parsed.success) throw new PluginRequestError('Invalid plugin id');
    return parsed.data;
  };
  function manualMutation(
    manager: ServerPluginManager | undefined,
    id: string,
    operation: (manager: ServerPluginManager) => Promise<ReloadResult>,
  ): Promise<ReloadResult> | undefined {
    if (manager !== undefined) return operation(manager);
    options.assertManualPluginIdSync?.(id);
    return undefined;
  }
  app.post('/plugins/reload', (context) =>
    mutate(context, async (manager) => {
      if (manager === undefined) return undefined;
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
      return manualMutation(manager, id, (live) => live.trust(id, body.digest));
    }),
  );
  app.post('/plugins/:id/hook-confirmations', (context) =>
    mutate(context, async (manager) => {
      noImmediate(context);
      const id = pluginId(context);
      const body = await readBody(context, hookConfirmationBodySchema);
      const store = options.hookConfirmations;
      if (manager === undefined || store === undefined) return undefined;
      const pending = pendingHookConfirmations().find(
        (entry) => entry.pluginId === id && entry.digest === body.digest,
      );
      if (pending === undefined || !body.hooks.every((hook) => pending.hooks.includes(hook))) {
        throw new HookConfirmationNotPendingError();
      }
      store.confirm(id, body.digest, body.hooks);
      // The confirmation applies to the next Generation; rebuild it now.
      return manager.reload();
    }),
  );
  app.delete('/plugins/:id/trust', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      const timing = immediate(context);
      await readBody(context, emptyBodySchema, true);
      return manualMutation(manager, id, (live) => live.revoke(id, timing));
    }),
  );
  app.post('/plugins/:id/enable', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      noImmediate(context);
      await readBody(context, emptyBodySchema, true);
      return manualMutation(manager, id, (live) => live.setEnabled(id, true));
    }),
  );
  app.post('/plugins/:id/disable', (context) =>
    mutate(context, async (manager) => {
      const id = pluginId(context);
      const timing = immediate(context);
      await readBody(context, emptyBodySchema, true);
      return manualMutation(manager, id, (live) => live.setEnabled(id, false, timing));
    }),
  );
}
