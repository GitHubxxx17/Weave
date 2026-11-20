import type { Hono } from 'hono';
import { pluginListResponseSchema, type PluginListItem } from './plugin-catalog.js';

/** Dependencies of the read-only plugin routes. */
export interface PluginAppOptions {
  /** Lists the plugins loaded for the Agent Runner currently serving requests. */
  readonly pluginCatalog?: (() => readonly PluginListItem[]) | undefined;
}

/** Registers `GET /plugins`, the list of loaded plugins with what they contribute. */
export function registerPluginRoutes(app: Hono, options: PluginAppOptions): void {
  app.get('/plugins', (context) =>
    context.json(pluginListResponseSchema.parse({ plugins: options.pluginCatalog?.() ?? [] })),
  );
}
