import { z } from 'zod';

const nameListSchema = z.array(z.string());

/**
 * One plugin as `GET /plugins` lists it. Studio does not share types with the
 * Server, so this mirrors the contract in the plugin kernel design (section 16)
 * and stays tolerant of values it does not know yet: unknown origins, hosts and
 * capabilities are shown as they are instead of failing the whole list.
 */
export const pluginListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  origin: z.string(),
  host: z.string(),
  capabilities: z.array(z.string()),
  engines: z.object({ weave: z.string() }).optional(),
  /** What the manifest declares; absent when the plugin declares nothing. */
  contributes: z
    .object({
      tools: nameListSchema.optional(),
      providers: nameListSchema.optional(),
      promptSections: nameListSchema.optional(),
      events: nameListSchema.optional(),
      services: nameListSchema.optional(),
    })
    .optional(),
  permissions: z.array(z.string()).optional(),
  /** What the plugin actually added to the Agent. */
  provides: z.object({
    tools: nameListSchema,
    providers: nameListSchema,
    promptSections: nameListSchema,
    /** Left out by a Server that predates plugin events. */
    events: nameListSchema.default([]),
    services: nameListSchema,
  }),
});

export type PluginListItem = z.infer<typeof pluginListItemSchema>;

export const pluginListSchema = z.object({ plugins: z.array(pluginListItemSchema) });
