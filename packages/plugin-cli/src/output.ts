import { constants, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { PluginCliError } from './errors.js';
import { safeRelative, sameIdentity } from './snapshot.js';
import type { PublishedOutput, PublishOutputOptions } from './types.js';

interface OwnedEntry {
  readonly stat: BigIntStats;
  readonly directory: boolean;
}
const writeFlags =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
function invalid(message: string) {
  return new PluginCliError('plugin-cli-invalid-project', message);
}
function conflict(message: string, cause?: unknown) {
  return new PluginCliError('plugin-cli-output-conflict', message, { cause });
}
function absolute(value: string) {
  if (!path.isAbsolute(value) || value.includes('\0'))
    throw invalid('Output paths must be absolute');
}
function contains(parent: string, child: string) {
  return parent === child || child.startsWith(parent + path.sep);
}
function hasCode(error: unknown, code: string) {
  return error instanceof Error && 'code' in error && error.code === code;
}
function checkedFiles(files: ReadonlyMap<string, Uint8Array>) {
  const result = new Map<string, Uint8Array>();
  const names = new Map<string, string>();
  let bytes = 0;
  for (const [relative, data] of files) {
    if (!safeRelative(relative) || !(data instanceof Uint8Array))
      throw invalid('Output files require portable relative paths and byte data');
    const parts = relative.split('/');
    if (parts.length > 65) throw invalid('Output exceeds the depth limit');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const portable = prefix.normalize('NFC').toLowerCase();
      const previous = names.get(portable);
      if (previous !== undefined && previous !== prefix)
        throw invalid('Output names must be portable and unique');
      names.set(portable, prefix);
      if (i < parts.length && files.has(prefix))
        throw invalid('An output path cannot be both file and directory');
    }
    bytes += data.byteLength;
    if (result.size >= 1000 || bytes > 20 * 1024 * 1024 || names.size > 2000)
      throw invalid('Output exceeds payload bounds');
    result.set(relative, Uint8Array.from(data));
  }
  return result;
}

class OwnedOutput {
  readonly entries = new Map<string, OwnedEntry>();
  private constructor(
    readonly directory: string,
    private readonly requestedParent: string,
    private readonly parent: string,
    private readonly parentStat: BigIntStats,
    readonly signal?: AbortSignal,
  ) {}
  static async create(directory: string, signal?: AbortSignal) {
    absolute(directory);
    signal?.throwIfAborted();
    const requested = path.resolve(directory);
    const requestedParent = path.dirname(requested);
    const parent = await fs.realpath(requestedParent);
    const parentStat = await fs.lstat(parent, { bigint: true });
    if (!parentStat.isDirectory()) throw invalid('The output parent must be a directory');
    signal?.throwIfAborted();
    const target = path.join(parent, path.basename(requested));
    const owner = new OwnedOutput(target, requestedParent, parent, parentStat, signal);
    try {
      await fs.mkdir(target, { mode: 0o700 });
    } catch (cause: unknown) {
      if (hasCode(cause, 'EEXIST')) throw conflict('Output already exists', cause);
      throw cause;
    }
    try {
      owner.entries.set('', { stat: await fs.lstat(target, { bigint: true }), directory: true });
    } catch (primary: unknown) {
      // The mkdir succeeded but identity observation failed. Do not guess ownership:
      // retain the directory and surface its path with the primary failure.
      throw new AggregateError(
        [primary],
        `CLI output failed; retained output at ${target} could not be safely cleaned`,
        { cause: primary },
      );
    }
    return owner;
  }
  private async parentReady() {
    if (
      (await fs.realpath(this.requestedParent)) !== this.parent ||
      !sameIdentity(this.parentStat, await fs.lstat(this.parent, { bigint: true }))
    )
      throw conflict('The output parent changed');
  }
  async assertOwned(relative = '') {
    this.signal?.throwIfAborted();
    await this.parentReady();
    const parts = relative === '' ? [] : relative.split('/');
    for (let i = 0; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('/');
      const owned = this.entries.get(name);
      if (
        owned === undefined ||
        !sameIdentity(owned.stat, await fs.lstat(path.join(this.directory, name), { bigint: true }))
      )
        throw conflict('The output was replaced while writing');
    }
    this.signal?.throwIfAborted();
  }
  async mkdir(relative: string) {
    if (this.entries.has(relative)) return;
    const parent = path.posix.dirname(relative);
    const parentRelative = parent === '.' ? '' : parent;
    if (parentRelative) await this.mkdir(parentRelative);
    await this.assertOwned(parentRelative);
    const target = path.join(this.directory, relative);
    await fs.mkdir(target, { mode: 0o700 });
    this.entries.set(relative, { stat: await fs.lstat(target, { bigint: true }), directory: true });
    this.signal?.throwIfAborted();
  }
  async write(relative: string, bytes: Uint8Array) {
    const parent = path.posix.dirname(relative);
    const parentRelative = parent === '.' ? '' : parent;
    if (parentRelative) await this.mkdir(parentRelative);
    await this.assertOwned(parentRelative);
    const target = path.join(this.directory, relative);
    const handle = await fs.open(target, writeFlags, 0o600);
    let failure: unknown;
    try {
      this.entries.set(relative, { stat: await handle.stat({ bigint: true }), directory: false });
      let offset = 0;
      while (offset < bytes.byteLength) {
        this.signal?.throwIfAborted();
        const { bytesWritten } = await handle.write(
          bytes,
          offset,
          Math.min(64 * 1024, bytes.byteLength - offset),
          offset,
        );
        this.signal?.throwIfAborted();
        if (bytesWritten === 0)
          throw new PluginCliError('plugin-cli-io', 'An output write made no progress');
        offset += bytesWritten;
      }
      this.signal?.throwIfAborted();
      this.entries.set(relative, { stat: await handle.stat({ bigint: true }), directory: false });
      await this.assertOwned(relative);
    } catch (error: unknown) {
      failure = error;
    }
    try {
      this.entries.set(relative, { stat: await handle.stat({ bigint: true }), directory: false });
    } catch (error: unknown) {
      failure ??= error;
    }
    try {
      await handle.close();
    } catch (cleanup: unknown) {
      throw failure === undefined
        ? cleanup
        : new AggregateError([failure, cleanup], 'Closing an output file failed', {
            cause: cleanup,
          });
    }
    if (failure !== undefined) throw failure;
  }
  async inventory(cleanup = false) {
    const checkAbort = () => {
      if (!cleanup) this.signal?.throwIfAborted();
    };
    checkAbort();
    await this.parentReady();
    checkAbort();
    const observed = new Set<string>();
    const walk = async (relative: string): Promise<void> => {
      checkAbort();
      const target = path.join(this.directory, relative);
      const current = await fs.lstat(target, { bigint: true });
      checkAbort();
      const prior = this.entries.get(relative);
      if (
        prior === undefined ||
        !sameIdentity(prior.stat, current) ||
        prior.directory !== current.isDirectory() ||
        (!prior.directory &&
          (prior.stat.size !== current.size ||
            prior.stat.mtimeNs !== current.mtimeNs ||
            prior.stat.ctimeNs !== current.ctimeNs))
      )
        throw conflict('Output contains replaced or modified data; it was preserved');
      observed.add(relative);
      if (prior.directory) {
        const handle = await fs.opendir(target);
        let failure: unknown;
        try {
          for (;;) {
            checkAbort();
            const child = await handle.read();
            checkAbort();
            if (child === null) break;
            await walk(relative ? `${relative}/${child.name}` : child.name);
          }
        } catch (error: unknown) {
          failure = error;
        }
        try {
          await handle.close();
        } catch (cleanup: unknown) {
          throw failure === undefined
            ? cleanup
            : new AggregateError([failure, cleanup], 'Closing output inventory failed', {
                cause: cleanup,
              });
        }
        if (failure !== undefined) throw failure;
      }
    };
    await walk('');
    if (observed.size !== this.entries.size)
      throw conflict('Owned output entries disappeared; remaining data was preserved');
  }
  async rename(from: string, to: string) {
    await this.assertOwned(from);
    await this.inventory();
    try {
      await fs.lstat(path.join(this.directory, to));
      throw conflict('The final payload already exists');
    } catch (error: unknown) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    this.signal?.throwIfAborted();
    await fs.rename(path.join(this.directory, from), path.join(this.directory, to));
    for (const [relative, entry] of [...this.entries])
      if (relative === from || relative.startsWith(from + '/')) {
        this.entries.delete(relative);
        const relocated = to + relative.slice(from.length);
        this.entries.set(relocated, entry);
      }
    this.signal?.throwIfAborted();
  }
  async cleanup() {
    await this.inventory(true);
    const entries = [...this.entries].sort(
      ([a], [b]) => b.split('/').length - a.split('/').length || b.localeCompare(a),
    );
    for (const [relative, entry] of entries) {
      const target = path.join(this.directory, relative);
      if (!sameIdentity(entry.stat, await fs.lstat(target, { bigint: true })))
        throw conflict('Output changed before cleanup; remaining data was preserved');
      if (entry.directory) await fs.rmdir(target);
      else await fs.unlink(target);
    }
  }
}
async function failureCleanup(owner: OwnedOutput, primary: unknown): Promise<never> {
  try {
    await owner.cleanup();
  } catch (cleanup: unknown) {
    throw new AggregateError(
      [primary, cleanup],
      `CLI output failed; retained output at ${owner.directory} could not be safely cleaned`,
      { cause: cleanup },
    );
  }
  throw primary;
}

export async function writeProject(
  directory: string,
  files: ReadonlyMap<string, Uint8Array>,
  signal?: AbortSignal,
): Promise<void> {
  const checked = checkedFiles(files);
  const owner = await OwnedOutput.create(directory, signal);
  try {
    for (const [relative, bytes] of checked) await owner.write(relative, bytes);
    await owner.inventory();
    signal?.throwIfAborted();
  } catch (error: unknown) {
    return failureCleanup(owner, error);
  }
}

export async function publishOutput<T>(
  options: PublishOutputOptions<T>,
): Promise<PublishedOutput<T>> {
  const { sourceDirectory, outputDirectory, signal } = options;
  absolute(sourceDirectory);
  absolute(outputDirectory);
  signal?.throwIfAborted();
  const files = checkedFiles(options.files);
  const lexicalSource = path.resolve(sourceDirectory),
    lexicalOutput = path.resolve(outputDirectory);
  if (contains(lexicalSource, lexicalOutput) || contains(lexicalOutput, lexicalSource))
    throw new PluginCliError('plugin-cli-path-overlap', 'Source and output directories overlap');
  const sourceStat = await fs.lstat(sourceDirectory);
  if (!sourceStat.isDirectory()) throw invalid('The input root must be a real directory');
  const source = await fs.realpath(sourceDirectory);
  const parent = await fs.realpath(path.dirname(lexicalOutput));
  const canonicalOutput = path.join(parent, path.basename(lexicalOutput));
  if (contains(source, canonicalOutput) || contains(canonicalOutput, source))
    throw new PluginCliError('plugin-cli-path-overlap', 'Source and output directories overlap');
  const owner = await OwnedOutput.create(outputDirectory, signal);
  try {
    await owner.mkdir('.payload-building');
    for (const [relative, bytes] of files)
      await owner.write(`.payload-building/${relative}`, bytes);
    signal?.throwIfAborted();
    await options.validatePayload(path.join(owner.directory, '.payload-building'));
    signal?.throwIfAborted();
    await owner.inventory();
    await options.verifyInput();
    signal?.throwIfAborted();
    await owner.rename('.payload-building', 'payload');
    const payloadDirectory = path.join(owner.directory, 'payload');
    const value = await options.validatePayload(payloadDirectory);
    signal?.throwIfAborted();
    await owner.inventory();
    let receiptPath: string | undefined;
    if (options.receipt !== undefined) {
      const receipt = options.receipt(value, payloadDirectory);
      const json = JSON.stringify(receipt, null, 2);
      if (json === undefined || Buffer.byteLength(json) > 256 * 1024)
        throw invalid('The pack receipt is invalid or too large');
      signal?.throwIfAborted();
      await owner.write('receipt.json', Buffer.from(json + '\n'));
      receiptPath = path.join(owner.directory, 'receipt.json');
    }
    await owner.inventory();
    signal?.throwIfAborted();
    return { value, payloadDirectory, ...(receiptPath === undefined ? {} : { receiptPath }) };
  } catch (error: unknown) {
    return failureCleanup(owner, error);
  }
}
