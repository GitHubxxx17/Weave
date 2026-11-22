import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { PluginArtifactError } from './artifact-types.js';
import { descriptorFileName, maxDescriptorBytes } from './descriptor.js';
import {
  appendDigestFile,
  compareDigestPaths,
  defaultDigestLimits,
  ignoredNames,
  type DirectoryDigest,
} from './digest.js';

const maxDepth = 64;
const maxEntries = 2_000;
const maxAbandonedOperations = 64;
const operationName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

interface PayloadEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly stat: BigIntStats;
}

export interface CheckedPayload extends DirectoryDigest {
  readonly descriptorText: string | undefined;
  readonly paths: ReadonlySet<string>;
}

interface CheckPayloadOptions {
  readonly destination?: string;
  readonly reviewed?: boolean;
}

function tooLarge(bound: string): PluginArtifactError {
  return new PluginArtifactError('plugin-artifact-too-large', `Plugin payload exceeds ${bound}`);
}

export function hasCode(error: unknown, ...codes: readonly string[]): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string' &&
    codes.includes(error.code)
  );
}

export function sourceChanged(cause?: unknown): PluginArtifactError {
  return new PluginArtifactError(
    'plugin-artifact-source-changed',
    'The plugin source changed while staging. Submit a new request to stage its current bytes',
    { cause },
  );
}

function sameFile(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

async function assertUnchanged(file: PayloadEntry): Promise<void> {
  const current = await fs.lstat(file.absolutePath, { bigint: true });
  if (!sameFile(file.stat, current)) throw sourceChanged();
}

async function listPayload(
  directory: string,
  signal: AbortSignal | undefined,
): Promise<{
  readonly files: PayloadEntry[];
  readonly directories: PayloadEntry[];
}> {
  const files: PayloadEntry[] = [];
  const directories: PayloadEntry[] = [];
  let entries = 0;
  let bytes = 0;

  const walk = async (parent: PayloadEntry, depth: number): Promise<void> => {
    signal?.throwIfAborted();
    await assertUnchanged(parent);
    for await (const entry of await fs.opendir(parent.absolutePath)) {
      signal?.throwIfAborted();
      if (ignoredNames.has(entry.name)) continue;
      entries += 1;
      if (entries > maxEntries) throw tooLarge(`${maxEntries} filesystem entries`);
      const relativePath = parent.relativePath
        ? `${parent.relativePath}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(parent.absolutePath, entry.name);
      const stat = await fs.lstat(absolutePath, { bigint: true });
      const item = { relativePath, absolutePath, stat };
      if (stat.isDirectory()) {
        if (depth >= maxDepth) throw tooLarge(`${maxDepth} directory levels`);
        directories.push(item);
        await walk(item, depth + 1);
      } else if (stat.isFile()) {
        if (relativePath === descriptorFileName && stat.size > maxDescriptorBytes) {
          throw new PluginArtifactError(
            'plugin-artifact-invalid',
            `The plugin descriptor exceeds ${maxDescriptorBytes / 1024} KiB`,
          );
        }
        files.push(item);
        bytes += Number(stat.size);
        if (files.length > defaultDigestLimits.maxFiles) {
          throw tooLarge(`${defaultDigestLimits.maxFiles} files`);
        }
        if (bytes > defaultDigestLimits.maxBytes) {
          throw tooLarge(`${defaultDigestLimits.maxBytes / 1024 / 1024} MiB of file bytes`);
        }
      } else {
        throw new PluginArtifactError(
          'plugin-artifact-unsupported-file',
          'Plugin payloads may contain only regular files and real directories',
        );
      }
    }
    await assertUnchanged(parent);
  };

  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory()) {
    throw new PluginArtifactError(
      'plugin-artifact-unsupported-file',
      'The payload must be a real directory',
    );
  }
  const root = { relativePath: '', absolutePath: directory, stat };
  await walk(root, 0);
  files.sort(compareDigestPaths);
  return { files, directories: [root, ...directories] };
}

async function usingFile<T>(
  handle: FileHandle,
  use: (handle: FileHandle) => Promise<T>,
  reviewed: boolean,
): Promise<T> {
  let result: T;
  try {
    result = await use(handle);
  } catch (error: unknown) {
    try {
      await handle.close();
    } catch (cleanup: unknown) {
      throw new PluginArtifactError('plugin-artifact-io', 'Closing a plugin payload file failed', {
        cause: new AggregateError([error, cleanup]),
      });
    }
    throw error;
  }
  try {
    await handle.close();
  } catch (error: unknown) {
    if (!reviewed) throw error;
    throw new PluginArtifactError('plugin-artifact-io', 'Closing a plugin payload file failed', {
      cause: error,
    });
  }
  return result;
}

async function openSource(
  entry: PayloadEntry,
  signal: AbortSignal | undefined,
): Promise<FileHandle> {
  await assertUnchanged(entry);
  try {
    return await fs.open(entry.absolutePath, readFlags);
  } catch (error: unknown) {
    if (signal?.aborted && Object.is(error, signal.reason)) throw error;
    if (hasCode(error, 'ELOOP', 'ENOENT', 'ENOTDIR')) throw sourceChanged(error);
    throw error;
  }
}

async function writeChunk(output: FileHandle, buffer: Buffer, size: number): Promise<void> {
  let offset = 0;
  while (offset < size) {
    const { bytesWritten } = await output.write(buffer, offset, size - offset, null);
    if (bytesWritten === 0) {
      throw new PluginArtifactError(
        'plugin-artifact-io',
        'A plugin payload write made no progress',
      );
    }
    offset += bytesWritten;
  }
}

/** Validates the bounded tree first, then frames its sorted file hashes in the discovery format. */
export async function checkPayload(
  directory: string,
  signal: AbortSignal | undefined,
  { destination, reviewed = false }: CheckPayloadOptions = {},
): Promise<CheckedPayload> {
  // A failed destination operation can have the same errno as source disappearance.
  async function observeSource<T>(observe: () => Promise<T>): Promise<T> {
    try {
      return await observe();
    } catch (error: unknown) {
      if (
        reviewed &&
        destination !== undefined &&
        !(signal?.aborted && Object.is(error, signal.reason)) &&
        hasCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP')
      ) {
        throw sourceChanged(error);
      }
      throw error;
    }
  }

  signal?.throwIfAborted();
  const { files, directories } = await observeSource(() => listPayload(directory, signal));
  if (destination !== undefined) {
    for (const entry of directories.slice(1)) {
      signal?.throwIfAborted();
      await fs.mkdir(path.join(destination, entry.relativePath), { mode: 0o700 });
    }
  }

  const outer = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  let descriptorText: string | undefined;
  for (const entry of files) {
    signal?.throwIfAborted();
    const handle = await observeSource(() => openSource(entry, signal));
    const measured = await usingFile(
      handle,
      async (input) => {
        const stat = () => observeSource(() => input.stat({ bigint: true }));
        if (!sameFile(entry.stat, await stat())) throw sourceChanged();
        const hash = createHash('sha256');
        const descriptor: Buffer[] = [];
        const stream = async (output?: FileHandle): Promise<number> => {
          let size = 0;
          const expectedSize = Number(entry.stat.size);
          while (true) {
            signal?.throwIfAborted();
            // Read at most one extra byte to detect growth without copying beyond the bound.
            const length = Math.min(buffer.length, expectedSize - size + 1);
            const { bytesRead } = await observeSource(() => input.read(buffer, 0, length, null));
            if (bytesRead === 0) break;
            size += bytesRead;
            if (size > expectedSize) throw sourceChanged();
            const chunk = buffer.subarray(0, bytesRead);
            hash.update(chunk);
            if (entry.relativePath === descriptorFileName) descriptor.push(Buffer.from(chunk));
            if (output !== undefined) await writeChunk(output, buffer, bytesRead);
          }
          if (size !== expectedSize || !sameFile(entry.stat, await stat())) {
            throw sourceChanged();
          }
          await observeSource(() => assertUnchanged(entry));
          return size;
        };
        const size =
          destination === undefined
            ? await stream()
            : await usingFile(
                await fs.open(path.join(destination, entry.relativePath), 'wx', 0o600),
                stream,
                reviewed,
              );
        if (entry.relativePath === descriptorFileName) {
          descriptorText = Buffer.concat(descriptor).toString('utf8');
        }
        return { size, hash: hash.digest('hex') };
      },
      reviewed,
    );
    bytes += measured.size;
    appendDigestFile(outer, entry.relativePath, measured.size, measured.hash);
  }
  for (const entry of directories) {
    signal?.throwIfAborted();
    await observeSource(() => assertUnchanged(entry));
  }
  return {
    digest: outer.digest('hex'),
    files: files.length,
    bytes,
    descriptorText,
    paths: new Set(files.map((entry) => entry.relativePath)),
  };
}

/** Lists an owned operation for bounded, bottom-up removal, without following links. */
async function planRemoval(operation: string): Promise<
  readonly {
    readonly absolutePath: string;
    readonly directory: boolean;
  }[]
> {
  const entries: { absolutePath: string; directory: boolean }[] = [];
  let visited = 0;
  const unexpected = () =>
    new PluginArtifactError(
      'plugin-artifact-conflict',
      'An abandoned staging operation has an unexpected structure',
    );
  const walk = async (absolutePath: string, depth: number): Promise<void> => {
    const info = await fs.lstat(absolutePath);
    const directory = info.isDirectory();
    if (depth < 2 && !directory) throw unexpected();
    if (directory) {
      if (depth > maxDepth + 1) {
        throw new PluginArtifactError(
          'plugin-artifact-conflict',
          'An abandoned staging payload exceeds its directory-depth bound',
        );
      }
      for await (const child of await fs.opendir(absolutePath)) {
        if (depth === 0 && child.name !== 'payload') throw unexpected();
        visited += 1;
        if (visited > maxEntries + 1) {
          throw new PluginArtifactError(
            'plugin-artifact-conflict',
            'An abandoned staging payload exceeds its filesystem entry bound',
          );
        }
        await walk(path.join(absolutePath, child.name), depth + 1);
      }
    }
    entries.push({ absolutePath, directory });
  };
  await walk(operation, 0);
  return entries;
}

async function removeEntries(entries: Awaited<ReturnType<typeof planRemoval>>): Promise<void> {
  for (const entry of entries) {
    if (entry.directory) await fs.rmdir(entry.absolutePath);
    else await fs.unlink(entry.absolutePath);
  }
}

export async function removeStagingOperation(operation: string): Promise<void> {
  await removeEntries(await planRemoval(operation));
}

export async function recoverStaging(
  staging: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const operations: string[] = [];
  for await (const entry of await fs.opendir(staging)) {
    signal?.throwIfAborted();
    if (!operationName.test(entry.name) || !entry.isDirectory()) {
      throw new PluginArtifactError(
        'plugin-artifact-conflict',
        'The staging directory contains an unexpected entry',
      );
    }
    operations.push(path.join(staging, entry.name));
    if (operations.length > maxAbandonedOperations) {
      throw new PluginArtifactError(
        'plugin-artifact-conflict',
        `The staging directory contains more than ${maxAbandonedOperations} operations`,
      );
    }
  }
  for (const operation of operations) {
    signal?.throwIfAborted();
    await removeStagingOperation(operation);
  }
}
