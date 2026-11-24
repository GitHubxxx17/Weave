import type { McpServerConfig, McpServerRecord } from './mcp-types.js';

/** The exact canonical configuration and CAS tokens a user opened for review. */
export interface McpReview {
  readonly config: McpServerConfig;
  readonly configDigest: string;
  readonly authoritySequence: number;
  readonly reviewEpoch: number;
  readonly reviewedConfig?: McpServerConfig;
}

export interface McpConfigChange {
  readonly field: 'label' | 'command' | 'args' | 'cwd' | 'env' | 'contentPaths';
  readonly before: string;
  readonly after: string;
}

function copyConfig(config: McpServerConfig): McpServerConfig {
  return Object.freeze({
    ...config,
    args: Object.freeze([...config.args]),
    ...(config.contentPaths === undefined
      ? {}
      : { contentPaths: Object.freeze([...config.contentPaths]) }),
    env: Object.freeze(
      Object.fromEntries(
        Object.entries(config.env).map(([target, reference]) => [
          target,
          Object.freeze({ fromHostEnv: reference.fromHostEnv }),
        ]),
      ),
    ),
  });
}

/** Later catalog updates cannot change the identity or contents being approved. */
export function createMcpReview(
  record: McpServerRecord,
  authoritySequence: number,
  reviewEpoch: number,
): McpReview {
  return Object.freeze({
    config: copyConfig(record.config),
    configDigest: record.configDigest,
    authoritySequence,
    reviewEpoch,
    ...(record.reviewedConfig === undefined
      ? {}
      : { reviewedConfig: copyConfig(record.reviewedConfig) }),
  });
}

function envText(config: McpServerConfig): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(config.env).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

/** Ordered argv is compared literally; environment mapping order is irrelevant. */
export function diffMcpConfig(
  before: McpServerConfig,
  after: McpServerConfig,
): readonly McpConfigChange[] {
  const fields: readonly McpConfigChange[] = [
    { field: 'label', before: before.label, after: after.label },
    { field: 'command', before: before.command, after: after.command },
    { field: 'args', before: JSON.stringify(before.args), after: JSON.stringify(after.args) },
    { field: 'cwd', before: before.cwd, after: after.cwd },
    { field: 'env', before: envText(before), after: envText(after) },
    {
      field: 'contentPaths',
      before: JSON.stringify(before.contentPaths ?? []),
      after: JSON.stringify(after.contentPaths ?? []),
    },
  ];
  return fields.filter((change) => change.before !== change.after);
}

const absolutePath = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/** Absolute paths in `args` that are not yet bound through `contentPaths`. */
export function unboundArgumentPaths(
  args: readonly string[],
  contentPaths: readonly string[] = [],
): readonly string[] {
  return [...new Set(args.filter((arg) => absolutePath.test(arg)))].filter(
    (arg) => !contentPaths.includes(arg),
  );
}

/**
 * True for launchers that download and run code on every start (`npx`, `uvx`, `bunx`,
 * `pnpm dlx`), so file content binding cannot cover what actually runs.
 */
export function isPackageRunner(config: Pick<McpServerConfig, 'command' | 'args'>): boolean {
  const name = (config.command.split(/[\\/]/).pop() ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd)$/, '');
  if (['npx', 'uvx', 'bunx', 'pnpx'].includes(name)) return true;
  return name === 'pnpm' && config.args[0] === 'dlx';
}
