import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { assertHostVersion } from '@weave/plugin';
import { z } from 'zod';

import {
  checkPayload,
  hasCode,
  recoverStaging,
  removeStagingOperation,
  sourceChanged,
} from './artifact-copy.js';
import {
  PluginArtifactError,
  type PluginArtifact,
  type PluginArtifactStore,
  type PluginArtifactStoreOptions,
} from './artifact-types.js';
import { parseDescriptor } from './descriptor.js';
import { incompatibility, resolveEntry } from './discovery.js';
import { PluginHostError } from './errors.js';
import { HostQueue } from './host-queue.js';

const absoluteDirectory = z
  .string()
  .refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const storeOptionsSchema = z.strictObject({
  directory: absoluteDirectory,
  hostVersion: z.string().optional(),
  reservedIds: z.array(z.string().min(1)).optional(),
});
const signal = z.instanceof(AbortSignal).optional();
const stageOptionsSchema = z.strictObject({ sourceDirectory: absoluteDirectory, signal });
const readOptionsSchema = z.strictObject({ signal });
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const maxPublishedArtifacts = 64;

function parse<T>(schema: z.ZodType<T>, value: unknown, description: string): T {
  const checked = schema.safeParse(value);
  if (!checked.success) {
    throw new PluginArtifactError('plugin-artifact-invalid', `Invalid ${description}`, {
      cause: checked.error,
    });
  }
  return checked.data;
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    if (!(await fs.lstat(directory)).isDirectory()) {
      throw new PluginArtifactError(
        'plugin-artifact-unsupported-file',
        'The plugin source and managed directories must be real directories',
      );
    }
    return true;
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function entryExists(entry: string): Promise<boolean> {
  try {
    await fs.lstat(entry);
    return true;
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

/** Resolves the deepest existing parent without creating files for invalid requests. */
async function normalizeStore(directory: string): Promise<string> {
  if (await directoryExists(directory)) return fs.realpath(directory);
  const missing: string[] = [];
  let parent = directory;
  while (true) {
    const next = path.dirname(parent);
    if (next === parent) {
      throw new PluginArtifactError(
        'plugin-artifact-invalid',
        'The managed store has no existing filesystem root',
      );
    }
    missing.unshift(path.basename(parent));
    parent = next;
    try {
      const realParent = await fs.realpath(parent);
      if (!(await directoryExists(realParent))) continue;
      return path.join(realParent, ...missing);
    } catch (error: unknown) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function ensureDirectory(directory: string, recursive = false): Promise<void> {
  if (await directoryExists(directory)) return;
  await fs.mkdir(directory, { mode: 0o700, recursive });
  if (!(await directoryExists(directory))) throw sourceChanged();
}

async function assertCapacity(artifacts: string, abort: AbortSignal | undefined): Promise<void> {
  let count = 0;
  for await (const entry of await fs.opendir(artifacts)) {
    abort?.throwIfAborted();
    if (!entry.isDirectory() || !digestSchema.safeParse(entry.name).success) {
      throw new PluginArtifactError(
        'plugin-artifact-conflict',
        'The artifact directory contains an unexpected entry',
      );
    }
    count += 1;
    if (count >= maxPublishedArtifacts) {
      throw new PluginArtifactError(
        'plugin-artifact-capacity',
        `The artifact store retains up to ${maxPublishedArtifacts} published artifacts, including orphans. Existing artifacts are kept and only an exact match can be staged at capacity`,
      );
    }
  }
}

function freezeTree<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

function isAbort(error: unknown, abort: AbortSignal | undefined): boolean {
  return abort?.aborted === true && Object.is(error, abort.reason);
}

/** Classifies disappearance after the source has already been confirmed to exist. */
async function withSourceDisappearance<T>(
  abort: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (!isAbort(error, abort) && hasCode(error, 'ENOENT', 'ENOTDIR')) {
      throw sourceChanged(error);
    }
    throw error;
  }
}

async function withArtifactErrors<T>(
  abort: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    abort?.throwIfAborted();
    return await run();
  } catch (error: unknown) {
    if (error instanceof PluginArtifactError || isAbort(error, abort)) throw error;
    throw new PluginArtifactError(
      'plugin-artifact-io',
      'A plugin artifact filesystem operation failed',
      {
        cause: error,
      },
    );
  }
}

export function createPluginArtifactStore(
  options: PluginArtifactStoreOptions,
): PluginArtifactStore {
  const config = parse(storeOptionsSchema, options, 'plugin artifact store options');
  try {
    assertHostVersion(config.hostVersion);
  } catch (error: unknown) {
    throw new PluginArtifactError(
      'plugin-artifact-invalid',
      'The host version must be a full x.y.z version',
      {
        cause: error,
      },
    );
  }
  const directory = path.resolve(config.directory);
  const reservedIds = new Set(config.reservedIds);
  const queue = new HostQueue<PluginArtifact>();

  async function validatePayload(
    payload: string,
    abort: AbortSignal | undefined,
  ): Promise<PluginArtifact> {
    const { digest, bytes, files, descriptorText, paths } = await checkPayload(payload, abort);
    if (descriptorText === undefined) {
      throw new PluginArtifactError('plugin-artifact-invalid', 'The plugin descriptor is missing');
    }
    try {
      const descriptor = parseDescriptor(descriptorText);
      const { manifest } = descriptor;
      const incompatible = incompatibility(manifest, config.hostVersion);
      if (incompatible !== undefined) {
        throw new PluginArtifactError(
          'plugin-artifact-invalid',
          `The plugin is incompatible (${incompatible.code})`,
          {
            cause: incompatible,
          },
        );
      }
      if (reservedIds.has(manifest.id)) {
        throw new PluginArtifactError(
          'plugin-artifact-invalid',
          'The plugin declares a reserved ID',
        );
      }
      const entry = await resolveEntry(payload, descriptor, manifest.id);
      if (!paths.has(path.relative(payload, entry).split(path.sep).join('/'))) {
        throw new PluginArtifactError(
          'plugin-artifact-invalid',
          'The plugin entry is outside the digested files',
        );
      }
      abort?.throwIfAborted();
      return freezeTree({ directory: payload, descriptor, digest, bytes, files });
    } catch (error: unknown) {
      if (error instanceof PluginHostError && !isAbort(error, abort)) {
        throw new PluginArtifactError(
          'plugin-artifact-invalid',
          `The plugin descriptor or entry is invalid (${error.code})`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
  }

  async function validatePublished(
    object: string,
    digest: string,
    abort: AbortSignal | undefined,
  ): Promise<PluginArtifact> {
    try {
      if (!(await directoryExists(object))) throw new Error('The artifact object is missing');
      const artifact = await validatePayload(path.join(object, 'payload'), abort);
      if (artifact.digest !== digest) throw new Error('The payload digest does not match its name');
      return artifact;
    } catch (error: unknown) {
      if (isAbort(error, abort)) throw error;
      if (!(error instanceof PluginArtifactError) && hasCode(error, 'EACCES', 'EPERM', 'EIO'))
        throw error;
      throw new PluginArtifactError(
        'plugin-artifact-corrupt',
        'The published plugin artifact failed integrity validation',
        {
          cause: error,
        },
      );
    }
  }

  async function stage(source: string, abort: AbortSignal | undefined): Promise<PluginArtifact> {
    if (!(await directoryExists(source))) {
      throw new PluginArtifactError(
        'plugin-artifact-invalid',
        'The plugin source directory is missing',
      );
    }
    const sourceDirectory = await withSourceDisappearance(abort, () => fs.realpath(source));
    const root = await normalizeStore(directory);
    if (contains(root, sourceDirectory) || contains(sourceDirectory, root)) {
      throw new PluginArtifactError(
        'plugin-artifact-invalid',
        'The plugin source and managed store overlap',
      );
    }
    const staging = path.join(root, 'staging');
    const artifacts = path.join(root, 'artifacts');
    abort?.throwIfAborted();
    await ensureDirectory(root, true);
    await ensureDirectory(artifacts);
    await ensureDirectory(staging);
    await recoverStaging(staging, abort);
    const before = await withSourceDisappearance(abort, () => checkPayload(sourceDirectory, abort));

    const operation = path.join(staging, randomUUID());
    const payload = path.join(operation, 'payload');
    abort?.throwIfAborted();
    await fs.mkdir(operation, { mode: 0o700 });
    let published = false;
    let result: PluginArtifact;
    try {
      await fs.mkdir(payload, { mode: 0o700 });
      try {
        const copied = await checkPayload(sourceDirectory, abort, payload);
        const after = await checkPayload(sourceDirectory, abort);
        if (copied.digest !== before.digest || after.digest !== before.digest)
          throw sourceChanged();
      } catch (error: unknown) {
        if (isAbort(error, abort)) throw error;
        if (
          hasCode(error, 'ENOENT', 'ENOTDIR') ||
          (error instanceof PluginArtifactError &&
            [
              'plugin-artifact-invalid',
              'plugin-artifact-unsupported-file',
              'plugin-artifact-too-large',
            ].includes(error.code))
        )
          throw sourceChanged(error);
        throw error;
      }
      const artifact = await validatePayload(payload, abort);
      if (artifact.digest !== before.digest) throw sourceChanged();
      const object = path.join(artifacts, artifact.digest);
      let existing: PluginArtifact | undefined;
      try {
        if (await directoryExists(object)) {
          existing = await validatePublished(object, artifact.digest, abort);
        }
      } catch (error: unknown) {
        if (isAbort(error, abort)) throw error;
        if (error instanceof PluginArtifactError) {
          throw new PluginArtifactError(
            'plugin-artifact-conflict',
            'The digest already belongs to an invalid artifact',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
      if (existing !== undefined) {
        result = existing;
      } else {
        await assertCapacity(artifacts, abort);
        const finalArtifact = await validatePayload(payload, abort);
        if (finalArtifact.digest !== artifact.digest) {
          throw new PluginArtifactError(
            'plugin-artifact-corrupt',
            'The staged payload changed before publication',
          );
        }
        if (await entryExists(object)) {
          throw new PluginArtifactError(
            'plugin-artifact-conflict',
            'The artifact path was occupied before publication',
          );
        }
        abort?.throwIfAborted();
        try {
          await fs.rename(operation, object);
        } catch (error: unknown) {
          if (hasCode(error, 'EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR')) {
            throw new PluginArtifactError(
              'plugin-artifact-conflict',
              'The artifact path was occupied before publication',
              { cause: error },
            );
          }
          throw error;
        }
        published = true;
        result = Object.freeze({ ...finalArtifact, directory: path.join(object, 'payload') });
      }
    } catch (error: unknown) {
      try {
        await removeStagingOperation(operation);
      } catch (cleanup: unknown) {
        throw new PluginArtifactError(
          'plugin-artifact-io',
          'Staging failed and cleanup also failed',
          {
            cause: new AggregateError([error, cleanup]),
          },
        );
      }
      throw error;
    }
    if (!published) await removeStagingOperation(operation);
    abort?.throwIfAborted();
    return result;
  }

  return {
    async stage(input) {
      const options = parse(stageOptionsSchema, input, 'plugin artifact stage options');
      options.signal?.throwIfAborted();
      return queue.enqueue(false, () =>
        withArtifactErrors(options.signal, () =>
          stage(path.resolve(options.sourceDirectory), options.signal),
        ),
      );
    },
    async read(input, options = {}) {
      const digest = parse(digestSchema, input, 'plugin artifact digest');
      const { signal: abort } = parse(readOptionsSchema, options, 'plugin artifact read options');
      abort?.throwIfAborted();
      return queue.enqueue(false, () =>
        withArtifactErrors(abort, async () => {
          const root = await normalizeStore(directory);
          const artifacts = path.join(root, 'artifacts');
          const object = path.join(artifacts, digest);
          if (!(await directoryExists(artifacts)) || !(await entryExists(object))) {
            abort?.throwIfAborted();
            throw new PluginArtifactError(
              'plugin-artifact-not-found',
              'The plugin artifact was not found',
            );
          }
          return validatePublished(object, digest, abort);
        }),
      );
    },
  };
}
