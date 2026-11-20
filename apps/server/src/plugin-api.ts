import type { Hono } from 'hono';
import {
  commandListResponseSchema,
  pluginListResponseSchema,
  type CommandListItem,
  type PluginListItem,
} from './plugin-catalog.js';

/** Dependencies of the read-only plugin routes. */
export interface PluginAppOptions {
  /** Lists the plugins loaded for the Agent Runner currently serving requests. */
  readonly pluginCatalog?: (() => readonly PluginListItem[]) | undefined;
  /** Lists the slash commands those plugins contributed. */
  readonly commandCatalog?: (() => readonly CommandListItem[]) | undefined;
}

/**
 * Registers the read-only plugin routes: `GET /plugins`, the loaded plugins with
 * what they contribute, and `GET /commands`, the slash commands they contribute.
 */
export function registerPluginRoutes(app: Hono, options: PluginAppOptions): void {
  app.get('/plugins', (context) =>
    context.json(pluginListResponseSchema.parse({ plugins: options.pluginCatalog?.() ?? [] })),
  );
  app.get('/commands', (context) =>
    context.json(commandListResponseSchema.parse({ commands: options.commandCatalog?.() ?? [] })),
  );
}
