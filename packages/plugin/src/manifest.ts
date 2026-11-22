import { z } from 'zod';
import { commandNamePattern } from './commands.js';
import { pluginEventTypePattern } from './event-type.js';
import { isValidVersionRange } from './version-range.js';
import { skillNamePattern } from './skills.js';

/** Capabilities that a trusted plugin may register through Plugin Context. */
export type PluginCapability =
  'tool' | 'llm-provider' | 'prompt' | 'event' | 'command' | 'skill' | 'panel';

/**
 * How a plugin is hosted. The kernel only records it; hosts and loaders decide
 * how to load a plugin from it and Studio shows it.
 */
export type PluginHost = 'in-process' | 'mcp' | 'subprocess' | 'declarative';

/**
 * A permission a plugin declares. Only `service:<id>` is enforced by the
 * kernel; the others are shown to the user when the plugin is trusted.
 */
export type PluginPermission =
  'workspace:read' | 'workspace:write' | 'process:spawn' | 'network:request' | `service:${string}`;

/**
 * The names a plugin declares it will contribute. Once a plugin declares this
 * object it is a closed list: a key left out means the plugin contributes none
 * of that kind.
 */
export interface PluginContributes {
  /** Tool names added through `weave.tools`. */
  readonly tools?: readonly string[] | undefined;
  /** LLM provider ids added through `weave.llm.providers`. */
  readonly providers?: readonly string[] | undefined;
  /** Prompt section ids added through `weave.prompt.sections`. */
  readonly promptSections?: readonly string[] | undefined;
  /** Session event types, `<pluginId>/<name>`, added through `weave.session.events`. */
  readonly events?: readonly string[] | undefined;
  /** Slash command names added through `weave.commands`. */
  readonly commands?: readonly string[] | undefined;
  /** Instruction bundle names added through `weave.skills`. */
  readonly skills?: readonly string[] | undefined;
  /** Local right-panel IDs added through `weave.studio.panels`. */
  readonly panels?: readonly string[] | undefined;
  /** Ids of the hooks the plugin listens to through `env.onHook`. */
  readonly hooks?: readonly string[] | undefined;
  /** Ids of the services the plugin provides. */
  readonly services?: readonly string[] | undefined;
}

/** The `contributes` keys whose names arrive through a governed extension point. */
export type ContributedNameKey =
  'tools' | 'providers' | 'promptSections' | 'events' | 'commands' | 'skills' | 'panels';

/** Declarative identity and capability metadata for one Weave plugin. */
export interface PluginManifest {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly description?: string | undefined;
  readonly capabilities: readonly PluginCapability[];
  /** Defaults to `in-process`. */
  readonly host?: PluginHost | undefined;
  /** The host Weave versions the plugin supports, e.g. `>=1.2.0` or `^1.0.0`. */
  readonly engines?: { readonly weave: string } | undefined;
  readonly contributes?: PluginContributes | undefined;
  readonly permissions?: readonly PluginPermission[] | undefined;
}

const pluginIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const versionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const pluginCapabilitySchema = z.enum([
  'tool',
  'llm-provider',
  'prompt',
  'event',
  'command',
  'skill',
  'panel',
]);
const pluginHostSchema = z.enum(['in-process', 'mcp', 'subprocess', 'declarative']);

const serviceIdPattern = '[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*';
const serviceIdSchema = z.string().regex(new RegExp(`^${serviceIdPattern}$`));
const servicePermissionPattern = new RegExp(`^service:${serviceIdPattern}$`);

const declarativePermissions = [
  'workspace:read',
  'workspace:write',
  'process:spawn',
  'network:request',
] as const;
const pluginPermissionSchema = z.union([
  z.enum(declarativePermissions),
  z.custom<`service:${string}`>(
    (value) => typeof value === 'string' && servicePermissionPattern.test(value),
    {
      message:
        'Permission must be workspace:read, workspace:write, process:spawn, network:request or service:<id>',
    },
  ),
]);

const hasUniqueEntries = (entries: readonly string[]): boolean =>
  new Set(entries).size === entries.length;

const nameListSchema = z
  .array(z.string().min(1))
  .refine(hasUniqueEntries, { message: 'Contributed names must be unique' });

const eventTypeListSchema = z
  .array(
    z.string().regex(pluginEventTypePattern, {
      message: 'Event types must look like <pluginId>/<name>, lowercase and hyphen-separated',
    }),
  )
  .refine(hasUniqueEntries, { message: 'Contributed names must be unique' });

const commandNameListSchema = z
  .array(
    z.string().regex(commandNamePattern, {
      message: 'Command names are lowercase letters and digits separated by single hyphens',
    }),
  )
  .refine(hasUniqueEntries, { message: 'Contributed names must be unique' });

/** Each contributed kind needs the capability that governs its extension point. */
const requiredCapabilities: ReadonlyArray<readonly [ContributedNameKey, PluginCapability]> = [
  ['tools', 'tool'],
  ['providers', 'llm-provider'],
  ['promptSections', 'prompt'],
  ['events', 'event'],
  ['commands', 'command'],
  ['skills', 'skill'],
  ['panels', 'panel'],
];

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
    host: pluginHostSchema.optional(),
    engines: z
      .object({
        weave: z.string().refine(isValidVersionRange, {
          message:
            'engines.weave must be a version range such as ">=1.2.0" or "^1.0.0" with full x.y.z versions',
        }),
      })
      .strict()
      .optional(),
    contributes: z
      .object({
        tools: nameListSchema.optional(),
        providers: nameListSchema.optional(),
        promptSections: nameListSchema.optional(),
        events: eventTypeListSchema.optional(),
        commands: commandNameListSchema.optional(),
        skills: z
          .array(z.string().max(64).regex(skillNamePattern))
          .refine(hasUniqueEntries, { message: 'Contributed names must be unique' })
          .optional(),
        panels: z
          .array(z.string().min(1).max(64).regex(commandNamePattern))
          .max(8)
          .refine(hasUniqueEntries, { message: 'Contributed names must be unique' })
          .optional(),
        hooks: nameListSchema.optional(),
        services: z
          .array(serviceIdSchema)
          .refine(hasUniqueEntries, { message: 'Contributed names must be unique' })
          .optional(),
      })
      .strict()
      .optional(),
    permissions: z
      .array(pluginPermissionSchema)
      .refine(hasUniqueEntries, { message: 'Plugin permissions must be unique' })
      .optional(),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.host === 'declarative' &&
      (manifest.capabilities.length !== 1 ||
        manifest.capabilities[0] !== 'skill' ||
        manifest.permissions?.length !== 0 ||
        manifest.contributes?.skills === undefined ||
        manifest.contributes.skills.length < 1 ||
        manifest.contributes.skills.length > 16 ||
        Object.keys(manifest.contributes).some((key) => key !== 'skills'))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['host'],
        message:
          'Declarative hosts require only the skill capability, 1–16 declared Skills and empty permissions',
      });
    }
    if (
      manifest.capabilities.includes('panel') &&
      (manifest.id.length > 64 || manifest.name.length > 120 || manifest.version.length > 64)
    ) {
      context.addIssue({ code: 'custom', message: 'Panel owner metadata exceeds its limit' });
    }
    for (const [key, capability] of requiredCapabilities) {
      const names = manifest.contributes?.[key];
      if (names !== undefined && names.length > 0 && !manifest.capabilities.includes(capability)) {
        context.addIssue({
          code: 'custom',
          path: ['contributes', key],
          message: `contributes.${key} requires the "${capability}" capability`,
        });
      }
    }
    // A plugin's events live under its own id, so no plugin can write into
    // another plugin's namespace or into one a later plugin might claim.
    manifest.contributes?.events?.forEach((type, index) => {
      if (!type.startsWith(`${manifest.id}/`)) {
        context.addIssue({
          code: 'custom',
          path: ['contributes', 'events', index],
          message: `Event type "${type}" must start with the plugin id: "${manifest.id}/"`,
        });
      }
    });
  });
