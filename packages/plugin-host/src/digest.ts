import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describeError, PluginHostError } from './errors.js';

/** How much of a directory the host will hash. */
export interface DigestLimits {
  readonly maxFiles: number;
  readonly maxBytes: number;
}

/**
 * The largest plugin the host accepts: 1000 files and 20 MB. A plugin is meant
 * to be one bundled file, and the digest only means something if the host can
 * read all of it.
 */
export const defaultDigestLimits: DigestLimits = Object.freeze({
  maxFiles: 1000,
  maxBytes: 20 * 1024 * 1024,
});

/** What {@link computeDirectoryDigest} measured. */
export interface DirectoryDigest {
  /** 64 lowercase hexadecimal characters. */
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
}

export interface DigestOptions {
  readonly limits?: Partial<DigestLimits> | undefined;
  /** Named in the errors, once the caller knows which plugin the directory belongs to. */
  readonly pluginId?: string | undefined;
}

/** Version control and file-manager droppings that are not part of the plugin. */
const ignoredNames: ReadonlySet<string> = new Set(['.git', '.DS_Store', 'Thumbs.db']);

interface FileEntry {
  readonly relativePath: string;
  readonly absolutePath: string;
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/**
 * Hashes everything in a plugin directory, so a trust decision binds to what
 * is on disk and not to a version number or a path.
 *
 * ```text
 * files  = every regular file below the directory, except .git, .DS_Store and Thumbs.db
 * order  = relative path, `/`-separated, by UTF-8 byte order
 * digest = sha256 over, for each file in order:
 *          utf8(path) 0x00 decimal(size) 0x00 sha256-hex(content) 0x0a
 * ```
 *
 * Neither the order the file system lists files in nor when they were written
 * matters. Symbolic links and special files are refused (`plugin-unsupported-file`)
 * because a link can be re-pointed without changing a byte the digest saw, and
 * a directory over the limits is refused (`plugin-too-large`).
 */
export async function computeDirectoryDigest(
  directory: string,
  options: DigestOptions = {},
): Promise<DirectoryDigest> {
  const limits = { ...defaultDigestLimits, ...options.limits };
  const { pluginId } = options;
  const root = path.resolve(directory);

  const tooLarge = (what: string): PluginHostError =>
    new PluginHostError(
      'plugin-too-large',
      `Plugin directory ${root} has ${what}; bundle the plugin into a single file`,
      { pluginId },
    );

  try {
    const files: FileEntry[] = [];
    let listedBytes = 0;

    const walk = async (relativeDirectory: string): Promise<void> => {
      const absoluteDirectory = path.join(root, ...relativeDirectory.split('/').filter(Boolean));
      for (const entry of await readdir(absoluteDirectory, { withFileTypes: true })) {
        if (ignoredNames.has(entry.name)) {
          continue;
        }
        const relativePath =
          relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`;
        const absolutePath = path.join(absoluteDirectory, entry.name);
        if (entry.isSymbolicLink()) {
          throw new PluginHostError(
            'plugin-unsupported-file',
            `Plugin directory ${root} contains the symbolic link "${relativePath}"; copy the files instead, because a link can change without the digest noticing`,
            { pluginId },
          );
        }
        if (entry.isDirectory()) {
          await walk(relativePath);
          continue;
        }
        if (!entry.isFile()) {
          throw new PluginHostError(
            'plugin-unsupported-file',
            `Plugin directory ${root} contains "${relativePath}", which is neither a regular file nor a directory`,
            { pluginId },
          );
        }
        files.push({ relativePath, absolutePath });
        listedBytes += (await lstat(absolutePath)).size;
        if (files.length > limits.maxFiles) {
          throw tooLarge(`more than ${String(limits.maxFiles)} files`);
        }
        if (listedBytes > limits.maxBytes) {
          throw tooLarge(`more than ${String(limits.maxBytes)} bytes of files`);
        }
      }
    };
    await walk('');

    files.sort((left, right) => compareBytes(left.relativePath, right.relativePath));

    const outer = createHash('sha256');
    let bytes = 0;
    for (const file of files) {
      const content = await readFile(file.absolutePath);
      // The size read now is the one that counts: the file may have changed
      // since it was listed.
      bytes += content.length;
      if (bytes > limits.maxBytes) {
        throw tooLarge(`more than ${String(limits.maxBytes)} bytes of files`);
      }
      outer.update(Buffer.from(file.relativePath, 'utf8'));
      outer.update(Buffer.from([0]));
      outer.update(String(content.length));
      outer.update(Buffer.from([0]));
      outer.update(createHash('sha256').update(content).digest('hex'));
      outer.update('\n');
    }
    return { digest: outer.digest('hex'), files: files.length, bytes };
  } catch (error: unknown) {
    if (error instanceof PluginHostError) {
      throw error;
    }
    throw new PluginHostError(
      'plugin-unreadable',
      `Cannot read plugin directory ${root}: ${describeError(error)}`,
      { cause: error, pluginId },
    );
  }
}
