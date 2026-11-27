import { lstat, readdir, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { resolveMemoryDatabaseFile, resolveRetrievalDatabaseFile } from './persistence-path.js';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, Hono } from 'hono';
import { z } from 'zod';

/** Entries counted per location before the size is reported as a lower bound. */
export const defaultStorageEntryLimit = 200_000;

const sqliteSidecars = ['-journal', '-wal', '-shm'] as const;

/** A storage location the Server really uses, resolved at startup. */
export interface StorageLocation {
  /** Stable identifier; Studio maps it to a display name. */
  readonly id: string;
  readonly kind: 'file' | 'directory';
  /** Absolute path. */
  readonly path: string;
  /** SQLite database: `-journal`, `-wal` and `-shm` files count toward the size. */
  readonly sqlite?: boolean;
}

export interface StorageConfig {
  readonly dataDirectory: string;
  /** Locations that are enabled; disabled ones (for example `pluginsDirectory: false`) are omitted. */
  readonly locations: readonly StorageLocation[];
}

export interface StorageAppOptions {
  readonly storage?: StorageConfig | undefined;
  /** Test seam: resolves the peer address of a request. Defaults to the Node connection info. */
  readonly storageRemoteAddress?: ((context: Context) => string | undefined) | undefined;
  /** Test seam: overrides {@link defaultStorageEntryLimit}. */
  readonly storageEntryLimit?: number | undefined;
}

export interface StorageConfigInput {
  readonly databaseFile: string;
  /** `false` when local plugin discovery is disabled. */
  readonly pluginsDirectory: string | false;
  /** `false` when the user Skill root is disabled. */
  readonly skillsDirectory: string | false;
}

/**
 * Lists the locations `startServer` actually opens, derived from the same
 * resolved inputs: the main database (Sessions, projects, Provider settings,
 * MCP and plugin authority), its Memory and Retrieval sidecars, the marketplace
 * source settings, and the plugin and Skill directories when enabled.
 */
export async function createStorageConfig(input: StorageConfigInput): Promise<StorageConfig> {
  const databaseFile = resolve(input.databaseFile);
  const locations: StorageLocation[] = [
    { id: 'database', kind: 'file', path: databaseFile, sqlite: true },
    {
      id: 'memory',
      kind: 'file',
      path: await resolveMemoryDatabaseFile(databaseFile),
      sqlite: true,
    },
    {
      id: 'retrieval',
      kind: 'file',
      path: await resolveRetrievalDatabaseFile(databaseFile),
      sqlite: true,
    },
    {
      id: 'pluginMarketplaceSources',
      kind: 'file',
      path: `${databaseFile}.plugin-marketplace-sources.json`,
    },
  ];
  if (input.pluginsDirectory !== false) {
    locations.push({ id: 'plugins', kind: 'directory', path: resolve(input.pluginsDirectory) });
  }
  if (input.skillsDirectory !== false) {
    locations.push({ id: 'skills', kind: 'directory', path: resolve(input.skillsDirectory) });
  }
  return { dataDirectory: dirname(databaseFile), locations };
}

const storageLocationResponseSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(['file', 'directory']),
  path: z.string().min(1),
  exists: z.boolean(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
  error: z.enum(['permission-denied', 'read-failed', 'kind-mismatch']).optional(),
});

export const storageResponseSchema = z.strictObject({
  dataDirectory: z.string().min(1),
  locations: z.array(storageLocationResponseSchema),
});

type StorageLocationResponse = z.infer<typeof storageLocationResponseSchema>;

function errorCode(error: unknown): 'permission-denied' | 'read-failed' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM' ? 'permission-denied' : 'read-failed';
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Sums a directory without following symbolic links; stops after `limit` entries. */
async function measureDirectory(
  root: string,
  limit: number,
): Promise<{ readonly sizeBytes: number; readonly truncated: boolean }> {
  let sizeBytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    // An unreadable directory fails the whole location (reported as `error`),
    // because a silently partial size would look complete.
    const names = await readdir(directory);
    for (const name of names) {
      if (entries >= limit) return { sizeBytes, truncated: true };
      entries += 1;
      const child = join(directory, name);
      const info = await lstat(child).catch((error: unknown) => {
        if (isMissing(error)) return undefined; // removed while scanning
        throw error;
      });
      if (info === undefined) continue;
      if (info.isDirectory()) {
        pending.push(child);
      } else {
        sizeBytes += info.size;
      }
    }
  }
  return { sizeBytes, truncated: false };
}

async function measureLocation(
  location: StorageLocation,
  limit: number,
): Promise<StorageLocationResponse> {
  const base = { id: location.id, kind: location.kind, path: location.path };
  try {
    const info = await stat(location.path);
    if (location.kind === 'directory') {
      if (!info.isDirectory()) {
        return { ...base, exists: true, sizeBytes: null, truncated: false, error: 'kind-mismatch' };
      }
      const measured = await measureDirectory(location.path, limit);
      return { ...base, exists: true, ...measured };
    }
    if (!info.isFile()) {
      return { ...base, exists: true, sizeBytes: null, truncated: false, error: 'kind-mismatch' };
    }
    let sizeBytes = info.size;
    if (location.sqlite === true) {
      for (const suffix of sqliteSidecars) {
        const sidecar = await lstat(`${location.path}${suffix}`).catch((error: unknown) => {
          if (isMissing(error)) return undefined;
          throw error;
        });
        if (sidecar?.isFile()) sizeBytes += sidecar.size;
      }
    }
    return { ...base, exists: true, sizeBytes, truncated: false };
  } catch (error) {
    if (isMissing(error)) {
      return { ...base, exists: false, sizeBytes: null, truncated: false };
    }
    return { ...base, exists: true, sizeBytes: null, truncated: false, error: errorCode(error) };
  }
}

/** True for `127.0.0.0/8`, `::1` and IPv4-mapped IPv6 loopback such as `::ffff:127.0.0.1`. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const value = address.trim().toLowerCase();
  const kind = isIP(value);
  if (kind === 4) return value.startsWith('127.');
  if (kind !== 6) return false;
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true;
  const mapped = /^(?:::|0:0:0:0:0:)ffff:(.+)$/.exec(value)?.[1];
  if (mapped === undefined) return false;
  if (isIP(mapped) === 4) return mapped.startsWith('127.');
  return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped);
}

function nodeRemoteAddress(context: Context): string | undefined {
  try {
    return getConnInfo(context).remote.address;
  } catch {
    return undefined;
  }
}

/**
 * Mounts `GET /settings/storage`, the read-only view of where the Server keeps data.
 *
 * The response carries absolute local paths, so only loopback peers may read it,
 * even when the Server listens on the LAN and the caller holds the access token.
 */
export function registerStorageRoutes(app: Hono, options: StorageAppOptions): void {
  const remoteAddress = options.storageRemoteAddress ?? nodeRemoteAddress;
  const limit = options.storageEntryLimit ?? defaultStorageEntryLimit;

  app.get('/settings/storage', async (context) => {
    context.header('Cache-Control', 'no-store');
    if (!isLoopbackAddress(remoteAddress(context))) {
      return context.json(
        {
          error: {
            code: 'storage-local-only',
            message: '存储位置只能在运行 Weave 的这台电脑上查看',
          },
        },
        403,
      );
    }
    const storage = options.storage;
    if (storage === undefined) {
      return context.json(
        { error: { code: 'storage-unavailable', message: '存储位置信息不可用' } },
        503,
      );
    }
    const locations = await Promise.all(storage.locations.map((l) => measureLocation(l, limit)));
    return context.json(
      storageResponseSchema.parse({ dataDirectory: storage.dataDirectory, locations }),
    );
  });
}
