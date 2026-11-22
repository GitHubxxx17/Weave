import { constants, type Dirent, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  assertEngineSupported,
  assertHostVersion,
  PluginError,
  pluginApiVersion,
  type PluginManifest,
} from '@weave/plugin';

import {
  descriptorFileName,
  maxDescriptorBytes,
  parseDescriptor,
  type PluginDescriptor,
} from './descriptor.js';
import { computeDirectoryDigest, type DigestLimits } from './digest.js';
import { describeError, PluginHostError } from './errors.js';

/** Why a plugin on disk cannot be used. */
export interface LocalPluginIssue {
  /** A {@link PluginHostError} code, or the kernel's version codes for an incompatible plugin. */
  readonly code: string;
  readonly message: string;
}

interface CandidateBase {
  /** The id in the plugin's manifest, or the directory's name when the manifest could not be read. */
  readonly id: string;
  /** The plugin's directory, absolute. */
  readonly directory: string;
}

/** A plugin whose declaration and content were read and found sound. */
export interface ReadyLocalPlugin extends CandidateBase {
  readonly status: 'ready';
  readonly manifest: PluginManifest;
  /** The entry module: the real path of a regular file inside the directory. */
  readonly entry: string;
  /** The digest of the directory as it was when discovered. */
  readonly digest: string;
}

/** A plugin that is well formed but cannot run on this host. */
export interface IncompatibleLocalPlugin extends CandidateBase {
  readonly status: 'incompatible';
  readonly manifest: PluginManifest;
  readonly issue: LocalPluginIssue;
}

/** A plugin directory that cannot be used as it is. */
export interface InvalidLocalPlugin extends CandidateBase {
  readonly status: 'invalid';
  /** Present when the declaration was read before the problem showed. */
  readonly manifest?: PluginManifest | undefined;
  readonly issue: LocalPluginIssue;
}

/** One plugin directory, as found. */
export type LocalPluginCandidate = ReadyLocalPlugin | IncompatibleLocalPlugin | InvalidLocalPlugin;

/** Options of {@link discoverLocalPlugins}. */
export interface DiscoverOptions {
  /** The plugins directory; each of its subdirectories may hold one plugin. */
  readonly directory: string;
  /**
   * The host's Weave version, a full `x.y.z`. A plugin that declares
   * `engines.weave` is incompatible when this is missing or out of its range.
   */
  readonly hostVersion?: string | undefined;
  /** Plugin ids the host already uses; a local plugin may not take one. */
  readonly reservedIds?: Iterable<string> | undefined;
  /** At most this many plugin directories are read. Defaults to 200. */
  readonly maxCandidates?: number | undefined;
  readonly limits?: Partial<DigestLimits> | undefined;
}

/** What {@link discoverLocalPlugins} found. */
export interface DiscoveryResult {
  /** The plugins directory, absolute. */
  readonly directory: string;
  /** False when the directory does not exist, which is not an error. */
  readonly exists: boolean;
  /** One per plugin directory, in the byte order of the directory names. */
  readonly candidates: readonly LocalPluginCandidate[];
  /** True when more plugin directories were there than `maxCandidates`. */
  readonly truncated: boolean;
}

/** Parsed manual declarations and whether the observation covered the namespace. */
export interface LocalPluginDeclarationClaims {
  readonly pluginIds: readonly string[];
  readonly complete: boolean;
}

/** Internal discovery evidence before applying ID policy. */
export interface LocalPluginDeclarationScan extends DiscoveryResult {
  readonly complete: boolean;
}

const defaultMaxCandidates = 200;
const descriptorReadFlags =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function issueOf(error: unknown): LocalPluginIssue {
  if (error instanceof PluginHostError) {
    return { code: error.code, message: error.message };
  }
  return { code: 'plugin-unreadable', message: describeError(error) };
}

/** Whether `target`, followed through any links, is a directory. */
async function pointsToDirectory(target: string, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  } finally {
    signal?.throwIfAborted();
  }
}

function assertRegularDescriptor(info: Stats): void {
  if (!info.isFile()) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `${descriptorFileName} must be a regular file, not a link or a directory`,
    );
  }
}

function oversizedDescriptor(): PluginHostError {
  return new PluginHostError(
    'plugin-invalid-descriptor',
    `${descriptorFileName} is larger than ${String(maxDescriptorBytes / 1024)} KB`,
  );
}

async function readDescriptorText(
  file: string,
  info: Stats,
  signal?: AbortSignal,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  assertRegularDescriptor(info);
  if (info.size > maxDescriptorBytes) throw oversizedDescriptor();

  let handle;
  try {
    handle = await fs.open(file, descriptorReadFlags);
  } catch (error: unknown) {
    signal?.throwIfAborted();
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  let readFailure: { readonly error: unknown } | undefined;
  try {
    signal?.throwIfAborted();
    const opened = await handle.stat();
    signal?.throwIfAborted();
    assertRegularDescriptor(opened);
    // Reserve one extra byte to distinguish a full-size descriptor from growth.
    const buffer = Buffer.allocUnsafe(maxDescriptorBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      signal?.throwIfAborted();
      if (bytesRead === 0) return buffer.toString('utf8', 0, offset);
      offset += bytesRead;
    }
    throw oversizedDescriptor();
  } catch (error: unknown) {
    readFailure = { error };
    throw error;
  } finally {
    await handle.close().catch((cleanup: unknown) => {
      signal?.throwIfAborted();
      const cause = readFailure ? new AggregateError([readFailure.error, cleanup]) : cleanup;
      throw new PluginHostError(
        'plugin-unreadable',
        describeError(readFailure ? readFailure.error : cleanup),
        { cause },
      );
    });
  }
}

/** Why the plugin cannot run on this host, if it cannot. */
export function incompatibility(
  manifest: PluginManifest,
  hostVersion: string | undefined,
): LocalPluginIssue | undefined {
  if (manifest.apiVersion !== pluginApiVersion) {
    return {
      code: 'plugin-api-version-unsupported',
      message: `Plugin "${manifest.id}" requires API version "${manifest.apiVersion}", expected "${pluginApiVersion}"`,
    };
  }
  const host = manifest.host ?? 'in-process';
  if (host !== 'in-process') {
    return {
      code: 'plugin-host-unsupported',
      message: `Plugin "${manifest.id}" runs as "${host}", which this host cannot load yet; only in-process plugins can be loaded`,
    };
  }
  try {
    assertEngineSupported(manifest, hostVersion);
  } catch (error: unknown) {
    if (error instanceof PluginError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  return undefined;
}

/**
 * The real path of the entry module, which must be a regular file inside the
 * plugin's real directory.
 */
export async function resolveEntry(
  directory: string,
  descriptor: PluginDescriptor,
  pluginId: string,
): Promise<string> {
  const candidate = path.join(directory, ...descriptor.entry.split('/'));
  const invalid = (message: string): PluginHostError =>
    new PluginHostError('plugin-entry-invalid', message, { pluginId });
  let info;
  try {
    info = await fs.lstat(candidate);
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      throw invalid(`Entry "${descriptor.entry}" does not exist in the plugin directory`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw invalid(`Entry "${descriptor.entry}" is not a regular file`);
  }
  const [realDirectory, realEntry] = await Promise.all([
    fs.realpath(directory),
    fs.realpath(candidate),
  ]);
  if (!realEntry.startsWith(realDirectory + path.sep)) {
    throw invalid(`Entry "${descriptor.entry}" resolves outside the plugin directory`);
  }
  return realEntry;
}

function invalidCandidate(
  name: string,
  directory: string,
  error: unknown,
  manifest?: PluginManifest,
): InvalidLocalPlugin {
  // The directory's name stands in for an id nobody could read.
  const id =
    manifest?.id ?? (error instanceof PluginHostError ? error.pluginId : undefined) ?? name;
  return { status: 'invalid', id, directory, manifest, issue: issueOf(error) };
}

/** Validate compatibility and payload after the declaration has been observed. */
async function inspectPayload(
  directory: string,
  descriptor: PluginDescriptor,
  options: DiscoverOptions,
): Promise<LocalPluginCandidate> {
  const { manifest } = descriptor;
  const incompatible = incompatibility(manifest, options.hostVersion);
  if (incompatible !== undefined) {
    return { status: 'incompatible', id: manifest.id, directory, manifest, issue: incompatible };
  }

  try {
    const { digest } = await computeDirectoryDigest(directory, {
      limits: options.limits,
      pluginId: manifest.id,
    });
    const entry = await resolveEntry(directory, descriptor, manifest.id);
    return { status: 'ready', id: manifest.id, directory, manifest, entry, digest };
  } catch (error: unknown) {
    return invalidCandidate(manifest.id, directory, error, manifest);
  }
}

/** Marks plugins that take a reserved id, or an id another directory also declares, invalid. */
function applyIdRules(
  candidates: readonly LocalPluginCandidate[],
  reserved: ReadonlySet<string>,
): readonly LocalPluginCandidate[] {
  const directoriesById = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.status !== 'invalid') {
      directoriesById.set(candidate.id, [
        ...(directoriesById.get(candidate.id) ?? []),
        path.basename(candidate.directory),
      ]);
    }
  }

  return candidates.map((candidate): LocalPluginCandidate => {
    if (candidate.status === 'invalid') {
      return candidate;
    }
    const refuse = (code: PluginHostError['code'], message: string): InvalidLocalPlugin => ({
      status: 'invalid',
      id: candidate.id,
      directory: candidate.directory,
      manifest: candidate.manifest,
      issue: { code, message },
    });
    if (reserved.has(candidate.id)) {
      return refuse(
        'plugin-id-reserved',
        `Plugin id "${candidate.id}" is used by a plugin that comes with the Server`,
      );
    }
    const directories = directoriesById.get(candidate.id) ?? [];
    if (directories.length > 1) {
      return refuse(
        'plugin-duplicate-id',
        `Plugin id "${candidate.id}" is declared by more than one directory (${directories.join(', ')}); none of them is used until only one is left`,
      );
    }
    return candidate;
  });
}

/**
 * Looks through a plugins directory and reports what each plugin directory in
 * it is. It reads files and nothing more: no plugin code runs, which is what
 * lets the user see a plugin's declarations before deciding to trust it.
 *
 * Only the directory's own subdirectories are looked at, and only those that
 * have a `weave-plugin.json`; hidden ones and plain files are skipped. A
 * subdirectory that is a link to a directory is reported invalid and not
 * followed.
 */
export async function discoverLocalPlugins(options: DiscoverOptions): Promise<DiscoveryResult> {
  const declarations = await scanLocalPluginDeclarations(options);
  return finalizeLocalPluginDiscovery(
    declarations,
    new Set(declarations.exists ? options.reservedIds : undefined),
  );
}

export function finalizeLocalPluginDiscovery(
  { directory, exists, candidates, truncated }: DiscoveryResult,
  reservedIds: ReadonlySet<string>,
): DiscoveryResult {
  return { directory, exists, candidates: applyIdRules(candidates, reservedIds), truncated };
}

/** Captures the inspected declarations before applying any ID policy. */
export async function scanLocalPluginDeclarations(
  options: DiscoverOptions,
): Promise<LocalPluginDeclarationScan> {
  assertHostVersion(options.hostVersion);
  const { directory, exists, truncated, complete, observations, rootIssue } =
    await observeLocalPluginDeclarations(options);
  if (rootIssue !== undefined) throw rootIssue;
  const candidates: LocalPluginCandidate[] = [];
  for (const observation of observations) {
    candidates.push(
      'descriptor' in observation
        ? await inspectPayload(observation.directory, observation.descriptor, options)
        : observation,
    );
  }
  return { directory, exists, candidates, truncated, complete };
}

/** Reads descriptor claims without resolving, hashing or executing plugin payloads. */
export async function inspectLocalPluginDeclarationClaims(
  options: DiscoverOptions,
  signal?: AbortSignal,
): Promise<LocalPluginDeclarationClaims> {
  const { observations, complete } = await observeLocalPluginDeclarations(options, signal);
  signal?.throwIfAborted();
  const ids = new Set<string>();
  for (const observation of observations) {
    if ('descriptor' in observation) ids.add(observation.descriptor.manifest.id);
  }
  return { pluginIds: [...ids], complete };
}

type DescriptorObservation =
  { readonly directory: string; readonly descriptor: PluginDescriptor } | InvalidLocalPlugin;

interface DeclarationObservations {
  readonly directory: string;
  readonly exists: boolean;
  readonly truncated: boolean;
  readonly complete: boolean;
  readonly observations: readonly DescriptorObservation[];
  readonly rootIssue?: PluginHostError;
}

async function observeLocalPluginDeclarations(
  options: DiscoverOptions,
  signal?: AbortSignal,
): Promise<DeclarationObservations> {
  signal?.throwIfAborted();
  const root = path.resolve(options.directory);
  const maxCandidates = options.maxCandidates ?? defaultMaxCandidates;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    signal?.throwIfAborted();
    const missing = hasCode(error, 'ENOENT');
    return {
      directory: root,
      exists: false,
      truncated: false,
      complete: missing,
      observations: [],
      ...(missing
        ? {}
        : {
            rootIssue: new PluginHostError(
              'plugin-unreadable',
              `Cannot read the plugins directory ${root}: ${describeError(error)}`,
              { cause: error },
            ),
          }),
    };
  }
  signal?.throwIfAborted();

  // A link to a directory is not followed, but it is reported: a developer
  // who links a checkout in should be told why it is not loaded.
  const plugins: { readonly name: string; readonly info?: Stats }[] = [];
  let complete = true;
  entries.sort((left, right) => compareBytes(left.name, right.name));
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (entry.name.startsWith('.')) continue;
    const directory = path.join(root, entry.name);
    if (entry.isDirectory()) {
      try {
        const info = await fs.lstat(path.join(directory, descriptorFileName));
        signal?.throwIfAborted();
        plugins.push({ name: entry.name, info });
      } catch (error: unknown) {
        signal?.throwIfAborted();
        // Keep the legacy no-row behavior if the descriptor could not be observed.
        if (!hasCode(error, 'ENOENT')) complete = false;
      }
    } else if (entry.isSymbolicLink() && (await pointsToDirectory(directory, signal))) {
      plugins.push({ name: entry.name });
    }
  }
  const truncated = plugins.length > maxCandidates;

  const observations: DescriptorObservation[] = [];
  for (const { name, info } of plugins.slice(0, maxCandidates)) {
    signal?.throwIfAborted();
    const directory = path.join(root, name);
    if (info === undefined) {
      observations.push(
        invalidCandidate(
          name,
          directory,
          new PluginHostError(
            'plugin-unsupported-file',
            `Plugin directory ${directory} is a symbolic link; copy the plugin into the plugins directory instead, because a link can change without the digest noticing`,
          ),
        ),
      );
      continue;
    }
    try {
      const text = await readDescriptorText(path.join(directory, descriptorFileName), info, signal);
      signal?.throwIfAborted();
      if (text !== undefined) observations.push({ directory, descriptor: parseDescriptor(text) });
    } catch (error: unknown) {
      signal?.throwIfAborted();
      if (!(error instanceof PluginHostError) || error.code !== 'plugin-invalid-descriptor') {
        complete = false;
      }
      observations.push(invalidCandidate(name, directory, error));
    }
  }

  return {
    directory: root,
    exists: true,
    observations,
    truncated,
    complete: complete && !truncated,
  };
}
