import { lstatSync, realpathSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { defaultDigestLimits } from '@weave/plugin-host';
import { z } from 'zod';
import {
  absoluteStorePathSchema,
  initialBindingSchema,
  PluginStoreOwnershipError,
} from './plugin-store-ownership-types.js';

const maxTrees = 64;
const maxPayloadEntries = 2_000;
const maxPayloadDepth = 64;
const maxPayloadBytes = BigInt(defaultDigestLimits.maxBytes);
const artifactName = /^[0-9a-f]{64}$/;
const operationName = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ownerName = 'ownership.sqlite';
const journalName = `${ownerName}-journal`;
const sqliteSidecarSuffixes = ['-journal', '-wal', '-shm'] as const;

type EntryKind = 'file' | 'directory';

const identitySchema = z.strictObject({ dev: z.bigint().positive(), ino: z.bigint().positive() });
type Identity = Readonly<z.infer<typeof identitySchema>>;

export const validatedStorePathsSchema = z.strictObject({
  databaseFile: absoluteStorePathSchema,
  storeDirectory: absoluteStorePathSchema,
  ownerDatabaseFile: absoluteStorePathSchema,
  rootExists: z.boolean(),
  mainIdentity: identitySchema,
  rootIdentity: identitySchema.optional(),
  ownerIdentity: identitySchema.optional(),
});

export type ValidatedStorePaths = Readonly<z.infer<typeof validatedStorePathsSchema>>;

const pathOptionsSchema = z.strictObject({
  databaseFile: absoluteStorePathSchema,
  directory: absoluteStorePathSchema,
  initialBinding: initialBindingSchema,
});

function invalid(message: string, cause?: unknown): PluginStoreOwnershipError {
  return new PluginStoreOwnershipError('plugin-store-invalid', message, { cause });
}

function entryIdentity(stat: BigIntStats, kind: EntryKind): Identity {
  if (
    stat.dev <= 0n ||
    stat.ino <= 0n ||
    (kind === 'directory' ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
  ) {
    throw invalid('Managed store entries must have supported file identities and types');
  }
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function hasStorePathCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

export async function readStorePathStat(path: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(path, { bigint: true });
  } catch (error: unknown) {
    if (hasStorePathCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

export async function readStorePathIdentity(
  path: string,
  kind: EntryKind,
): Promise<Identity | undefined> {
  const stat = await readStorePathStat(path);
  return stat === undefined ? undefined : entryIdentity(stat, kind);
}

export function assertStorePathIdentity(path: string, kind: EntryKind, expected: Identity): void {
  const stat = lstatSync(path, { bigint: true });
  if (!sameIdentity(entryIdentity(stat, kind), expected) || realpathSync.native(path) !== path) {
    throw invalid('A managed store path changed after validation');
  }
}

export function checkOwnerSidecars(ownerFile: string, allowJournal: boolean): void {
  const journal = lstatSync(`${ownerFile}-journal`, { bigint: true, throwIfNoEntry: false });
  if (journal !== undefined) {
    if (!allowJournal) throw invalid('Managed store journal has no owner database');
    entryIdentity(journal, 'file');
  }
  for (const suffix of ['-wal', '-shm']) {
    if (lstatSync(`${ownerFile}${suffix}`, { throwIfNoEntry: false }) !== undefined) {
      throw invalid('Managed owner database sidecars are unexpected');
    }
  }
}

async function canonicalLeaf(path: string, kind: EntryKind) {
  const leaf = basename(path);
  if (!leaf || leaf === '.' || leaf === '..') throw invalid('A managed path must name a leaf');
  // Resolve the raw parent so native lookup processes symlinks before any later `..`.
  const candidate = join(await fs.realpath(dirname(path)), leaf);
  const identity = await readStorePathIdentity(candidate, kind);
  if (identity === undefined) return { path: candidate, identity };
  const canonical = await fs.realpath(candidate);
  const current = await readStorePathIdentity(candidate, kind);
  if (current === undefined || !sameIdentity(identity, current)) {
    throw invalid('A managed store path changed during validation');
  }
  assertStorePathIdentity(canonical, kind, identity);
  return { path: canonical, identity };
}

function isInDirectory(directory: string, candidate: string): boolean {
  const child = relative(directory, candidate);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

async function isMainSidecarRoot(
  root: string,
  databaseFile: string,
  mainIdentity: Identity,
): Promise<boolean> {
  const parent = dirname(databaseFile);
  if (dirname(root) !== parent) return false;
  const name = basename(root);
  const suffix = sqliteSidecarSuffixes.find(
    (suffix) => name.slice(-suffix.length).toLowerCase() === suffix,
  );
  if (suffix === undefined) return false;
  // A sidecar may be absent. Look up the existing stem using the filesystem's own
  // name equivalence while conservatively reserving ASCII case variants of its suffix.
  const stem = await readStorePathStat(join(parent, name.slice(0, -suffix.length)));
  return stem !== undefined && stem.isFile() && sameIdentity(stem, mainIdentity);
}

async function scanPayload(payload: string, published: boolean): Promise<void> {
  let entries = 0;
  let files = 0;
  let bytes = 0n;

  async function walk(directory: string, depth: number): Promise<void> {
    for await (const child of await fs.opendir(directory)) {
      entries += 1;
      if (entries > maxPayloadEntries)
        throw invalid('Managed store payload exceeds its entry bound');
      const path = join(directory, child.name);
      const stat = await fs.lstat(path, { bigint: true });
      if (stat.isDirectory()) {
        entryIdentity(stat, 'directory');
        if (depth === maxPayloadDepth)
          throw invalid('Managed store payload exceeds its depth bound');
        await walk(path, depth + 1);
      } else {
        entryIdentity(stat, 'file');
        if (published) {
          files += 1;
          bytes += stat.size;
          if (files > defaultDigestLimits.maxFiles || bytes > maxPayloadBytes) {
            throw invalid('Managed store payload exceeds its file or byte bound');
          }
        }
      }
    }
  }

  // Operation root and its optional payload wrapper are visited separately.
  // The same payload bounds permit 2,001 entries and depth 65 from that operation root.
  await walk(payload, 0);
}

async function scanTrees(directory: string, published: boolean): Promise<void> {
  const validName = published ? artifactName : operationName;
  let trees = 0;
  for await (const child of await fs.opendir(directory)) {
    trees += 1;
    if (trees > maxTrees || !validName.test(child.name)) {
      throw invalid('Managed store artifact or staging trees are unexpected');
    }
    const tree = join(directory, child.name);
    entryIdentity(await fs.lstat(tree, { bigint: true }), 'directory');
    let hasPayload = false;
    for await (const entry of await fs.opendir(tree)) {
      if (entry.name !== 'payload')
        throw invalid('Managed store tree contains an unexpected entry');
      const payload = join(tree, entry.name);
      entryIdentity(await fs.lstat(payload, { bigint: true }), 'directory');
      await scanPayload(payload, published);
      hasPayload = true;
    }
    if (published && !hasPayload) throw invalid('Published artifact payload is missing');
  }
}

export async function scanStoreLayout(
  directory: string,
  phase: 'before-acquisition' | 'held',
): Promise<Identity | undefined> {
  entryIdentity(await fs.lstat(directory, { bigint: true }), 'directory');
  const ownerPath = join(directory, ownerName);
  let owner = await readStorePathIdentity(ownerPath, 'file');
  const scanDescendants = owner === undefined || phase === 'held';
  let hasJournal = false;
  for await (const child of await fs.opendir(directory)) {
    const path = join(directory, child.name);
    switch (child.name) {
      case 'artifacts':
      case 'staging':
        entryIdentity(await fs.lstat(path, { bigint: true }), 'directory');
        if (scanDescendants) await scanTrees(path, child.name === 'artifacts');
        break;
      case ownerName:
        // Retain any owner identity already observed, so replacement fails on open.
        owner ??= entryIdentity(await fs.lstat(path, { bigint: true }), 'file');
        break;
      case journalName: {
        // SQLite may remove a rollback journal while we inspect a busy root.
        const stat = await readStorePathStat(path);
        if (stat !== undefined) entryIdentity(stat, 'file');
        hasJournal = stat !== undefined;
        break;
      }
      default:
        throw invalid('Managed store root contains an unexpected entry');
    }
  }
  if (hasJournal && owner === undefined) {
    owner = await readStorePathIdentity(ownerPath, 'file');
    if (owner === undefined) throw invalid('Managed store journal has no owner database');
  }
  return owner;
}

export async function validateStorePaths(
  options: Readonly<z.input<typeof pathOptionsSchema>>,
): Promise<ValidatedStorePaths> {
  try {
    const parsed = pathOptionsSchema.parse(options);
    const [main, root] = await Promise.all([
      canonicalLeaf(parsed.databaseFile, 'file'),
      canonicalLeaf(parsed.directory, 'directory'),
    ]);
    if (main.identity === undefined)
      throw invalid('Managed authority requires its main database file');
    if (
      isInDirectory(root.path, main.path) ||
      (await isMainSidecarRoot(root.path, main.path, main.identity))
    ) {
      throw invalid('Managed store cannot contain the main authority database or its sidecars');
    }
    const ownerDatabaseFile = join(root.path, ownerName);
    const ownerIdentity =
      root.identity === undefined
        ? undefined
        : await scanStoreLayout(root.path, 'before-acquisition');
    return Object.freeze({
      databaseFile: main.path,
      storeDirectory: root.path,
      ownerDatabaseFile,
      rootExists: root.identity !== undefined,
      mainIdentity: Object.freeze(main.identity),
      rootIdentity: Object.freeze(root.identity),
      ownerIdentity: Object.freeze(ownerIdentity),
    });
  } catch (error: unknown) {
    if (error instanceof PluginStoreOwnershipError) throw error;
    throw invalid('Managed store paths or layout could not be validated', error);
  }
}
