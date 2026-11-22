import { inspectPluginPayload, type PluginArtifact } from '@weave/plugin-host';

import { validateEsmArtifact } from './bundle.js';
import { PluginCliError } from './errors.js';
import { captureSnapshot, verifySnapshot } from './snapshot.js';
import type { DirectorySnapshot, HostOptions, OperationOptions } from './types.js';

const rootDocs = new Set(['README.md', 'LICENSE', 'NOTICE']);
const sourceRoots = new Set(['weave-plugin.json', 'package.json', 'tsconfig.json', ...rootDocs]);
const sourcePolicy = (message: string) => new PluginCliError('plugin-cli-source-policy', message);
const maxDocBytes = 64 * 1024;
function checkDocs(snapshot: DirectorySnapshot) {
  for (const name of rootDocs) {
    const bytes = snapshot.files.get(name);
    if (bytes !== undefined && bytes.byteLength > maxDocBytes)
      throw sourcePolicy(`Root document ${name} exceeds 64 KiB`);
  }
}

export function assertSourceProfile(snapshot: DirectorySnapshot): void {
  if (snapshot.files.size > 128 || snapshot.directories.length + snapshot.files.size - 1 > 512)
    throw sourcePolicy('The source exceeds its file or entry bounds');
  let total = 0;
  for (const [relative, bytes] of snapshot.files) {
    total += bytes.byteLength;
    if (bytes.byteLength > 256 * 1024 || relative.split('/').length > 17)
      throw sourcePolicy(`Source ${relative} exceeds the size or depth limit`);
    if (relative.startsWith('src/')) {
      if (
        !relative.endsWith('.ts') ||
        relative.endsWith('.d.ts') ||
        relative
          .split('/')
          .some(
            (part) =>
              part === 'node_modules' ||
              part === 'coverage' ||
              part === '.env' ||
              part.startsWith('.env.'),
          )
      )
        throw sourcePolicy(`Unsupported TypeScript source ${relative}`);
    } else if (!sourceRoots.has(relative))
      throw sourcePolicy(`Unsupported source root ${relative}`);
  }
  if (total > 4 * 1024 * 1024) throw sourcePolicy('Source exceeds 4 MiB');
  for (const relative of snapshot.directories) {
    if (!relative) continue;
    if (
      (relative !== 'src' && !relative.startsWith('src/')) ||
      relative.split('/').length > 16 ||
      !hygienic(relative)
    )
      throw sourcePolicy(`Unsupported source directory ${relative}`);
  }
  if (
    !snapshot.files.has('weave-plugin.json') ||
    !snapshot.files.has('package.json') ||
    !snapshot.files.has('src/index.ts')
  )
    throw sourcePolicy('Executable source needs a descriptor, package.json and src/index.ts');
  checkDocs(snapshot);
}
function hygienic(relative: string): boolean {
  return relative
    .split('/')
    .every(
      (part) =>
        part !== 'node_modules' &&
        part !== 'coverage' &&
        part !== '.env' &&
        !part.startsWith('.env.') &&
        !part.endsWith('.map'),
    );
}

export async function inspectCliArtifact(
  directory: string,
  options: HostOptions & OperationOptions = {},
): Promise<PluginArtifact> {
  const selected = { hostVersion: options.hostVersion, signal: options.signal };
  options.signal?.throwIfAborted();
  const before = await inspectPluginPayload(directory, selected);
  const snapshot = await captureSnapshot(directory, { signal: options.signal });
  checkDocs(snapshot);
  if (before.kind === 'skills') {
    for (const relative of [...snapshot.directories, ...snapshot.files.keys()]) {
      if (relative.startsWith('skills/') && !hygienic(relative))
        throw sourcePolicy(`Unsupported publish resource ${relative}`);
    }
  } else {
    if (before.descriptor.schemaVersion !== 1 || before.descriptor.entry !== 'index.mjs')
      throw sourcePolicy('CLI artifacts require the single entry index.mjs');
    if (snapshot.directories.some((relative) => relative !== ''))
      throw sourcePolicy('CLI executable payloads have no subdirectories');
    for (const relative of snapshot.files.keys())
      if (relative !== 'weave-plugin.json' && relative !== 'index.mjs' && !rootDocs.has(relative))
        throw sourcePolicy(`Unsupported executable payload ${relative}`);
    const entry = snapshot.files.get('index.mjs');
    if (entry === undefined) throw sourcePolicy('The executable payload is missing index.mjs');
    validateEsmArtifact(entry);
  }
  await verifySnapshot(snapshot, options.signal);
  const after = await inspectPluginPayload(directory, selected);
  if (
    before.kind !== after.kind ||
    before.digest !== after.digest ||
    before.files !== after.files ||
    before.bytes !== after.bytes ||
    JSON.stringify(before.descriptor) !== JSON.stringify(after.descriptor)
  )
    throw new PluginCliError(
      'plugin-cli-source-changed',
      'The artifact changed while checking its CLI profile',
    );
  options.signal?.throwIfAborted();
  return after;
}
