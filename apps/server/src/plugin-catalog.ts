import { type PluginContributes, type PluginInfo } from '@weave/plugin';
import type { PluginHostSnapshot } from '@weave/plugin-host';
import {
  localPluginMetadataSchema,
  localPluginSummarySchema,
  pluginIssueSchema,
  pluginReloadResultSchema,
} from './plugin-management-types.js';
import { z } from 'zod';

/** Who put a plugin into the Server. */
export type PluginOrigin = 'builtin' | 'registered' | 'kernel' | 'local';

const nameListSchema = z.array(z.string());

/**
 * One plugin as the Server lists it. `contributes` and `permissions` are what
 * the manifest declares and are left out when it declares nothing; `provides`
 * is what the plugin actually added, which the manifest does not have to list.
 */
export const pluginListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  origin: z.enum(['builtin', 'registered', 'kernel', 'local']),
  state: z.enum([
    'loaded',
    'pending-trust',
    'changed',
    'disabled',
    'failed',
    'invalid',
    'incompatible',
  ]),
  error: pluginIssueSchema.optional(),
  local: localPluginMetadataSchema.optional(),
  host: z.enum(['in-process', 'mcp', 'subprocess']),
  capabilities: z.array(z.enum(['tool', 'llm-provider', 'prompt', 'event', 'command'])),
  engines: z.object({ weave: z.string() }).optional(),
  contributes: z
    .object({
      tools: nameListSchema.optional(),
      providers: nameListSchema.optional(),
      promptSections: nameListSchema.optional(),
      events: nameListSchema.optional(),
      commands: nameListSchema.optional(),
      hooks: nameListSchema.optional(),
      services: nameListSchema.optional(),
    })
    .optional(),
  permissions: z.array(z.string()).optional(),
  provides: z.object({
    tools: nameListSchema,
    providers: nameListSchema,
    promptSections: nameListSchema,
    events: nameListSchema,
    commands: nameListSchema,
    hooks: nameListSchema,
    services: nameListSchema,
  }),
});

export type PluginListItem = z.infer<typeof pluginListItemSchema>;

/** Response body of `GET /plugins`. */
export const pluginListResponseSchema = z.object({
  plugins: z.array(pluginListItemSchema),
  local: localPluginSummarySchema.optional(),
});

/** A successful decision may still report a failed generation rebuild. */
export const pluginMutationResponseSchema = pluginListResponseSchema.extend({
  local: localPluginSummarySchema,
  result: pluginReloadResultSchema,
});

/** One slash command as `GET /commands` lists it: the command and who contributed it. */
export const commandListItemSchema = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string().optional(),
  prompt: z.string(),
  pluginId: z.string(),
});

export type CommandListItem = z.infer<typeof commandListItemSchema>;

/** Response body of `GET /commands`. */
export const commandListResponseSchema = z.object({ commands: z.array(commandListItemSchema) });

function declared(contributes: PluginContributes): NonNullable<PluginListItem['contributes']> {
  return {
    ...(contributes.tools === undefined ? {} : { tools: [...contributes.tools] }),
    ...(contributes.providers === undefined ? {} : { providers: [...contributes.providers] }),
    ...(contributes.promptSections === undefined
      ? {}
      : { promptSections: [...contributes.promptSections] }),
    ...(contributes.events === undefined ? {} : { events: [...contributes.events] }),
    ...(contributes.commands === undefined ? {} : { commands: [...contributes.commands] }),
    ...(contributes.hooks === undefined ? {} : { hooks: [...contributes.hooks] }),
    ...(contributes.services === undefined ? {} : { services: [...contributes.services] }),
  };
}

/** Turns what the kernel knows about a plugin into the Server's list item. */
export function describePlugin(info: PluginInfo, origin: PluginOrigin): PluginListItem {
  const { manifest, contributed } = info;
  return pluginListItemSchema.parse({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    origin,
    state: 'loaded',
    host: manifest.host ?? 'in-process',
    capabilities: [...manifest.capabilities],
    ...(manifest.engines === undefined ? {} : { engines: { weave: manifest.engines.weave } }),
    ...(manifest.contributes === undefined ? {} : { contributes: declared(manifest.contributes) }),
    ...(manifest.permissions === undefined ? {} : { permissions: [...manifest.permissions] }),
    provides: {
      tools: [...contributed.tools],
      providers: [...contributed.providers],
      promptSections: [...contributed.promptSections],
      events: [...contributed.events],
      commands: [...contributed.commands],
      hooks: [...contributed.hooks],
      services: [...contributed.services],
    },
  });
}

/** Desired local records replace the current generation's local catalog entries. */
export function projectPluginCatalog(
  catalog: readonly PluginListItem[],
  snapshot: PluginHostSnapshot,
): PluginListItem[] {
  const active = new Map(snapshot.generation.plugins.map((plugin) => [plugin.id, plugin]));
  const actual = new Map(catalog.map((plugin) => [plugin.id, plugin]));
  const nonLocal = catalog
    .filter((plugin) => plugin.origin !== 'local' && !active.has(plugin.id))
    .map((plugin) => pluginListItemSchema.parse({ ...plugin, state: 'loaded' }));
  const local = snapshot.plugins.map((record) => {
    const { candidate, trusted } = record;
    const manifest = candidate.manifest;
    const digest = candidate.status === 'ready' ? candidate.digest : undefined;
    const error = record.error ?? (candidate.status === 'ready' ? undefined : candidate.issue);
    const provides =
      record.state === 'loaded' &&
      digest !== undefined &&
      active.get(record.id)?.digest === digest &&
      record.active?.digest === digest &&
      record.active.generation === snapshot.generation.id
        ? actual.get(record.id)?.provides
        : undefined;
    return pluginListItemSchema.parse({
      id: record.id,
      name: manifest?.name ?? record.id,
      version: manifest?.version ?? 'unknown',
      ...(manifest?.description === undefined ? {} : { description: manifest.description }),
      origin: 'local',
      state: record.state,
      host: manifest?.host ?? 'in-process',
      capabilities: manifest?.capabilities ?? [],
      ...(manifest?.engines === undefined ? {} : { engines: manifest.engines }),
      ...(manifest?.contributes === undefined
        ? {}
        : { contributes: declared(manifest.contributes) }),
      ...(manifest?.permissions === undefined ? {} : { permissions: [...manifest.permissions] }),
      ...(error === undefined ? {} : { error }),
      provides: provides ?? {
        tools: [],
        providers: [],
        promptSections: [],
        events: [],
        commands: [],
        hooks: [],
        services: [],
      },
      local: {
        directory: candidate.directory,
        ...(digest === undefined ? {} : { digest }),
        enabled: trusted?.enabled ?? false,
        ...(manifest === undefined ? {} : { manifest }),
        ...(trusted === undefined
          ? {}
          : {
              trusted: {
                digest: trusted.digest,
                trustedAt: trusted.trustedAt,
                manifest: trusted.manifest,
              },
            }),
        ...(record.active === undefined ? {} : { active: record.active }),
      },
    });
  });
  return [...nonLocal, ...local];
}
