import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  GithubAcquisitionError,
  githubPluginSourceSchema,
  invalid,
  safeSegments,
  tooLarge,
  type GithubPluginAcquirer,
  type GithubPluginAcquirerOptions,
  type GithubPluginSource,
} from './github-source.js';
import { recoverGithubScratch, removeGithubOperation } from './github-scratch.js';
import { createGithubTransport, maxFileBytes, type GithubTransport } from './github-transport.js';

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const commitSchema = z.object({ sha: shaSchema, tree: z.object({ sha: shaSchema }) });
const treeSchema = z.object({
  sha: shaSchema,
  truncated: z.boolean(),
  tree: z.array(
    z.object({
      path: z.string(),
      mode: z.string(),
      type: z.string(),
      sha: shaSchema,
      size: z.number().int().nonnegative().safe().optional(),
    }),
  ),
});
type TreeEntry = z.infer<typeof treeSchema>['tree'][number];

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid();
  }
}

function validateTree(entries: TreeEntry[], recursive: boolean): TreeEntry[] {
  const explicit = new Set<string>();
  const portable = new Map<string, { path: string; file: boolean }>();
  const files: TreeEntry[] = [];
  const declaredDirectories = new Set(
    entries.filter((entry) => entry.type === 'tree').map((entry) => entry.path),
  );
  let bytes = 0;
  for (const entry of entries) {
    const segments = safeSegments(entry.path);
    if (segments.length > 64) throw tooLarge();
    if (!recursive && segments.length !== 1) throw invalid();
    if (recursive) {
      for (let i = 1; i < segments.length; i += 1) {
        if (!declaredDirectories.has(segments.slice(0, i).join('/'))) throw invalid();
      }
    }
    const file = entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
    if (!file && !(entry.type === 'tree' && entry.mode === '040000')) throw invalid();
    if (file && entry.size === undefined) throw invalid();
    if (explicit.has(entry.path)) throw invalid();
    explicit.add(entry.path);
    for (let i = 0; i < segments.length; i += 1) {
      const prefix = segments.slice(0, i + 1).join('/');
      const key = prefix.normalize('NFC').toUpperCase().toLowerCase();
      const existing = portable.get(key);
      const isFile = i === segments.length - 1 && file;
      if (existing !== undefined && (existing.path !== prefix || existing.file || isFile))
        throw invalid();
      portable.set(key, { path: prefix, file: isFile });
    }
    if (file) {
      files.push(entry);
      bytes += entry.size ?? 0;
      if (recursive && (files.length > 128 || bytes > maxFileBytes)) throw tooLarge();
    }
  }
  return files;
}

async function fetchFiles(
  source: GithubPluginSource,
  transport: GithubTransport,
  payload: string,
  abort: AbortController,
): Promise<void> {
  const repositoryPath = source.repository.slice('https://github.com/'.length);
  const api = `https://api.github.com/repos/${repositoryPath}/git`;
  const commit = commitSchema.safeParse(
    parseJson(await transport.read(`${api}/commits/${source.commit}`, true)),
  );
  if (!commit.success || commit.data.sha !== source.commit) throw invalid();
  let treeSha = commit.data.tree.sha;
  let entriesSeen = 0;
  const readTree = async (recursive: boolean): Promise<TreeEntry[]> => {
    const parsed = treeSchema.safeParse(
      parseJson(
        await transport.read(`${api}/trees/${treeSha}${recursive ? '?recursive=1' : ''}`, true),
      ),
    );
    if (!parsed.success || parsed.data.sha !== treeSha) throw invalid();
    if (parsed.data.truncated) throw invalid();
    entriesSeen += parsed.data.tree.length;
    if (entriesSeen > 2_000) throw tooLarge();
    validateTree(parsed.data.tree, recursive);
    return parsed.data.tree;
  };
  for (const segment of source.subdirectory === '' ? [] : source.subdirectory.split('/')) {
    const entry = (await readTree(false)).find((item) => item.path === segment);
    if (entry === undefined)
      throw new GithubAcquisitionError(
        'plugin-github-unavailable',
        'The GitHub plugin source is unavailable',
      );
    if (entry.type !== 'tree') throw invalid();
    treeSha = entry.sha;
  }
  const entries = await readTree(true);
  const files = validateTree(entries, true);
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.path.split('/');
    const depth = entry.type === 'tree' ? segments.length : segments.length - 1;
    for (let i = 1; i <= depth; i += 1) directories.add(segments.slice(0, i).join('/'));
  }
  for (const directory of [...directories].sort(
    (a, b) => a.split('/').length - b.split('/').length,
  )) {
    abort.signal.throwIfAborted();
    await fs.mkdir(path.join(payload, directory), { mode: 0o700 });
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    try {
      while (next < files.length) {
        abort.signal.throwIfAborted();
        const entry = files[next++];
        if (entry === undefined) return;
        const rawPath = [
          ...(source.subdirectory === '' ? [] : source.subdirectory.split('/')),
          ...entry.path.split('/'),
        ]
          .map(encodeURIComponent)
          .join('/');
        const bytes = await transport.read(
          `https://raw.githubusercontent.com/${repositoryPath}/${source.commit}/${rawPath}`,
          false,
          entry.size,
        );
        abort.signal.throwIfAborted();
        const hash = createHash('sha1')
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        if (hash !== entry.sha) throw invalid();
        await fs.writeFile(path.join(payload, entry.path), bytes, { flag: 'wx', mode: 0o600 });
      }
    } catch (error: unknown) {
      abort.abort(error);
      throw error;
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(4, files.length) }, worker),
  );
  for (const result of settled) if (result.status === 'rejected') throw abort.signal.reason;
  abort.signal.throwIfAborted();
}

export function createGithubPluginAcquirer({
  directory,
  fetch: fetcher = globalThis.fetch,
}: GithubPluginAcquirerOptions): GithubPluginAcquirer {
  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root)
    throw new Error('A private absolute GitHub acquisition directory is required');
  let queue: Promise<unknown> = Promise.resolve();
  return {
    withSource<T>(
      source: GithubPluginSource,
      use: (directory: string, signal: AbortSignal) => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const run = async (): Promise<T> => {
        signal?.throwIfAborted();
        const parsed = githubPluginSourceSchema.safeParse(source);
        if (!parsed.success) throw invalid('The GitHub plugin source is invalid');
        const abort = new AbortController();
        const cancel = () => abort.abort(signal?.reason);
        signal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(
          () =>
            abort.abort(
              new GithubAcquisitionError(
                'plugin-github-timeout',
                'The GitHub plugin acquisition timed out',
              ),
            ),
          60_000,
        );
        let operation: string | undefined;
        try {
          await recoverGithubScratch(directory, abort.signal);
          abort.signal.throwIfAborted();
          operation = path.join(directory, randomUUID());
          await fs.mkdir(operation, { mode: 0o700 });
          const transport = createGithubTransport(fetcher, abort.signal);
          await fetchFiles(parsed.data, transport, operation, abort);
          abort.signal.throwIfAborted();
          const result = await use(operation, abort.signal);
          abort.signal.throwIfAborted();
          await removeGithubOperation(operation);
          operation = undefined;
          abort.signal.throwIfAborted();
          return result;
        } catch (primary: unknown) {
          const failure = abort.signal.aborted ? abort.signal.reason : primary;
          if (operation !== undefined) {
            try {
              await removeGithubOperation(operation);
            } catch (cleanup: unknown) {
              throw new AggregateError(
                [failure, cleanup],
                'GitHub acquisition and cleanup failed',
                { cause: cleanup },
              );
            }
          }
          throw failure;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        }
      };
      const result = queue.then(run);
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
