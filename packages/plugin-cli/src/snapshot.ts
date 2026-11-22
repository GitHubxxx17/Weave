import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PluginCliError } from './errors.js';
import type { DirectorySnapshot, SnapshotOptions } from './types.js';

const ignored = new Set(['.git', '.DS_Store', 'Thumbs.db']);
const defaults = {
  maxFiles: 1000,
  maxBytes: 20 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxDepth: 64,
  maxEntries: 2000,
};
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
type Limits = typeof defaults;
interface Evidence {
  readonly requested: string;
  readonly limits: Limits;
  readonly identities: ReadonlyMap<string, BigIntStats>;
}
const evidence = new WeakMap<DirectorySnapshot, Evidence>();
function invalid(message: string, cause?: unknown) {
  return new PluginCliError('plugin-cli-invalid-project', message, { cause });
}
export function safeRelative(value: string): boolean {
  return (
    value.length > 0 &&
    value
      .split('/')
      .every(
        (part) =>
          part !== '' &&
          part !== '.' &&
          part !== '..' &&
          !/[<>:"\\|?*\p{Cc}]/u.test(part) &&
          !/[ .]$/.test(part) &&
          !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part),
      )
  );
}
export function sameIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode;
}
function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    sameIdentity(before, after) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
function absolute(value: string) {
  if (!path.isAbsolute(value) || value.includes('\0'))
    throw invalid('A snapshot directory must be an absolute path');
}

export async function captureSnapshot(
  directory: string,
  options: SnapshotOptions = {},
): Promise<DirectorySnapshot> {
  absolute(directory);
  const signal = options.signal;
  signal?.throwIfAborted();
  const limits = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof Limits)[]) {
    const supplied = options[key];
    if (supplied !== undefined) limits[key] = supplied;
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 0 || limits[key] > defaults[key])
      throw invalid('Invalid snapshot limits');
  }
  const requested = path.resolve(directory);
  const initial = await fs.lstat(requested, { bigint: true });
  signal?.throwIfAborted();
  if (!initial.isDirectory()) throw invalid('The snapshot root must be a real directory');
  const canonical = await fs.realpath(requested);
  signal?.throwIfAborted();
  const identities = new Map<string, BigIntStats>();
  const files = new Map<string, Uint8Array>();
  const directories: string[] = [];
  const names = new Set<string>();
  let entries = 0;
  let bytes = 0;
  async function checkedStat(relative: string, expected?: BigIntStats): Promise<BigIntStats> {
    signal?.throwIfAborted();
    const stat = await fs.lstat(path.join(canonical, relative), { bigint: true });
    signal?.throwIfAborted();
    if (expected !== undefined && !unchanged(expected, stat))
      throw invalid('The source changed while reading');
    return stat;
  }
  async function read(relative: string, before: BigIntStats) {
    if (before.size > BigInt(limits.maxFileBytes) || bytes + Number(before.size) > limits.maxBytes)
      throw invalid('The source exceeds its byte limits');
    if (files.size >= limits.maxFiles) throw invalid('The source exceeds its file limit');
    const file = path.join(canonical, relative);
    const handle = await fs.open(file, readFlags);
    let failure: unknown;
    try {
      signal?.throwIfAborted();
      if (!unchanged(before, await handle.stat({ bigint: true })))
        throw invalid('The source file changed before opening');
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
        signal?.throwIfAborted();
        if (bytesRead === 0) break;
        size += bytesRead;
        if (
          size > Number(before.size) ||
          size > limits.maxFileBytes ||
          bytes + size > limits.maxBytes
        )
          throw invalid('The source file grew or exceeds its byte limit');
        chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      }
      if (size !== Number(before.size) || !unchanged(before, await handle.stat({ bigint: true })))
        throw invalid('The source file changed during reading');
      await checkedStat(relative, before);
      files.set(relative, Buffer.concat(chunks));
      bytes += size;
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (cleanup: unknown) {
      throw failure === undefined
        ? cleanup
        : new AggregateError([failure, cleanup], 'Closing the source file failed', {
            cause: cleanup,
          });
    }
    if (failure !== undefined) throw failure;
  }
  async function walk(relative: string, depth: number, before: BigIntStats): Promise<void> {
    directories.push(relative);
    identities.set(relative, before);
    signal?.throwIfAborted();
    const handle = await fs.opendir(path.join(canonical, relative));
    let failure: unknown;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const child = await handle.read();
        signal?.throwIfAborted();
        if (child === null) break;
        signal?.throwIfAborted();
        if (ignored.has(child.name)) continue;
        if (++entries > limits.maxEntries) throw invalid('The source exceeds its entry limit');
        const name = relative ? `${relative}/${child.name}` : child.name;
        const portable = name.normalize('NFC').toLowerCase();
        if (!safeRelative(name) || names.has(portable))
          throw invalid('Source paths must be portable and unique');
        names.add(portable);
        const stat = await checkedStat(name);
        identities.set(name, stat);
        if (stat.isDirectory()) {
          if (depth >= limits.maxDepth) throw invalid('The source exceeds its depth limit');
          await walk(name, depth + 1, stat);
        } else if (stat.isFile()) await read(name, stat);
        else throw invalid('Source entries must be regular files and real directories');
      }
    } catch (error: unknown) {
      failure = error;
    }
    try {
      await handle.close();
    } catch (cleanup: unknown) {
      throw failure === undefined
        ? cleanup
        : new AggregateError([failure, cleanup], 'Closing a source directory failed', {
            cause: cleanup,
          });
    }
    if (failure !== undefined) throw failure;
    await checkedStat(relative, before);
  }
  await walk('', 0, initial);
  if (
    (await fs.realpath(requested)) !== canonical ||
    !unchanged(initial, await fs.lstat(requested, { bigint: true }))
  )
    throw invalid('The source directory changed during reading');
  signal?.throwIfAborted();
  const orderedFiles = new Map(
    [...files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  );
  directories.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const snapshot: DirectorySnapshot = Object.freeze({
    directory: canonical,
    files: orderedFiles,
    directories: Object.freeze(directories),
  });
  evidence.set(snapshot, { requested, limits, identities });
  return snapshot;
}

export async function verifySnapshot(
  snapshot: DirectorySnapshot,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const prior = evidence.get(snapshot);
  if (prior === undefined)
    throw new PluginCliError(
      'plugin-cli-source-changed',
      'The source snapshot is not owned by this operation',
    );
  try {
    const current = await captureSnapshot(prior.requested, { ...prior.limits, signal });
    const observed = evidence.get(current)!;
    if (
      current.directory !== snapshot.directory ||
      current.files.size !== snapshot.files.size ||
      current.directories.length !== snapshot.directories.length ||
      prior.identities.size !== observed.identities.size
    )
      throw new Error('Changed source inventory');
    for (const [relative, before] of prior.identities) {
      const after = observed.identities.get(relative);
      if (after === undefined || !unchanged(before, after))
        throw new Error('Changed source identity');
    }
    for (const [relative, bytes] of snapshot.files) {
      const now = current.files.get(relative);
      if (now === undefined || !Buffer.from(bytes).equals(now))
        throw new Error('Changed source bytes');
    }
    signal?.throwIfAborted();
  } catch (cause: unknown) {
    signal?.throwIfAborted();
    throw new PluginCliError(
      'plugin-cli-source-changed',
      'The source changed after it was checked',
      { cause },
    );
  }
}
