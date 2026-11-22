import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

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
  artifactDigestSchema,
  artifactDirectorySchema,
  PluginArtifactError,
  pluginArtifactSourceIdentitySchema,
  type PluginArtifact,
  type PluginArtifactSourceIdentity,
  type PluginArtifactStore,
  type PluginArtifactStoreOptions,
} from './artifact-types.js';
import { parseDescriptor } from './descriptor.js';
import { incompatibility, resolveEntry } from './discovery.js';
import { PluginHostError } from './errors.js';
import { HostQueue } from './host-queue.js';

const storeOptionsSchema = z.strictObject({
  directory: artifactDirectorySchema,
  hostVersion: z.string().optional(),
  reservedIds: z.array(z.string().min(1)).optional(),
});
const signal = z.instanceof(AbortSignal).optional();
const previewOptionsSchema = z.strictObject({ sourceDirectory: artifactDirectorySchema, signal });
const stageOptionsSchema = previewOptionsSchema.extend({
  expectedSource: pluginArtifactSourceIdentitySchema.optional(),
});
const readOptionsSchema = z.strictObject({ signal });
const maxPublishedArtifacts = 64;

type StoreResult =
  | { readonly kind: 'artifact'; readonly value: PluginArtifact }
  | { readonly kind: 'preview'; readonly value: PluginArtifactSourceIdentity };

function parse<T>(schema: z.ZodType<T>, value: unknown, description: string): T {
  const checked = schema.safeParse(value);
  if (!checked.success) {
    throw new PluginArtifactError('plugin-artifact-invalid', `Invalid ${description}`, {
      cause: checked.error,
    });
  }
  return checked.data;
}

async function assertRealDirectory(directory: string): Promise<void> {
  if (!(await fs.lstat(directory)).isDirectory()) {
    throw new PluginArtifactError(
      'plugin-artifact-unsupported-file',
      'The plugin source and managed directories must be real directories',
    );
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await assertRealDirectory(directory);
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

async function ensureDirectory(
  directory: string,
  recursive: boolean,
  reviewed: boolean,
): Promise<void> {
  if (await directoryExists(directory)) return;
  await fs.mkdir(directory, { mode: 0o700, recursive });
  if (reviewed) await assertRealDirectory(directory);
  else if (!(await directoryExists(directory))) throw sourceChanged();
}

async function assertCapacity(artifacts: string, abort: AbortSignal | undefined): Promise<void> {
  let count = 0;
  for await (const entry of await fs.opendir(artifacts)) {
    abort?.throwIfAborted();
    if (!entry.isDirectory() || !artifactDigestSchema.safeParse(entry.name).success) {
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

function isInvalidSource(error: unknown): boolean {
  return (
    error instanceof PluginArtifactError &&
    (error.code === 'plugin-artifact-invalid' ||
      error.code === 'plugin-artifact-unsupported-file' ||
      error.code === 'plugin-artifact-too-large')
  );
}

async function withReviewedSourceErrors<T>(
  abort: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (
      !isAbort(error, abort) &&
      (isInvalidSource(error) || hasCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP'))
    ) {
      throw sourceChanged(error);
    }
    throw error;
  }
}

async function normalizeSource(
  source: string,
  abort: AbortSignal | undefined,
  reviewed: boolean,
): Promise<string> {
  if (reviewed) {
    return withReviewedSourceErrors(abort, async () => {
      await assertRealDirectory(source);
      return fs.realpath(source);
    });
  }
  if (!(await directoryExists(source))) {
    throw new PluginArtifactError(
      'plugin-artifact-invalid',
      'The plugin source directory is missing',
    );
  }
  return withSourceDisappearance(abort, () => fs.realpath(source));
}

function assertNoOverlap(root: string, sourceDirectory: string): void {
  if (contains(root, sourceDirectory) || contains(sourceDirectory, root)) {
    throw new PluginArtifactError(
      'plugin-artifact-invalid',
      'The plugin source and managed store overlap',
    );
  }
}

function sameMeasurement(
  actual: Pick<PluginArtifact, 'digest' | 'files' | 'bytes'>,
  expected: PluginArtifactSourceIdentity,
): boolean {
  return (
    actual.digest === expected.digest &&
    actual.files === expected.files &&
    actual.bytes === expected.bytes
  );
}

function matchesReview(actual: PluginArtifact, expected: PluginArtifactSourceIdentity): boolean {
  return (
    sameMeasurement(actual, expected) &&
    isDeepStrictEqual(actual.descriptor.manifest, expected.manifest)
  );
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

function corruptArtifact(cause: unknown): PluginArtifactError {
  return new PluginArtifactError(
    'plugin-artifact-corrupt',
    'The published plugin artifact failed integrity validation',
    { cause },
  );
}

async function withPublishedErrors<T>(
  abort: AbortSignal | undefined,
  precise: boolean,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (isAbort(error, abort)) throw error;
    if (error instanceof PluginArtifactError) {
      if (error.code === 'plugin-artifact-corrupt' || error.code === 'plugin-artifact-not-found') {
        throw error;
      }
      if (precise && error.code === 'plugin-artifact-io') throw error;
    } else if (
      precise
        ? !hasCode(error, 'ENOENT', 'ENOTDIR', 'ELOOP')
        : hasCode(error, 'EACCES', 'EPERM', 'EIO')
    ) {
      // Preserve the legacy stage classification alongside precise published reads.
      throw error;
    }
    throw corruptArtifact(error);
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
  const queue = new HostQueue<StoreResult>();

  async function validatePayload(
    payload: string,
    abort: AbortSignal | undefined,
    precise = false,
  ): Promise<PluginArtifact> {
    const { digest, bytes, files, descriptorText, paths } = await checkPayload(payload, abort, {
      reviewed: precise,
    });
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
      return freezeTree({ directory: payload, entry, descriptor, digest, bytes, files });
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

  async function validatePublishedPayload(
    object: string,
    digest: string,
    abort: AbortSignal | undefined,
    precise: boolean,
  ): Promise<PluginArtifact> {
    const artifact = await validatePayload(path.join(object, 'payload'), abort, precise);
    if (artifact.digest !== digest) {
      throw corruptArtifact(new Error('The payload digest does not match its name'));
    }
    return artifact;
  }

  async function findPublishedObject(digest: string, abort: AbortSignal | undefined) {
    try {
      await assertRealDirectory(directory);
      const root = await fs.realpath(directory);
      const artifacts = path.join(root, 'artifacts');
      await assertRealDirectory(artifacts);
      const object = path.join(artifacts, digest);
      await assertRealDirectory(object);
      return object;
    } catch (error: unknown) {
      if (isAbort(error, abort) || !hasCode(error, 'ENOENT')) throw error;
      abort?.throwIfAborted();
      throw new PluginArtifactError(
        'plugin-artifact-not-found',
        'The plugin artifact was not found',
        {
          cause: error,
        },
      );
    }
  }

  async function preview(
    source: string,
    abort: AbortSignal | undefined,
  ): Promise<PluginArtifactSourceIdentity> {
    const sourceDirectory = await normalizeSource(source, abort, false);
    assertNoOverlap(await normalizeStore(directory), sourceDirectory);
    const { digest, descriptor, files, bytes } = await validatePayload(sourceDirectory, abort);
    return freezeTree({ sourceDirectory, digest, manifest: descriptor.manifest, files, bytes });
  }

  async function stage(
    source: string,
    abort: AbortSignal | undefined,
    expected: PluginArtifactSourceIdentity | undefined,
  ): Promise<PluginArtifact> {
    const reviewed = expected !== undefined;
    const sourceDirectory = await normalizeSource(source, abort, reviewed);
    if (reviewed && sourceDirectory !== expected.sourceDirectory) throw sourceChanged();
    const root = await normalizeStore(directory);
    assertNoOverlap(root, sourceDirectory);
    const staging = path.join(root, 'staging');
    const artifacts = path.join(root, 'artifacts');
    abort?.throwIfAborted();
    await ensureDirectory(root, true, reviewed);
    await ensureDirectory(artifacts, false, reviewed);
    await ensureDirectory(staging, false, reviewed);
    await recoverStaging(staging, abort);
    let digest: string;
    if (reviewed) {
      const before = await withReviewedSourceErrors(abort, () =>
        validatePayload(sourceDirectory, abort, true),
      );
      if (!matchesReview(before, expected)) throw sourceChanged();
      digest = before.digest;
    } else {
      ({ digest } = await withSourceDisappearance(abort, () =>
        checkPayload(sourceDirectory, abort),
      ));
    }

    const operation = path.join(staging, randomUUID());
    const payload = path.join(operation, 'payload');
    async function validateStaged(): Promise<PluginArtifact> {
      try {
        return await validatePayload(payload, abort, reviewed);
      } catch (error: unknown) {
        if (
          reviewed &&
          !isAbort(error, abort) &&
          hasCode(error, 'plugin-artifact-source-changed')
        ) {
          throw new PluginArtifactError('plugin-artifact-corrupt', 'The staged payload changed', {
            cause: error,
          });
        }
        throw error;
      }
    }
    abort?.throwIfAborted();
    await fs.mkdir(operation, { mode: 0o700 });
    let published = false;
    let result: PluginArtifact;
    try {
      await fs.mkdir(payload, { mode: 0o700 });
      try {
        const copied = await checkPayload(sourceDirectory, abort, {
          destination: payload,
          reviewed,
        });
        if (reviewed) {
          if (!sameMeasurement(copied, expected)) throw sourceChanged();
        } else {
          const after = await checkPayload(sourceDirectory, abort);
          if (copied.digest !== digest || after.digest !== digest) throw sourceChanged();
        }
      } catch (error: unknown) {
        if (isAbort(error, abort)) throw error;
        if (isInvalidSource(error) || (!reviewed && hasCode(error, 'ENOENT', 'ENOTDIR')))
          throw sourceChanged(error);
        throw error;
      }
      const artifact = await validateStaged();
      if (reviewed) {
        if (!matchesReview(artifact, expected)) {
          throw new PluginArtifactError(
            'plugin-artifact-corrupt',
            'The staged payload changed after copying',
          );
        }
      } else if (artifact.digest !== digest) {
        throw sourceChanged();
      }
      const object = path.join(artifacts, digest);
      let existing: PluginArtifact | undefined;
      try {
        if (await directoryExists(object)) {
          existing = await withPublishedErrors(abort, reviewed, async () => {
            if (!(await directoryExists(object))) {
              throw corruptArtifact(new Error('The artifact object is missing'));
            }
            return validatePublishedPayload(object, digest, abort, reviewed);
          });
          if (reviewed && !matchesReview(existing, expected)) {
            throw new PluginArtifactError(
              'plugin-artifact-corrupt',
              'The published artifact does not match the review',
            );
          }
        }
      } catch (error: unknown) {
        if (isAbort(error, abort)) throw error;
        if (
          error instanceof PluginArtifactError &&
          (!reviewed || error.code !== 'plugin-artifact-io')
        ) {
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
      let finalArtifact = artifact;
      if (existing === undefined) {
        await assertCapacity(artifacts, abort);
        finalArtifact = await validateStaged();
        if (reviewed ? !matchesReview(finalArtifact, expected) : finalArtifact.digest !== digest) {
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
      }
      if (reviewed) {
        // Keep the last source observation next to the reuse or rename boundary.
        const after = await withReviewedSourceErrors(abort, () =>
          validatePayload(sourceDirectory, abort, true),
        );
        const currentSource = await normalizeSource(source, abort, true);
        if (currentSource !== expected.sourceDirectory || !matchesReview(after, expected)) {
          throw sourceChanged();
        }
        abort?.throwIfAborted();
      }
      if (existing !== undefined) {
        result = existing;
      } else {
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
        const directory = path.join(object, 'payload');
        const entry = path.join(
          directory,
          path.relative(finalArtifact.directory, finalArtifact.entry),
        );
        result = Object.freeze({ ...finalArtifact, directory, entry });
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

  async function enqueueArtifact(
    abort: AbortSignal | undefined,
    run: () => Promise<PluginArtifact>,
  ): Promise<PluginArtifact> {
    const result = await queue.enqueue(false, async () => ({
      kind: 'artifact',
      value: await withArtifactErrors(abort, run),
    }));
    if (result.kind !== 'artifact') throw new Error('Unexpected plugin artifact queue result');
    return result.value;
  }

  return {
    async preview(input) {
      const { sourceDirectory, signal: abort } = parse(
        previewOptionsSchema,
        input,
        'plugin artifact preview options',
      );
      abort?.throwIfAborted();
      const result = await queue.enqueue(false, async () => ({
        kind: 'preview',
        value: await withArtifactErrors(abort, () => preview(path.resolve(sourceDirectory), abort)),
      }));
      if (result.kind !== 'preview') throw new Error('Unexpected plugin artifact queue result');
      return result.value;
    },
    async stage(input) {
      const {
        sourceDirectory,
        signal: abort,
        expectedSource,
      } = parse(stageOptionsSchema, input, 'plugin artifact stage options');
      abort?.throwIfAborted();
      return enqueueArtifact(abort, () =>
        stage(path.resolve(sourceDirectory), abort, expectedSource),
      );
    },
    async read(input, options = {}) {
      const digest = parse(artifactDigestSchema, input, 'plugin artifact digest');
      const { signal: abort } = parse(readOptionsSchema, options, 'plugin artifact read options');
      abort?.throwIfAborted();
      return enqueueArtifact(abort, () =>
        withPublishedErrors(abort, true, async () => {
          const object = await findPublishedObject(digest, abort);
          return validatePublishedPayload(object, digest, abort, true);
        }),
      );
    },
  };
}
