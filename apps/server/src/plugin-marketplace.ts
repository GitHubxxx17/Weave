import { assertEngineSupported, pluginApiVersion, type PluginManifest } from '@weave/plugin';
import { githubPluginSourceSchema } from '@weave/plugin-host';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { PluginListItem } from './plugin-catalog.js';
import { artifactManifestSchema, pluginIdSchema } from './plugin-authority-types.js';

const text = z.string().trim().min(1).max(300);
const description = z.string().trim().min(1).max(2000);
const tags = z.array(z.string().trim().min(1).max(40)).max(10);
const version = z.string().regex(/^\d+\.\d+\.\d+$/);
const source = githubPluginSourceSchema.extend({
  repository: z
    .string()
    .max(400)
    .refine((value) => value === value.toLowerCase())
    .pipe(githubPluginSourceSchema.shape.repository),
  subdirectory: z
    .string()
    .max(2048)
    .refine((value) => githubPluginSourceSchema.shape.subdirectory.safeParse(value).success),
});
const release = z.strictObject({ manifest: artifactManifestSchema, source });
const fields = {
  id: pluginIdSchema.max(200),
  name: text,
  description,
  publisher: text,
  tags,
};
export const reservedMarketplacePluginIds = [
  'tool-registry',
  'provider-registry',
  'event-registry',
  'host-services',
  'server-tool-host',
] as const;

export const marketplaceCommunityPluginSchema = z
  .strictObject({ ...fields, releases: z.array(release).min(1).max(20) })
  .superRefine((plugin, context) => {
    const versions = new Set<string>();
    for (const item of plugin.releases) {
      if (item.manifest.id !== plugin.id || versions.has(item.manifest.version)) {
        context.addIssue({ code: 'custom', message: 'Conflicting marketplace release identity' });
      }
      versions.add(item.manifest.version);
    }
  });

/** Operator-owned data; category and compatibility can never come from this file. */
export const pluginMarketplaceIndexSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    title: text.optional(),
    plugins: z.array(marketplaceCommunityPluginSchema).max(100),
  })
  .superRefine((index, context) => {
    const ids = new Set<string>();
    for (const plugin of index.plugins) {
      if (ids.has(plugin.id))
        context.addIssue({ code: 'custom', message: 'Duplicate marketplace identity' });
      ids.add(plugin.id);
      if ((reservedMarketplacePluginIds as readonly string[]).includes(plugin.id))
        context.addIssue({ code: 'custom', message: 'Reserved marketplace identity' });
    }
  });

const builtinEntry = z.strictObject({
  ...fields,
  kind: z.literal('builtin'),
  category: z.literal('official'),
  publisher: z.literal('Weave'),
  version,
});
const githubEntry = z.strictObject({
  ...fields,
  kind: z.literal('github'),
  category: z.literal('community'),
  releases: z
    .array(release.extend({ compatibility: z.enum(['compatible', 'incompatible']) }))
    .min(1)
    .max(20),
});
export const pluginMarketplaceResponseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  hostVersion: version,
  communityStatus: z.enum(['unconfigured', 'ready', 'unavailable']),
  entries: z.array(z.discriminatedUnion('kind', [builtinEntry, githubEntry])).max(105),
  indexSource: z
    .strictObject({ id: text, name: text, url: z.string().max(2048).nullable() })
    .optional(),
});
export type PluginMarketplaceResponse = z.infer<typeof pluginMarketplaceResponseSchema>;
export interface PluginMarketplaceCatalog {
  readonly communityStatus: PluginMarketplaceResponse['communityStatus'];
  readonly plugins: readonly z.infer<typeof marketplaceCommunityPluginSchema>[];
}

const official = [
  {
    id: 'tool-registry',
    name: '工具注册表',
    description: '管理插件工具注册并接入共享执行管线。',
    tags: ['工具'],
  },
  {
    id: 'provider-registry',
    name: '模型提供方',
    description: '管理插件提供的模型服务。',
    tags: ['模型'],
  },
  {
    id: 'event-registry',
    name: '会话事件',
    description: '管理插件声明的会话事件及其持久化边界。',
    tags: ['事件'],
  },
  {
    id: 'host-services',
    name: '宿主服务',
    description: '向插件提供受控的审批与会话存储服务。',
    tags: ['服务'],
  },
  {
    id: 'server-tool-host',
    name: '工具执行宿主',
    description: '将内置工具连接到共享执行与审批流程。',
    tags: ['工具', '审批'],
  },
] as const;

export const maxPluginMarketplaceBytes = 512 * 1024;

function compatible(manifest: PluginManifest, hostVersion: string): 'compatible' | 'incompatible' {
  if (
    manifest.apiVersion !== pluginApiVersion ||
    !['in-process', 'declarative'].includes(manifest.host ?? 'in-process')
  )
    return 'incompatible';
  try {
    assertEngineSupported(manifest, hostVersion);
    return 'compatible';
  } catch {
    return 'incompatible';
  }
}

function compareVersions(left: string, right: string): number {
  // Decimal strings avoid precision loss for valid manifest versions above 2^53.
  const leftParts = left.split('.').map((part) => part.replace(/^0+(?=\d)/, ''));
  const rightParts = right.split('.').map((part) => part.replace(/^0+(?=\d)/, ''));
  for (let index = 0; index < 3; index++) {
    const a = leftParts[index]!;
    const b = rightParts[index]!;
    if (a.length !== b.length) return b.length - a.length;
    if (a !== b) return a < b ? 1 : -1;
  }
  return 0;
}

/** Reads a bounded snapshot once; malformed discovery never prevents agent startup. */
export async function loadPluginMarketplaceCatalog(
  file: string | false | undefined,
  reservedIds: readonly string[] = [],
): Promise<PluginMarketplaceCatalog> {
  if (file === undefined || file === false) return { communityStatus: 'unconfigured', plugins: [] };
  try {
    if (!isAbsolute(file) || file.includes('\0')) throw new Error('Invalid catalog path');
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxPluginMarketplaceBytes)
        throw new Error('Invalid catalog file');
      const bytes = Buffer.alloc(maxPluginMarketplaceBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > maxPluginMarketplaceBytes) throw new Error('Catalog exceeds limit');
      const payload: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
      );
      const parsed = pluginMarketplaceIndexSchema.parse(payload);
      const reserved = new Set<string>([...official.map(({ id }) => id), ...reservedIds]);
      if (parsed.plugins.some(({ id }) => reserved.has(id)))
        throw new Error('Reserved catalog identity');
      return { communityStatus: 'ready', plugins: parsed.plugins };
    } finally {
      await handle.close();
    }
  } catch {
    return { communityStatus: 'unavailable', plugins: [] };
  }
}

/** Projects cached discovery and code-owned builtins without acquisition or management effects. */
export function projectPluginMarketplace(
  catalog: PluginMarketplaceCatalog,
  plugins: readonly PluginListItem[],
  hostVersion: string,
): PluginMarketplaceResponse {
  const builtins = official.flatMap((item) => {
    const actual = plugins.find((plugin) => plugin.id === item.id && plugin.origin === 'builtin');
    return actual === undefined
      ? []
      : [
          {
            ...item,
            kind: 'builtin',
            category: 'official',
            publisher: 'Weave',
            version: actual.version,
          },
        ];
  });
  return pluginMarketplaceResponseSchema.parse({
    schemaVersion: 1,
    hostVersion,
    communityStatus: catalog.communityStatus,
    entries: [
      ...builtins,
      ...catalog.plugins.map((plugin) => ({
        ...plugin,
        kind: 'github',
        category: 'community',
        releases: [...plugin.releases]
          .sort((a, b) => compareVersions(a.manifest.version, b.manifest.version))
          .map((item) => ({ ...item, compatibility: compatible(item.manifest, hostVersion) })),
      })),
    ],
  });
}
