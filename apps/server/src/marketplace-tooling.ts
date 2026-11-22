import { lstat, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defaultDigestLimits,
  descriptorFileName,
  githubPluginSourceSchema,
  maxDescriptorBytes,
  parseDescriptor,
  type GithubPluginAcquirer,
} from '@weave/plugin-host';
import { z } from 'zod';
import { maxPluginMarketplaceBytes, pluginMarketplaceIndexSchema } from './plugin-marketplace.js';
import {
  assertMarketplaceFilePath,
  isMissingMarketplaceFile,
  readMarketplaceFile,
  readMarketplaceJson,
  writeMarketplaceFile,
} from './marketplace-tool-files.js';

type MarketplaceIndex = z.infer<typeof pluginMarketplaceIndexSchema>;
export type MarketplaceSubmission = MarketplaceIndex['plugins'][number];

function validateSubmission(value: unknown): MarketplaceSubmission {
  return pluginMarketplaceIndexSchema.parse({ schemaVersion: 1, plugins: [value] }).plugins[0]!;
}

function canonicalObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObject);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left === right ? 0 : 1))
      .map(([key, item]) => [key, canonicalObject(item)]),
  );
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map((part) => part.replace(/^0+(?=\d)/, ''));
  const b = right.split('.').map((part) => part.replace(/^0+(?=\d)/, ''));
  for (let i = 0; i < 3; i++) {
    if (a[i]!.length !== b[i]!.length) return b[i]!.length - a[i]!.length;
    if (a[i] !== b[i]) return a[i]! < b[i]! ? 1 : -1;
  }
  return 0;
}

function formatIndex(index: MarketplaceIndex): string {
  const plugins = [...index.plugins]
    .sort((a, b) => (a.id < b.id ? -1 : a.id === b.id ? 0 : 1))
    .map((entry) =>
      canonicalObject({
        ...entry,
        releases: [...entry.releases].sort((a, b) =>
          compareVersions(a.manifest.version, b.manifest.version),
        ),
      }),
    );
  const content = `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > maxPluginMarketplaceBytes)
    throw new Error('Generated marketplace index exceeds its size limit');
  return content;
}

export interface GenerateMarketplaceIndexOptions {
  readonly submissionsDirectory: string;
  readonly outputFile: string;
  readonly mode: 'write' | 'check';
}

/** Deterministic local collection. No source URLs are fetched and no code runs. */
export async function generateMarketplaceIndex({
  submissionsDirectory,
  outputFile,
  mode,
}: GenerateMarketplaceIndexOptions): Promise<{ plugins: number; changed: boolean }> {
  assertMarketplaceFilePath(submissionsDirectory);
  assertMarketplaceFilePath(outputFile);
  const directory = await lstat(submissionsDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error('Submissions must be an ordinary directory');
  const files: string[] = [];
  let entries = 0;
  for await (const entry of await opendir(submissionsDirectory)) {
    entries++;
    if (entries > 110) throw new Error('Too many submission directory entries');
    if (entry.name === 'README.md' || entry.name === '.gitkeep') continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\.json$/.test(entry.name) || !entry.isFile())
      throw new Error('Submission entries must be ordinary plugin-id.json files');
    files.push(entry.name);
    if (files.length > 100) throw new Error('Too many marketplace submissions');
  }
  const plugins: MarketplaceSubmission[] = [];
  for (const file of files.sort()) {
    const entry = validateSubmission(
      await readMarketplaceJson(join(submissionsDirectory, file), maxPluginMarketplaceBytes),
    );
    if (file !== `${entry.id}.json`)
      throw new Error('Submission filename must match its plugin identity');
    plugins.push(entry);
  }
  const index = pluginMarketplaceIndexSchema.parse({ schemaVersion: 1, plugins });
  const content = formatIndex(index);
  let actual: Buffer | undefined;
  try {
    actual = await readMarketplaceFile(outputFile, maxPluginMarketplaceBytes);
  } catch (cause: unknown) {
    if (!isMissingMarketplaceFile(cause)) throw cause;
  }
  const changed = actual === undefined || !actual.equals(Buffer.from(content));
  if (mode === 'check' && changed)
    throw new Error('Marketplace index is out of date; run pnpm marketplace:generate');
  if (mode === 'write' && changed) await writeMarketplaceFile(outputFile, content, true);
  return { plugins: index.plugins.length, changed };
}

const canonicalSourceSchema = githubPluginSourceSchema.extend({
  repository: z
    .string()
    .max(400)
    .refine((value) => value === value.toLowerCase())
    .pipe(githubPluginSourceSchema.shape.repository),
  subdirectory: z
    .string()
    .max(2048)
    .refine((value) => githubPluginSourceSchema.shape.subdirectory.safeParse(value).success),
});
const requestSchema = z.strictObject({
  name: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(2000),
  publisher: z.string().trim().min(1).max(300),
  tags: z.array(z.string().trim().min(1).max(40)).max(10),
  source: canonicalSourceSchema,
});

/** A descriptor supplies actual identity and declarations; no module is imported. */
export async function prepareMarketplaceSubmission(
  input: unknown,
  { acquirer }: { readonly acquirer: GithubPluginAcquirer },
): Promise<MarketplaceSubmission> {
  const request = requestSchema.parse(input);
  return acquirer.withSource(request.source, async (directory, signal) => {
    signal.throwIfAborted();
    const descriptor = parseDescriptor(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await readMarketplaceFile(join(directory, descriptorFileName), maxDescriptorBytes),
      ),
    );
    await readMarketplaceFile(join(directory, descriptor.entry), defaultDigestLimits.maxBytes);
    signal.throwIfAborted();
    return validateSubmission({
      id: descriptor.manifest.id,
      name: request.name,
      description: request.description,
      publisher: request.publisher,
      tags: request.tags,
      releases: [{ manifest: descriptor.manifest, source: request.source }],
    });
  });
}

/** Exclusive creation prevents accidentally replacing a previously reviewed release. */
export async function writeMarketplaceSubmission(
  outputFile: string,
  value: unknown,
): Promise<void> {
  const entry = validateSubmission(value);
  const content = `${JSON.stringify(canonicalObject(entry), null, 2)}\n`;
  if (Buffer.byteLength(content, 'utf8') > maxPluginMarketplaceBytes)
    throw new Error('Marketplace submission exceeds its size limit');
  await writeMarketplaceFile(outputFile, content, false);
}
