import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { assertEngineSupported, assertHostVersion, pluginApiVersion } from '@weave/plugin';
import { parseDescriptor, type PluginArtifact, type PluginDescriptor } from '@weave/plugin-host';
import { z } from 'zod';
import { bundlePluginSource, checkPluginSource } from './bundle.js';
import { PluginCliError } from './errors.js';
import { publishOutput } from './output.js';
import { assertSourceProfile, inspectCliArtifact } from './payload-profile.js';
import { resolvePluginSdk } from './sdk.js';
import { captureSnapshot, verifySnapshot } from './snapshot.js';
import type {
  BuildPluginOptions,
  BuiltPlugin,
  DirectorySnapshot,
  HostOptions,
  OperationOptions,
  PackedPlugin,
  PackPluginOptions,
  PluginPackReceipt,
  ResolvedPluginSdk,
  ValidatedPlugin,
  ValidatePluginOptions,
} from './types.js';

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value) && !value.includes('\0'));
const common = { signal: z.instanceof(AbortSignal).optional(), hostVersion: z.string().optional() };
const sdkDirectory = absolute.optional();
const validateOptions = z.union([
  z.strictObject({ ...common, sourceDirectory: absolute, sdkDirectory }),
  z.strictObject({ ...common, artifactDirectory: absolute }),
]);
const buildOptions = z.strictObject({
  ...common,
  sourceDirectory: absolute,
  outputDirectory: absolute,
  sdkDirectory,
});
const packOptions = z.strictObject({
  ...common,
  artifactDirectory: absolute,
  outputDirectory: absolute,
});
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new PluginCliError('plugin-cli-usage', 'Invalid operation options', {
      cause: parsed.error,
    });
  return parsed.data;
}
function abort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}
const decoder = new TextDecoder('utf-8', { fatal: true });
function text(snapshot: DirectorySnapshot, relative: string): string {
  const bytes = snapshot.files.get(relative);
  if (bytes === undefined)
    throw new PluginCliError('plugin-cli-invalid-project', `Missing ${relative}`);
  try {
    return decoder.decode(bytes);
  } catch (cause) {
    throw new PluginCliError('plugin-cli-invalid-project', `Invalid UTF-8 in ${relative}`, {
      cause,
    });
  }
}
function descriptor(snapshot: DirectorySnapshot): PluginDescriptor {
  try {
    return parseDescriptor(text(snapshot, 'weave-plugin.json'));
  } catch (cause) {
    throw new PluginCliError('plugin-cli-invalid-project', 'Invalid weave-plugin.json', { cause });
  }
}
function checkCompatibility(value: PluginDescriptor, hostVersion?: string): void {
  assertHostVersion(hostVersion);
  if (
    value.manifest.apiVersion !== pluginApiVersion ||
    !['in-process', 'declarative'].includes(value.manifest.host ?? 'in-process')
  )
    throw new PluginCliError('plugin-cli-invalid-project', 'Unsupported plugin API or host');
  if (hostVersion !== undefined) assertEngineSupported(value.manifest, hostVersion);
}
function sameArtifact(before: PluginArtifact, after: PluginArtifact): void {
  if (
    before.digest !== after.digest ||
    before.files !== after.files ||
    before.bytes !== after.bytes ||
    !isDeepStrictEqual(before.descriptor, after.descriptor) ||
    (before.kind === 'skills') !== (after.kind === 'skills') ||
    (before.kind === 'skills' &&
      after.kind === 'skills' &&
      !isDeepStrictEqual(before.skills, after.skills))
  )
    throw new PluginCliError('plugin-cli-source-changed', 'The inspected payload identity changed');
}
async function artifactSnapshot(directory: string, options: HostOptions & OperationOptions) {
  const inspection = { hostVersion: options.hostVersion, signal: options.signal };
  const initial = await inspectCliArtifact(directory, inspection);
  abort(options.signal);
  const snapshot = await captureSnapshot(directory, { signal: options.signal });
  const observed = await inspectCliArtifact(directory, inspection);
  sameArtifact(initial, observed);
  await verifySnapshot(snapshot, options.signal);
  return { artifact: observed, snapshot };
}
interface Source {
  readonly descriptor: PluginDescriptor;
  readonly snapshot: DirectorySnapshot;
  readonly artifact?: PluginArtifact;
  readonly sdk?: ResolvedPluginSdk;
}
async function source(
  directory: string,
  options: HostOptions & OperationOptions & { sdkDirectory?: string | undefined },
  compile = true,
): Promise<Source> {
  abort(options.signal);
  // The first bounded pass locates the existing descriptor; an executable source
  // is then captured again under the narrower author-source bounds.
  let snapshot = await captureSnapshot(directory, { signal: options.signal });
  let checked = descriptor(snapshot);
  checkCompatibility(checked, options.hostVersion);
  if (checked.schemaVersion === 2) {
    if (options.sdkDirectory !== undefined)
      throw new PluginCliError('plugin-cli-usage', 'Skills data does not use an SDK directory');
    const captured = await artifactSnapshot(directory, options);
    if (captured.artifact.kind !== 'skills')
      throw new PluginCliError('plugin-cli-source-changed', 'The source changed payload kind');
    return { descriptor: captured.artifact.descriptor, ...captured };
  }
  snapshot = await captureSnapshot(directory, {
    signal: options.signal,
    maxFiles: 128,
    maxBytes: 4 * 1024 * 1024,
    maxFileBytes: 256 * 1024,
    maxDepth: 16,
    maxEntries: 512,
  });
  checked = descriptor(snapshot);
  if (checked.schemaVersion !== 1 || checked.entry !== 'index.mjs')
    throw new PluginCliError(
      'plugin-cli-invalid-project',
      'ESM source must declare final entry index.mjs',
    );
  checkCompatibility(checked, options.hostVersion);
  assertSourceProfile(snapshot);
  let project: unknown;
  try {
    project = JSON.parse(text(snapshot, 'package.json'));
  } catch (cause) {
    throw new PluginCliError('plugin-cli-invalid-project', 'Invalid package.json', { cause });
  }
  if (!z.object({ type: z.literal('module') }).safeParse(project).success)
    throw new PluginCliError(
      'plugin-cli-invalid-project',
      'ESM source requires package.json type:module',
    );
  const sdk = await resolvePluginSdk(options.sdkDirectory, options.signal);
  if (compile) await checkPluginSource(snapshot, sdk, options.signal);
  await verifySnapshot(snapshot, options.signal);
  return { descriptor: checked, snapshot, sdk };
}

export async function validatePlugin(input: ValidatePluginOptions): Promise<ValidatedPlugin> {
  const options = parse(validateOptions, input);
  abort(options.signal);
  assertHostVersion(options.hostVersion);
  if ('artifactDirectory' in options) {
    const captured = await artifactSnapshot(options.artifactDirectory, options);
    return { mode: 'artifact', artifact: captured.artifact };
  }
  const checked = await source(options.sourceDirectory, options);
  if (checked.artifact !== undefined) return { mode: 'artifact', artifact: checked.artifact };
  return {
    mode: 'source',
    variant: 'entry',
    sourceDirectory: checked.snapshot.directory,
    manifest: checked.descriptor.manifest,
    sdkDirectory: checked.sdk!.directory,
  };
}

export async function buildPlugin(input: BuildPluginOptions): Promise<BuiltPlugin> {
  const options = parse(buildOptions, input);
  const checked = await source(options.sourceDirectory, options, false);
  const files = new Map<string, Uint8Array>();
  if (checked.artifact !== undefined) {
    for (const [name, bytes] of checked.snapshot.files) files.set(name, bytes);
  } else {
    files.set('weave-plugin.json', checked.snapshot.files.get('weave-plugin.json')!);
    files.set(
      'index.mjs',
      await bundlePluginSource(checked.snapshot, checked.sdk!, options.signal),
    );
    for (const name of ['README.md', 'LICENSE', 'NOTICE']) {
      const bytes = checked.snapshot.files.get(name);
      if (bytes !== undefined) files.set(name, bytes);
    }
  }
  const output = await publishOutput({
    sourceDirectory: checked.snapshot.directory,
    outputDirectory: options.outputDirectory,
    files,
    signal: options.signal,
    verifyInput: () => verifySnapshot(checked.snapshot, options.signal),
    validatePayload: async (directory) => {
      const artifact = await inspectCliArtifact(directory, {
        hostVersion: options.hostVersion,
        signal: options.signal,
      });
      if (checked.artifact !== undefined) sameArtifact(checked.artifact, artifact);
      return artifact;
    },
  });
  return {
    command: 'build',
    outputDirectory: path.dirname(output.payloadDirectory),
    payloadDirectory: output.payloadDirectory,
    artifact: output.value,
  };
}

export async function packPlugin(input: PackPluginOptions): Promise<PackedPlugin> {
  const options = parse(packOptions, input);
  const checked = await artifactSnapshot(options.artifactDirectory, options);
  let receipt: PluginPackReceipt | undefined;
  const output = await publishOutput({
    sourceDirectory: checked.snapshot.directory,
    outputDirectory: options.outputDirectory,
    files: checked.snapshot.files,
    signal: options.signal,
    verifyInput: () => verifySnapshot(checked.snapshot, options.signal),
    validatePayload: async (directory) => {
      const artifact = await inspectCliArtifact(directory, {
        hostVersion: options.hostVersion,
        signal: options.signal,
      });
      sameArtifact(checked.artifact, artifact);
      return artifact;
    },
    receipt: (artifact, payloadDirectory) => {
      receipt = {
        schemaVersion: 1,
        manifest: artifact.descriptor.manifest,
        variant: artifact.kind === 'skills' ? 'skills' : 'entry',
        digest: artifact.digest,
        files: artifact.files,
        bytes: artifact.bytes,
        outputPath: payloadDirectory,
      };
      return receipt;
    },
  });
  if (receipt === undefined || output.receiptPath === undefined)
    throw new PluginCliError('plugin-cli-io', 'Pack receipt was not completed');
  return {
    command: 'pack',
    outputDirectory: path.dirname(output.payloadDirectory),
    payloadDirectory: output.payloadDirectory,
    receiptPath: output.receiptPath,
    receipt,
  };
}
