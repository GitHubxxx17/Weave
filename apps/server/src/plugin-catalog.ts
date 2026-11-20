import { type PluginContributes, type PluginInfo } from '@weave/plugin';
import { z } from 'zod';

/** Who put a plugin into the Server. */
export type PluginOrigin = 'builtin' | 'registered' | 'kernel';

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
  origin: z.enum(['builtin', 'registered', 'kernel']),
  host: z.enum(['in-process', 'mcp', 'subprocess']),
  capabilities: z.array(z.enum(['tool', 'llm-provider', 'prompt'])),
  engines: z.object({ weave: z.string() }).optional(),
  contributes: z
    .object({
      tools: nameListSchema.optional(),
      providers: nameListSchema.optional(),
      promptSections: nameListSchema.optional(),
      services: nameListSchema.optional(),
    })
    .optional(),
  permissions: z.array(z.string()).optional(),
  provides: z.object({
    tools: nameListSchema,
    providers: nameListSchema,
    promptSections: nameListSchema,
    services: nameListSchema,
  }),
});

export type PluginListItem = z.infer<typeof pluginListItemSchema>;

/** Response body of `GET /plugins`. */
export const pluginListResponseSchema = z.object({ plugins: z.array(pluginListItemSchema) });

function declared(contributes: PluginContributes): NonNullable<PluginListItem['contributes']> {
  return {
    ...(contributes.tools === undefined ? {} : { tools: [...contributes.tools] }),
    ...(contributes.providers === undefined ? {} : { providers: [...contributes.providers] }),
    ...(contributes.promptSections === undefined
      ? {}
      : { promptSections: [...contributes.promptSections] }),
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
    host: manifest.host ?? 'in-process',
    capabilities: [...manifest.capabilities],
    ...(manifest.engines === undefined ? {} : { engines: { weave: manifest.engines.weave } }),
    ...(manifest.contributes === undefined ? {} : { contributes: declared(manifest.contributes) }),
    ...(manifest.permissions === undefined ? {} : { permissions: [...manifest.permissions] }),
    provides: {
      tools: [...contributed.tools],
      providers: [...contributed.providers],
      promptSections: [...contributed.promptSections],
      services: [...contributed.services],
    },
  });
}
