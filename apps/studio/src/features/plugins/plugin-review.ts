import {
  pluginManifestProjectionSchema,
  type PluginDeclarations,
  type PluginListItem,
  type PluginManifestProjection,
} from './plugin-types.js';

export interface PluginReview {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  readonly directory: string;
  readonly digest: string;
  readonly manifest: PluginManifestProjection;
  readonly previousTrusted?: {
    readonly digest: string;
    readonly manifest: PluginManifestProjection;
  };
}

export type PluginDeclarationCategory = 'capabilities' | keyof PluginDeclarations | 'permissions';

export interface PluginDeclarationChange {
  readonly category: PluginDeclarationCategory;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

const digestPattern = /^[a-f0-9]{64}$/;
const declarationCategories: readonly PluginDeclarationCategory[] = [
  'capabilities',
  'tools',
  'providers',
  'promptSections',
  'events',
  'commands',
  'skills',
  'panels',
  'hooks',
  'services',
  'permissions',
];

function copyManifest(manifest: PluginManifestProjection): PluginManifestProjection {
  return {
    ...manifest,
    capabilities: [...manifest.capabilities],
    ...(manifest.engines === undefined ? {} : { engines: { ...manifest.engines } }),
    ...(manifest.contributes === undefined
      ? {}
      : {
          contributes: Object.fromEntries(
            Object.entries(manifest.contributes).map(([key, values]) => [
              key,
              values === undefined ? undefined : [...values],
            ]),
          ) as PluginDeclarations,
        }),
    ...(manifest.permissions === undefined ? {} : { permissions: [...manifest.permissions] }),
  };
}

/** Captures review data so later catalog refreshes cannot change a dialog. */
export function createPluginReview(plugin: PluginListItem): PluginReview | undefined {
  const local = plugin.local;
  if (
    plugin.origin !== 'local' ||
    local === undefined ||
    typeof local.directory !== 'string' ||
    local.directory.length === 0 ||
    typeof local.digest !== 'string' ||
    !digestPattern.test(local.digest)
  ) {
    return undefined;
  }
  const parsed = pluginManifestProjectionSchema.safeParse(local.manifest);
  if (!parsed.success || parsed.data.id !== plugin.id) return undefined;

  const trusted = local.trusted;
  const previousTrusted =
    trusted !== undefined &&
    digestPattern.test(trusted.digest) &&
    pluginManifestProjectionSchema.safeParse(trusted.manifest).success
      ? { digest: trusted.digest, manifest: copyManifest(trusted.manifest) }
      : undefined;

  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    directory: local.directory,
    digest: local.digest,
    manifest: copyManifest(parsed.data),
    ...(previousTrusted === undefined ? {} : { previousTrusted }),
  };
}

function valuesFor(
  manifest: PluginManifestProjection,
  category: PluginDeclarationCategory,
): readonly string[] {
  if (category === 'capabilities') return manifest.capabilities;
  if (category === 'permissions') return manifest.permissions ?? [];
  return manifest.contributes?.[category] ?? [];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Returns only declaration categories whose set of entries changed. */
export function diffManifestDeclarations(
  previous: PluginManifestProjection,
  next: PluginManifestProjection,
): readonly PluginDeclarationChange[] {
  return declarationCategories.flatMap((category) => {
    const before = unique(valuesFor(previous, category));
    const after = unique(valuesFor(next, category));
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added = after.filter((value) => !beforeSet.has(value));
    const removed = before.filter((value) => !afterSet.has(value));
    return added.length === 0 && removed.length === 0
      ? []
      : [{ category, added, removed } satisfies PluginDeclarationChange];
  });
}

const impacts: Readonly<
  Record<
    'hook' | 'permission',
    Readonly<Record<string, Omit<ReturnType<typeof pluginImpact>, 'recognized'>>>
  >
> = {
  hook: {
    'weave.llm.request': { level: 'high', description: '能看到并改写发给模型的全部内容' },
    'weave.tools.around': { level: 'high', description: '能改写工具调用的参数和结果' },
    'weave.tools.result': { level: 'medium', description: '能读到每次工具调用的结果' },
    'weave.tools.policy': { level: 'low', description: '只能拒绝或要求确认工具调用，不能放行' },
    'weave.turn.start': { level: 'low', description: '知道回合何时开始和结束' },
    'weave.turn.end': { level: 'low', description: '知道回合何时开始和结束' },
  },
  permission: {
    'process:spawn': { level: 'high', description: '运行进程' },
    'workspace:write': { level: 'high', description: '写入工作区' },
    'network:request': { level: 'high', description: '访问网络' },
    'workspace:read': { level: 'medium', description: '读取工作区' },
    'service:weave.session.store': { level: 'high', description: '读取全部会话内容' },
  },
};

export function pluginImpact(
  kind: 'hook' | 'permission',
  value: string,
): {
  readonly level: 'high' | 'medium' | 'low';
  readonly description: string;
  readonly recognized: boolean;
} {
  const known = Object.hasOwn(impacts[kind], value) ? impacts[kind][value] : undefined;
  if (known !== undefined) return { ...known, recognized: true };
  if (kind === 'permission' && value.startsWith('service:')) {
    return { level: 'medium', description: '使用宿主服务', recognized: true };
  }
  return {
    level: 'high',
    description:
      kind === 'hook' ? '未识别的钩子，可能影响插件行为' : '未识别的权限，可能扩大插件能力',
    recognized: false,
  };
}
