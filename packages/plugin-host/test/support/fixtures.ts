import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const created: string[] = [];

/** A new empty directory that {@link removeTempDirectories} deletes. */
export async function makeTempDirectory(): Promise<string> {
  // Resolved so paths in assertions match the real paths the host reports,
  // which differ from `os.tmpdir()` where it is behind a symbolic link.
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'weave-plugin-host-'));
  created.push(directory);
  return directory;
}

/** Deletes every directory {@link makeTempDirectory} made. Call it from `afterEach`. */
export async function removeTempDirectories(): Promise<void> {
  await Promise.all(
    created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
}

/** A manifest a local plugin may have: it contributes the command `hello` and asks for nothing. */
export function manifestFor(
  id: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['command'],
    contributes: { commands: ['hello'] },
    permissions: [],
    ...over,
  };
}

/** An entry module that contributes the command `hello`. */
export const helloSource = `export default (sdk) => ({
  setup(env) {
    env.contribute(sdk.commandsExtensionPoint, (api) =>
      api.addCommand({ name: 'hello', title: 'Hello', prompt: 'Say hello to $ARGUMENTS' }),
    );
  },
});
`;

export interface PluginFiles {
  /** Merged over {@link manifestFor}. */
  readonly manifest?: Record<string, unknown>;
  /** Replaces the whole descriptor object, or its text when a string. */
  readonly descriptor?: Record<string, unknown> | string;
  /** Where the entry module is written. Defaults to `index.js`. */
  readonly entry?: string;
  /** The entry module's source. Defaults to {@link helloSource}. */
  readonly source?: string;
  /** Other files, by relative path. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Writes a plugin directory under `parent` and returns its path. The default
 * is a valid plugin; each option replaces one part of it.
 */
export async function writePlugin(
  parent: string,
  name: string,
  files: PluginFiles = {},
): Promise<string> {
  const directory = path.join(parent, name);
  await mkdir(directory, { recursive: true });
  const entry = files.entry ?? 'index.js';
  const manifest = manifestFor(name, files.manifest);
  const descriptor = files.descriptor ?? { schemaVersion: 1, entry, manifest };
  await writeFile(
    path.join(directory, 'weave-plugin.json'),
    typeof descriptor === 'string' ? descriptor : JSON.stringify(descriptor, null, 2),
  );
  await writeFileIn(directory, entry, files.source ?? helloSource);
  for (const [relative, content] of Object.entries(files.files ?? {})) {
    await writeFileIn(directory, relative, content);
  }
  return directory;
}

/** Writes `content` to `relative` inside `directory`, making the folders it needs. */
export async function writeFileIn(
  directory: string,
  relative: string,
  content: string,
): Promise<void> {
  const target = path.join(directory, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}
