import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  fileContentDigest,
  withWorkspaceMutation,
  workspaceObjectIdentity,
} from './workspace-mutation.js';
import { createWorkspacePolicy, type WorkspacePolicy } from './workspace-policy.js';

type WorkspaceTextCaptureCode =
  | 'invalid-path'
  | 'unavailable'
  | 'unsafe-file'
  | 'changed'
  | 'root-changed'
  | 'file-limit'
  | 'batch-limit'
  | 'invalid-utf8'
  | 'binary'
  | 'cancelled'
  | 'io';

export class WorkspaceTextCaptureError extends Error {
  constructor(readonly code: WorkspaceTextCaptureCode) {
    super(code);
    this.name = 'WorkspaceTextCaptureError';
  }
}

interface RootEvidence {
  readonly canonical: string;
  readonly rootIdentity: string;
}

interface PathEvidence {
  readonly target: string;
  readonly parents: readonly { readonly target: string; readonly identity: string }[];
  readonly metadata: BigIntStats;
  readonly identity: string;
}

export interface WorkspaceCapturedText {
  readonly path: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly content: string;
  readonly fileIdentity: string;
}

type WorkspaceCaptureEntry =
  | { readonly file: WorkspaceCapturedText }
  | { readonly path: string; readonly error: WorkspaceTextCaptureError };

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw new WorkspaceTextCaptureError('cancelled');
}

function mappedFailure(
  error: unknown,
  signal: AbortSignal,
  observed = false,
): WorkspaceTextCaptureError {
  checkSignal(signal);
  if (error instanceof WorkspaceTextCaptureError) return error;
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP')
    return new WorkspaceTextCaptureError(observed ? 'changed' : 'unavailable');
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'ENOTSUP' ||
    code === 'EOPNOTSUPP' ||
    code === 'EINVAL' ||
    code === 'ENOSYS'
  )
    return new WorkspaceTextCaptureError('unavailable');
  return new WorkspaceTextCaptureError('io');
}

function objectIdentity(metadata: BigIntStats): string {
  try {
    return workspaceObjectIdentity(metadata);
  } catch {
    throw new WorkspaceTextCaptureError('unavailable');
  }
}

function assertRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.nlink !== 1n)
    throw new WorkspaceTextCaptureError('unsafe-file');
}

function sameMetadata(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.birthtimeNs === after.birthtimeNs &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs &&
    before.nlink === after.nlink
  );
}

async function rootEvidence(root: string, signal: AbortSignal): Promise<RootEvidence> {
  checkSignal(signal);
  const canonical = await realpath(root);
  checkSignal(signal);
  const metadata = await lstat(canonical, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new WorkspaceTextCaptureError('root-changed');
  let identity: string;
  try {
    identity = workspaceObjectIdentity(metadata);
  } catch {
    throw new WorkspaceTextCaptureError('root-changed');
  }
  checkSignal(signal);
  return { canonical, rootIdentity: fileContentDigest(`${canonical}\0${identity}`) };
}

async function requireRoot(
  root: string,
  expected: string | undefined,
  signal: AbortSignal,
): Promise<RootEvidence> {
  try {
    const current = await rootEvidence(root, signal);
    if (expected !== undefined && current.rootIdentity !== expected)
      throw new WorkspaceTextCaptureError('root-changed');
    return current;
  } catch (error) {
    const failure = mappedFailure(error, signal, expected !== undefined);
    if (expected !== undefined && failure.code === 'changed')
      throw new WorkspaceTextCaptureError('root-changed');
    if (expected === undefined && failure.code === 'root-changed')
      throw new WorkspaceTextCaptureError('unavailable');
    throw failure;
  }
}

async function inspectPath(
  workspace: WorkspacePolicy,
  root: RootEvidence,
  relativePath: string,
  signal: AbortSignal,
): Promise<PathEvidence> {
  const segments = relativePath.split('/');
  const candidate = workspace.resolve(relativePath, 'read');
  if (candidate.relativePath !== segments.join(path.sep))
    throw new WorkspaceTextCaptureError('invalid-path');
  const parents: { target: string; identity: string }[] = [];
  let target = root.canonical;
  for (let index = 0; index < segments.length; index++) {
    checkSignal(signal);
    target = path.join(target, segments[index]!);
    const metadata = await lstat(target, { bigint: true });
    checkSignal(signal);
    if (metadata.isSymbolicLink()) throw new WorkspaceTextCaptureError('unsafe-file');
    const identity = objectIdentity(metadata);
    if (index === segments.length - 1) {
      assertRegularFile(metadata);
      return { target, parents, metadata, identity };
    }
    if (!metadata.isDirectory()) throw new WorkspaceTextCaptureError('unavailable');
    parents.push({ target, identity });
  }
  throw new WorkspaceTextCaptureError('invalid-path');
}

async function checkPath(evidence: PathEvidence, signal: AbortSignal): Promise<void> {
  try {
    for (const parent of evidence.parents) {
      checkSignal(signal);
      const metadata = await lstat(parent.target, { bigint: true });
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        objectIdentity(metadata) !== parent.identity
      )
        throw new WorkspaceTextCaptureError('changed');
    }
    checkSignal(signal);
    const metadata = await lstat(evidence.target, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      !sameMetadata(evidence.metadata, metadata)
    )
      throw new WorkspaceTextCaptureError('changed');
    checkSignal(signal);
  } catch (error) {
    throw mappedFailure(error, signal, true);
  }
}

function captureOpenFlags(): number {
  if (
    !Number.isInteger(constants.O_NOFOLLOW) ||
    constants.O_NOFOLLOW <= 0 ||
    !Number.isInteger(constants.O_NONBLOCK) ||
    constants.O_NONBLOCK <= 0 ||
    (constants.O_NOFOLLOW & constants.O_NONBLOCK) !== 0
  )
    throw new WorkspaceTextCaptureError('unavailable');
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function decodeText(bytes: Buffer): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new WorkspaceTextCaptureError('invalid-utf8');
  }
  if (content.includes('\0')) throw new WorkspaceTextCaptureError('binary');
  if (!Buffer.from(content, 'utf8').equals(bytes))
    throw new WorkspaceTextCaptureError('invalid-utf8');
  return content;
}

interface CaptureOptions {
  readonly expectedRootDigest: string | undefined;
  readonly maxFileBytes: number;
  readonly maxBatchBytes: number;
  readonly signal: AbortSignal;
  readonly allowFileSkips: boolean;
}

async function readFileEvidence(
  file: PathEvidence,
  root: string,
  rootDigest: string,
  flags: number,
  relativePath: string,
  totalBytes: number,
  identities: ReadonlySet<string>,
  { signal, maxFileBytes, maxBatchBytes }: CaptureOptions,
): Promise<WorkspaceCapturedText> {
  if (file.metadata.size > BigInt(maxFileBytes)) throw new WorkspaceTextCaptureError('file-limit');
  let handle;
  try {
    checkSignal(signal);
    handle = await open(file.target, flags);
    checkSignal(signal);
    const metadata = await handle.stat({ bigint: true });
    assertRegularFile(metadata);
    const fileIdentity = objectIdentity(metadata);
    if (metadata.size > BigInt(maxFileBytes)) throw new WorkspaceTextCaptureError('file-limit');
    if (fileIdentity !== file.identity || !sameMetadata(file.metadata, metadata))
      throw new WorkspaceTextCaptureError('changed');
    if (identities.has(fileIdentity)) throw new WorkspaceTextCaptureError('unsafe-file');
    const bytes = Buffer.alloc(Math.min(maxFileBytes, maxBatchBytes - totalBytes) + 1);
    let count = 0;
    while (count < bytes.length) {
      checkSignal(signal);
      const result = await handle.read(bytes, count, bytes.length - count, count);
      checkSignal(signal);
      count += result.bytesRead;
      if (count > maxFileBytes) throw new WorkspaceTextCaptureError('file-limit');
      if (totalBytes + count > maxBatchBytes) throw new WorkspaceTextCaptureError('batch-limit');
      if (result.bytesRead === 0) break;
    }
    checkSignal(signal);
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameMetadata(metadata, after) || BigInt(count) !== metadata.size)
      throw new WorkspaceTextCaptureError('changed');
    await checkPath(file, signal);
    await requireRoot(root, rootDigest, signal);
    const contentBytes = bytes.subarray(0, count);
    return {
      path: relativePath,
      byteLength: count,
      sha256: fileContentDigest(contentBytes),
      content: decodeText(contentBytes),
      fileIdentity,
    };
  } catch (error) {
    throw mappedFailure(error, signal, true);
  } finally {
    await handle?.close();
  }
}

function maySkip(error: WorkspaceTextCaptureError, options: CaptureOptions): boolean {
  return (
    options.allowFileSkips &&
    error.code !== 'cancelled' &&
    error.code !== 'root-changed' &&
    error.code !== 'io'
  );
}

/**
 * Reads an ordered batch under the cooperative mutation queue. Rechecks detect
 * observed replacement. Node has no descriptor-relative beneath-root open.
 */
export async function captureWorkspaceText(
  root: string,
  paths: readonly string[],
  options: CaptureOptions,
): Promise<{ readonly rootIdentity: string; readonly entries: readonly WorkspaceCaptureEntry[] }> {
  const { signal, expectedRootDigest, maxFileBytes, maxBatchBytes } = options;
  checkSignal(signal);
  if (
    !Number.isSafeInteger(maxFileBytes) ||
    maxFileBytes <= 0 ||
    !Number.isSafeInteger(maxBatchBytes) ||
    maxBatchBytes < 0
  )
    throw new WorkspaceTextCaptureError('io');
  let workspace: WorkspacePolicy;
  try {
    workspace = createWorkspacePolicy({ root });
  } catch {
    throw new WorkspaceTextCaptureError('unavailable');
  }
  try {
    const flags = captureOpenFlags();
    const before = await requireRoot(workspace.root, expectedRootDigest, signal);
    return await withWorkspaceMutation(workspace.root, async () => {
      await requireRoot(workspace.root, before.rootIdentity, signal);
      const entries: WorkspaceCaptureEntry[] = [];
      const captured: {
        readonly evidence: PathEvidence;
        readonly path: string;
        readonly index: number;
      }[] = [];
      const identities = new Set<string>();
      let totalBytes = 0;
      for (const relativePath of paths) {
        try {
          checkSignal(signal);
          const evidence = await inspectPath(workspace, before, relativePath, signal);
          const file = await readFileEvidence(
            evidence,
            workspace.root,
            before.rootIdentity,
            flags,
            relativePath,
            totalBytes,
            identities,
            options,
          );
          captured.push({ evidence, path: relativePath, index: entries.length });
          entries.push({ file });
          identities.add(file.fileIdentity);
          totalBytes += file.byteLength;
        } catch (error) {
          const failure = mappedFailure(error, signal);
          if (!maySkip(failure, options)) throw failure;
          entries.push({ path: relativePath, error: failure });
        }
      }
      for (const { evidence, path, index } of captured) {
        try {
          await checkPath(evidence, signal);
        } catch (error) {
          const failure = mappedFailure(error, signal);
          if (!maySkip(failure, options)) throw failure;
          entries[index] = { path, error: failure };
        }
      }
      await requireRoot(workspace.root, before.rootIdentity, signal);
      checkSignal(signal);
      return { rootIdentity: before.rootIdentity, entries };
    });
  } catch (error) {
    throw mappedFailure(error, signal);
  }
}
