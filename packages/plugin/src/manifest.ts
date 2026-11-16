import { z } from 'zod';

/** Capabilities that a trusted plugin may register through Plugin Context. */
export type PluginCapability = 'tool' | 'llm-provider';

/** Declarative identity and capability metadata for one Weave plugin. */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string | undefined;
  readonly capabilities: readonly PluginCapability[];
}

const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const pluginCapabilitySchema = z.enum(['tool', 'llm-provider']);

/** Validates the structural shape of a Plugin Manifest. */
export const pluginManifestSchema: z.ZodType<PluginManifest> = z
  .object({
    id: pluginIdSchema,
    name: z.string().min(1),
    version: versionSchema,
    apiVersion: versionSchema,
    description: z.string().min(1).optional(),
    capabilities: z
      .array(pluginCapabilitySchema)
      .min(1)
      .superRefine((capabilities, context) => {
        if (new Set(capabilities).size !== capabilities.length) {
          context.addIssue({
            code: 'custom',
            message: 'Plugin capabilities must be unique',
          });
        }
      }),
  })
  .strict();
