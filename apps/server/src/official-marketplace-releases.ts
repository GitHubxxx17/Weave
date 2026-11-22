import type { PluginManifest } from '@weave/plugin';
import { githubPluginSourceSchema, type GithubPluginSource } from '@weave/plugin-host';
import { z } from 'zod';
import { artifactManifestSchema, pluginIdSchema } from './plugin-authority-types.js';

/** Builtin reservations are distinct from protected, installable distributed IDs. */
export const reservedMarketplacePluginIds = [
  'tool-registry',
  'provider-registry',
  'event-registry',
  'host-services',
  'server-tool-host',
] as const;

/** Index sources must already be canonical, with an explicitly supplied path. */
export const marketplaceGithubSourceSchema = githubPluginSourceSchema.extend({
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

const familySchema = z
  .strictObject({
    id: pluginIdSchema.max(200),
    name: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(2000),
    publisher: z.literal('Weave'),
    tags: z.array(z.string().trim().min(1).max(40)).max(10),
    releases: z.array(
      z.strictObject({ manifest: artifactManifestSchema, source: marketplaceGithubSourceSchema }),
    ),
  })
  .superRefine((family, context) => {
    if ((reservedMarketplacePluginIds as readonly string[]).includes(family.id))
      context.addIssue({
        code: 'custom',
        message: 'Official family conflicts with builtin identity',
      });
    const versions = new Set<string>();
    for (const release of family.releases) {
      if (release.manifest.id !== family.id || versions.has(release.manifest.version))
        context.addIssue({ code: 'custom', message: 'Conflicting official release identity' });
      versions.add(release.manifest.version);
    }
  });

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
type OfficialReleaseFamily = DeepReadonly<z.infer<typeof familySchema>>;
type OfficialDisplayMetadata = Pick<
  OfficialReleaseFamily,
  'name' | 'description' | 'publisher' | 'tags'
>;

interface MarketplaceEntryIdentity {
  readonly id: string;
  readonly releases: readonly {
    readonly manifest: PluginManifest;
    readonly source: GithubPluginSource;
  }[];
}

type OfficialClassification =
  | { readonly category: 'community' }
  | { readonly category: 'official'; readonly display: OfficialDisplayMetadata };

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

/** Construction validates and owns a deeply frozen snapshot; no caller can register live releases. */
export function createOfficialMarketplacePolicy(input: unknown) {
  const parsed = z.array(familySchema).parse(input);
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length)
    throw new Error('Duplicate official marketplace family');
  const families = deepFreeze(parsed);
  function assertEntry(entry: MarketplaceEntryIdentity): OfficialClassification {
    const family = families.find(({ id }) => id === entry.id);
    if (family === undefined) return { category: 'community' };
    if (
      entry.releases.length === 0 ||
      entry.releases.some(
        (release) =>
          !family.releases.some((allowed) => canonicalJson(allowed) === canonicalJson(release)),
      )
    )
      throw new Error('Unrecognized official marketplace release');
    return {
      category: 'official',
      display: {
        name: family.name,
        description: family.description,
        publisher: family.publisher,
        tags: family.tags,
      },
    };
  }
  return Object.freeze({ families, assertEntry });
}

// Released tuples are append-only. Register an actual reviewed content commit
// before acquiring/generating its submission; never substitute a placeholder pin.
const officialMarketplacePolicy = createOfficialMarketplacePolicy([
  {
    id: 'weave-official-skills',
    name: 'Weave 官方技能',
    description: 'Weave 维护的使用指南、插件开发、技能创作与 MCP 配置技能。',
    publisher: 'Weave',
    tags: ['Weave', '技能', '开发指南'],
    releases: [],
  },
]);

export const assertOfficialMarketplaceEntry = officialMarketplacePolicy.assertEntry;
