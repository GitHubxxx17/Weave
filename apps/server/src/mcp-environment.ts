import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { computeDirectoryDigest, PluginHostError } from '@weave/plugin-host';
import { z } from 'zod';
import { McpAuthorityError } from './mcp-errors.js';

export interface McpServerConfig {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly label: string;
  readonly transport: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, { readonly fromHostEnv: string }>>;
  /** Absolute files or directories whose content is bound into the trust digest (policy 2). */
  readonly contentPaths?: readonly string[] | undefined;
}

/** Most paths a configuration may bind to its trust digest. */
export const maxMcpContentPaths = 16;

export interface ResolvedMcpEnvironment {
  readonly env: Readonly<Record<string, string>>;
  readonly redactValues: readonly string[];
}

export const mcpServerIdSchema = z
  .string()
  .max(24)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const mcpConfigDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const variableName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  .refine((name) => !/^WEAVE_/i.test(name));
const referenceSchema = z.strictObject({ fromHostEnv: variableName });
const invalidMessage = 'MCP launch configuration is invalid';

/** Recursively freezes JSON-shaped data after validation has cloned its containers. */
export function freezeMcpValue<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMcpValue(child);
    Object.freeze(value);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) as string;
}

/** The platform parameter is for deterministic host-policy tests, never user input. */
export function createMcpServerConfigSchema(
  platform: NodeJS.Platform = process.platform,
): z.ZodType<McpServerConfig> {
  const environment = z.unknown().transform((input, context): McpServerConfig['env'] => {
    try {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const entries = Object.entries(descriptors);
      if (entries.length > 32 || Object.getOwnPropertySymbols(input).length > 0) throw new Error();
      const targets = new Set<string>();
      const references = new Map<string, string>();
      const result: Record<string, { readonly fromHostEnv: string }> = {};
      for (const [key, descriptor] of entries) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error();
        variableName.parse(key);
        const reference = referenceSchema.parse(descriptor.value);
        const target = platform === 'win32' ? key.toUpperCase() : key;
        const fromHostEnv =
          platform === 'win32' ? reference.fromHostEnv.toUpperCase() : reference.fromHostEnv;
        if (
          platform === 'win32' &&
          (targets.has(target) ||
            (references.has(fromHostEnv) && references.get(fromHostEnv) !== reference.fromHostEnv))
        )
          throw new Error();
        targets.add(target);
        references.set(fromHostEnv, reference.fromHostEnv);
        // Defining an own property preserves the valid variable name __proto__.
        Object.defineProperty(result, target, {
          value: { fromHostEnv },
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    } catch {
      context.addIssue({ code: 'custom', message: invalidMessage });
      return z.NEVER;
    }
  });
  const hostPath = platform === 'win32' ? path.win32 : path.posix;
  return z
    .strictObject({
      schemaVersion: z.literal(1),
      id: mcpServerIdSchema,
      label: z.string().min(1).max(80),
      transport: z.literal('stdio'),
      command: z
        .string()
        .min(1)
        .refine(
          (value) =>
            !value.includes('\0') &&
            hostPath.isAbsolute(value) &&
            (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(value)),
        ),
      args: z
        .array(
          z
            .string()
            .refine((value) => !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= 4096),
        )
        .max(64),
      cwd: z
        .string()
        .min(1)
        .refine((value) => !value.includes('\0') && hostPath.isAbsolute(value)),
      env: environment,
      contentPaths: z
        .array(
          z
            .string()
            .min(1)
            .refine((value) => !value.includes('\0') && hostPath.isAbsolute(value)),
        )
        .max(maxMcpContentPaths)
        .optional(),
    })
    .refine((value) => Buffer.byteLength(canonicalJson(value), 'utf8') <= 64 * 1024);
}

export const mcpServerConfigSchema = createMcpServerConfigSchema();

function parseConfig(input: unknown): McpServerConfig {
  try {
    return mcpServerConfigSchema.parse(input);
  } catch {
    throw new McpAuthorityError('mcp-invalid', invalidMessage);
  }
}

async function checkedPaths(config: McpServerConfig): Promise<{
  readonly command: string;
  readonly cwd: string;
  readonly contentPaths?: readonly string[];
}> {
  const command = await realpath(config.command);
  const cwd = await realpath(config.cwd);
  const [commandInfo, cwdInfo] = await Promise.all([stat(command), stat(cwd)]);
  if (!commandInfo.isFile() || !cwdInfo.isDirectory()) throw new Error();
  await access(command, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
  if (config.contentPaths === undefined) return { command, cwd };
  const contentPaths = await Promise.all(
    config.contentPaths.map(async (value) => {
      const resolved = await realpath(value);
      const info = await stat(resolved);
      if (!info.isFile() && !info.isDirectory()) throw new Error();
      return resolved;
    }),
  );
  return { command, cwd, contentPaths };
}

export async function normalizeMcpServerConfig(input: unknown): Promise<McpServerConfig> {
  const config = parseConfig(input);
  try {
    const paths = await checkedPaths(config);
    return freezeMcpValue(parseConfig({ ...config, ...paths }));
  } catch {
    throw new McpAuthorityError('mcp-invalid', invalidMessage);
  }
}

/**
 * Policy 1 digest: launch configuration only. It cannot show that the program
 * behind `command` is unchanged. Kept so persisted policy 1 events replay.
 */
export function mcpConfigDigest(config: McpServerConfig): string {
  const parsed = parseConfig(config);
  const { schemaVersion, id, transport, command, args, cwd, env } = parsed;
  return createHash('sha256')
    .update(
      canonicalJson({ schemaVersion, id, transport, command, args, cwd, env, policyVersion: 1 }),
      'utf8',
    )
    .digest('hex');
}

/** Policy 2 digest: launch configuration plus the content digest of the program and bound paths. */
export function mcpConfigDigestV2(config: McpServerConfig, contentDigest: string): string {
  const parsed = parseConfig(config);
  const { schemaVersion, id, transport, command, args, cwd, env } = parsed;
  return createHash('sha256')
    .update(
      canonicalJson({
        schemaVersion,
        id,
        transport,
        command,
        args,
        cwd,
        env,
        contentPaths: parsed.contentPaths ?? [],
        contentDigest: mcpConfigDigestSchema.parse(contentDigest),
        policyVersion: 2,
      }),
      'utf8',
    )
    .digest('hex');
}

const fileHashCache = new Map<string, string>();

/**
 * Hashes file bytes. Results are cached in memory by path, inode, size, mtime and ctime
 * (nanosecond precision). ctime cannot be set from user space, so a rewrite that keeps the
 * same size and mtime still changes the key.
 */
async function hashFile(file: string): Promise<string> {
  const before = await stat(file, { bigint: true });
  const key = `${file}\0${before.ino}\0${before.size}\0${before.mtimeNs}\0${before.ctimeNs}`;
  const cached = fileHashCache.get(key);
  if (cached !== undefined) return cached;
  const digest = await new Promise<string>((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  const after = await stat(file, { bigint: true });
  // A file written while it was being read is not cached.
  if (
    after.size === before.size &&
    after.mtimeNs === before.mtimeNs &&
    after.ctimeNs === before.ctimeNs
  ) {
    if (fileHashCache.size >= 64) fileHashCache.clear();
    fileHashCache.set(key, digest);
  }
  return digest;
}

/**
 * Hashes the program `command` points at and every bound content path.
 *
 * - `command` and file paths: sha256 of the bytes, no size cap.
 * - directories: `computeDirectoryDigest` from `@weave/plugin-host` (same format as plugin
 *   directories: at most 1000 files and 20 MB, symbolic links and special files refused).
 *
 * Paths are resolved with `realpath` first. A directory over the limits or an unreadable path
 * raises `mcp-content-too-large` or `mcp-content-unreadable`.
 */
export async function computeMcpContentDigest(config: McpServerConfig): Promise<string> {
  const parsed = parseConfig(config);
  try {
    const command = await hashFile(await realpath(parsed.command));
    const bound = [];
    for (const value of parsed.contentPaths ?? []) {
      const resolved = await realpath(value);
      const info = await stat(resolved);
      if (info.isDirectory()) {
        const { digest } = await computeDirectoryDigest(resolved);
        bound.push({ path: resolved, kind: 'directory', digest });
      } else if (info.isFile()) {
        bound.push({ path: resolved, kind: 'file', digest: await hashFile(resolved) });
      } else throw new Error();
    }
    return createHash('sha256')
      .update(canonicalJson({ command, contentPaths: bound }), 'utf8')
      .digest('hex');
  } catch (error: unknown) {
    if (error instanceof PluginHostError && error.code === 'plugin-too-large')
      throw new McpAuthorityError('mcp-content-too-large');
    throw new McpAuthorityError('mcp-content-unreadable');
  }
}

export async function recheckMcpLaunchPaths(config: McpServerConfig): Promise<void> {
  const parsed = parseConfig(config);
  try {
    const paths = await checkedPaths(parsed);
    if (paths.command !== parsed.command || paths.cwd !== parsed.cwd) throw new Error();
    if (!isSameList(paths.contentPaths, parsed.contentPaths)) throw new Error();
  } catch {
    throw new McpAuthorityError('mcp-invalid', invalidMessage);
  }
}

function isSameList(left: readonly string[] | undefined, right: readonly string[] | undefined) {
  const a = left ?? [];
  const b = right ?? [];
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function resolveMcpEnvironment(
  config: McpServerConfig,
  options: { readonly readHostVariable?: (name: string) => string | undefined } = {},
): ResolvedMcpEnvironment {
  const parsed = parseConfig(config);
  try {
    const read = options.readHostVariable ?? ((name: string) => process.env[name]);
    const values = new Map<string, string>();
    const env: Record<string, string> = {};
    for (const [target, reference] of Object.entries(parsed.env)) {
      let value = values.get(reference.fromHostEnv);
      if (value === undefined) {
        value = read(reference.fromHostEnv);
        if (typeof value !== 'string') throw new Error();
        values.set(reference.fromHostEnv, value);
      }
      Object.defineProperty(env, target, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return freezeMcpValue({
      env,
      redactValues: [...new Set(values.values())].filter((value) => value.length > 0),
    });
  } catch {
    throw new McpAuthorityError('mcp-invalid', 'MCP environment references could not be resolved');
  }
}
