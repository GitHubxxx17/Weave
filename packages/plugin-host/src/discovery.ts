import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
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

const defaultMaxCandidates = 200;

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
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
async function pointsToDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Whether the directory has an entry named like a descriptor, whatever it is. */
async function holdsDescriptor(directory: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, descriptorFileName));
    return true;
  } catch {
    return false;
  }
}

/** Reads the descriptor text, or `undefined` when the directory has none. */
async function readDescriptorText(directory: string): Promise<string | undefined> {
  const file = path.join(directory, descriptorFileName);
  let info;
  try {
    info = await lstat(file);
  } catch (error: unknown) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
  if (!info.isFile()) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `${descriptorFileName} must be a regular file, not a link or a directory`,
    );
  }
  if (info.size > maxDescriptorBytes) {
    throw new PluginHostError(
      'plugin-invalid-descriptor',
      `${descriptorFileName} is larger than ${String(maxDescriptorBytes / 1024)} KB`,
    );
  }
  return readFile(file, 'utf8');
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
    info = await lstat(candidate);
  } catch (error: unknown) {
    if (isMissing(error)) {
      throw invalid(`Entry "${descriptor.entry}" does not exist in the plugin directory`);
    }
    throw error;
  }
  if (!info.isFile()) {
    throw invalid(`Entry "${descriptor.entry}" is not a regular file`);
  }
  const [realDirectory, realEntry] = await Promise.all([realpath(directory), realpath(candidate)]);
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

/** Reads one plugin directory. `undefined` means it has no descriptor, so it is not a plugin. */
async function inspect(
  directory: string,
  name: string,
  options: DiscoverOptions,
): Promise<LocalPluginCandidate | undefined> {
  let descriptor: PluginDescriptor;
  try {
    const text = await readDescriptorText(directory);
    if (text === undefined) {
      return undefined;
    }
    descriptor = parseDescriptor(text);
  } catch (error: unknown) {
    return invalidCandidate(name, directory, error);
  }

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
  return declarations.exists
    ? finalizeLocalPluginDiscovery(declarations, new Set(options.reservedIds ?? []))
    : declarations;
}

export function finalizeLocalPluginDiscovery(
  declarations: DiscoveryResult,
  reservedIds: ReadonlySet<string>,
): DiscoveryResult {
  return { ...declarations, candidates: applyIdRules(declarations.candidates, reservedIds) };
}

/** Captures the inspected declarations before applying any ID policy. */
export async function scanLocalPluginDeclarations(
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  assertHostVersion(options.hostVersion);
  const root = path.resolve(options.directory);
  const maxCandidates = options.maxCandidates ?? defaultMaxCandidates;

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { directory: root, exists: false, candidates: [], truncated: false };
    }
    throw new PluginHostError(
      'plugin-unreadable',
      `Cannot read the plugins directory ${root}: ${describeError(error)}`,
      { cause: error },
    );
  }

  // A link to a directory is not followed, but it is reported: a developer
  // who links a checkout in should be told why it is not loaded.
  const subdirectories: { readonly name: string; readonly link: boolean }[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (entry.isDirectory()) {
      subdirectories.push({ name: entry.name, link: false });
    } else if (entry.isSymbolicLink() && (await pointsToDirectory(path.join(root, entry.name)))) {
      subdirectories.push({ name: entry.name, link: true });
    }
  }
  subdirectories.sort((left, right) => compareBytes(left.name, right.name));

  // Only a directory with a descriptor is a plugin. A link is listed without
  // looking inside it.
  const plugins: { readonly name: string; readonly link: boolean }[] = [];
  for (const subdirectory of subdirectories) {
    if (subdirectory.link || (await holdsDescriptor(path.join(root, subdirectory.name)))) {
      plugins.push(subdirectory);
    }
  }
  const truncated = plugins.length > maxCandidates;

  const found: LocalPluginCandidate[] = [];
  for (const { name, link } of plugins.slice(0, maxCandidates)) {
    const directory = path.join(root, name);
    if (link) {
      found.push(
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
    const candidate = await inspect(directory, name, options);
    if (candidate !== undefined) {
      found.push(candidate);
    }
  }

  return {
    directory: root,
    exists: true,
    candidates: found,
    truncated,
  };
}
