import { constants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { isSkillResourcePath } from '@weave/plugin';

import { SkillHostError, type SkillScanBudget } from './skill-types.js';

export interface SkillRootIdentity {
  readonly directory: string;
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ancestors: readonly {
    readonly directory: string;
    readonly dev: number;
    readonly ino: number;
  }[];
}
export function isMissingSkillPath(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
export function checkSkillAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function inspectSkillRoot(
  directory: string,
  signal?: AbortSignal,
): Promise<SkillRootIdentity> {
  checkSkillAbort(signal);
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  const ancestors: { directory: string; dev: number; ino: number }[] = [];
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    checkSkillAbort(signal);
    current = path.join(current, part);
    const component = await fs.lstat(current);
    if (component.isSymbolicLink()) {
      // macOS publishes these OS-owned aliases for its real system directories.
      // All project/data path components below them remain subject to no-follow.
      const canonical = await fs.realpath(current);
      if (
        process.platform !== 'darwin' ||
        !['/var', '/tmp', '/etc'].includes(current) ||
        canonical !== `/private${current}`
      )
        throw new SkillHostError('skill-unsafe-entry');
    } else if (!component.isDirectory()) throw new SkillHostError('skill-unsafe-entry');
    ancestors.push({ directory: current, dev: component.dev, ino: component.ino });
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SkillHostError('skill-unsafe-entry');
  const canonical = await fs.realpath(absolute);
  const after = await fs.lstat(canonical);
  if (stat.dev !== after.dev || stat.ino !== after.ino)
    throw new SkillHostError('skill-source-changed');
  checkSkillAbort(signal);
  for (const ancestor of ancestors) {
    const current = await fs.lstat(ancestor.directory);
    if (current.dev !== ancestor.dev || current.ino !== ancestor.ino)
      throw new SkillHostError('skill-source-changed');
  }
  return {
    directory: canonical,
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    ancestors,
  };
}

/** Recheck every relative component before and after a bounded no-follow file open. */
export async function inspectSkillPath(
  root: SkillRootIdentity,
  relative: string,
  kind: 'file' | 'directory',
): Promise<Stats> {
  if (!isSkillResourcePath(relative)) throw new SkillHostError('skill-unsafe-entry');
  for (const ancestor of root.ancestors) {
    const current = await fs.lstat(ancestor.directory);
    if (current.dev !== ancestor.dev || current.ino !== ancestor.ino)
      throw new SkillHostError('skill-source-changed');
  }
  const rootStat = await fs.lstat(root.directory);
  if (
    !rootStat.isDirectory() ||
    rootStat.dev !== root.dev ||
    rootStat.ino !== root.ino ||
    rootStat.mtimeMs !== root.mtimeMs ||
    rootStat.ctimeMs !== root.ctimeMs
  )
    throw new SkillHostError('skill-source-changed');
  const segments = relative.split('/');
  let current = root.directory;
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]!);
    const stat = await fs.lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index < segments.length - 1
        ? !stat.isDirectory()
        : kind === 'file'
          ? !stat.isFile()
          : !stat.isDirectory())
    )
      throw new SkillHostError('skill-unsafe-entry');
    if (index === segments.length - 1) return stat;
  }
  throw new SkillHostError('skill-unsafe-entry');
}

export async function readSkillBytes(input: {
  root: SkillRootIdentity;
  relative: string;
  maxBytes: number;
  budget: SkillScanBudget;
  signal?: AbortSignal;
}): Promise<Buffer> {
  checkSkillAbort(input.signal);
  const before = await inspectSkillPath(input.root, input.relative, 'file');
  if (before.size > input.maxBytes || before.size > input.budget.remainingBytes) {
    input.budget.remainingBytes = Math.max(0, input.budget.remainingBytes - before.size);
    throw new SkillHostError('skill-limit-exceeded');
  }
  const file = await fs.open(
    path.join(input.root.directory, ...input.relative.split('/')),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    )
      throw new SkillHostError('skill-source-changed');
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      checkSkillAbort(input.signal);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, input.maxBytes - bytes + 1));
      const read = await file.read(chunk, 0, chunk.length, null);
      if (read.bytesRead === 0) break;
      bytes += read.bytesRead;
      input.budget.remainingBytes -= read.bytesRead;
      if (bytes > input.maxBytes || input.budget.remainingBytes < 0) {
        input.budget.remainingBytes = Math.max(0, input.budget.remainingBytes);
        throw new SkillHostError('skill-limit-exceeded');
      }
      chunks.push(chunk.subarray(0, read.bytesRead));
    }
    const after = await file.stat();
    const named = await inspectSkillPath(input.root, input.relative, 'file');
    if (
      after.size !== bytes ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== after.dev ||
      named.ino !== after.ino ||
      named.size !== after.size ||
      named.mtimeMs !== after.mtimeMs ||
      named.ctimeMs !== after.ctimeMs
    )
      throw new SkillHostError('skill-source-changed');
    checkSkillAbort(input.signal);
    return Buffer.concat(chunks, bytes);
  } finally {
    await file.close();
  }
}

export function decodeSkillText(bytes: Buffer, document: boolean): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('binary text');
    return text;
  } catch (cause: unknown) {
    throw new SkillHostError(document ? 'skill-invalid-document' : 'skill-unsupported-text', {
      cause,
    });
  }
}
