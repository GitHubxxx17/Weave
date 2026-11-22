import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileReferencesSchema, type FileReference } from '@weave/protocol';
import type { CapturedFileContext } from '@weave/session';
import { AgentExecutionError, type AgentExecutionErrorCode } from './agent-execution-types.js';
import {
  fileContentDigest,
  withWorkspaceMutation,
  workspaceObjectIdentity,
} from './workspace-mutation.js';
import { createWorkspacePolicy, type WorkspacePolicy } from './workspace-policy.js';

const maxFileBytes = 65_536;
const maxBatchBytes = 262_144;

interface RootEvidence {
  readonly canonical: string;
  readonly objectIdentity: string;
  readonly rootIdentity: string;
}

interface PathEvidence {
  readonly target: string;
  readonly parents: readonly { readonly target: string; readonly identity: string }[];
  readonly metadata: BigIntStats;
  readonly identity: string;
}

function failure(code: AgentExecutionErrorCode): AgentExecutionError {
  const messages: Partial<Record<AgentExecutionErrorCode, string>> = {
    'execution-invalid-input': 'File references are invalid',
    'execution-file-too-large': 'Referenced files exceed the capture size limit',
    'execution-file-unavailable': 'A referenced file is not available for capture',
    'execution-file-invalid-utf8': 'A referenced file is not valid UTF-8 text',
    'execution-file-changed': 'A referenced file or workspace changed during capture',
    'execution-file-capture-timeout': 'File capture was cancelled before acceptance',
    'execution-file-capture-failed': 'File capture failed',
  };
  return new AgentExecutionError(code, messages[code] ?? 'File capture failed');
}

function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw failure('execution-file-capture-timeout');
}

function nodeCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function mappedFailure(error: unknown, signal: AbortSignal, observed = false): AgentExecutionError {
  if (signal.aborted) return failure('execution-file-capture-timeout');
  if (error instanceof AgentExecutionError) return error;
  const code = nodeCode(error);
  if (observed && ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(code ?? ''))
    return failure('execution-file-changed');
  if (
    [
      'ENOENT',
      'ENOTDIR',
      'ELOOP',
      'EACCES',
      'EPERM',
      'ENOTSUP',
      'EOPNOTSUPP',
      'EINVAL',
      'ENOSYS',
    ].includes(code ?? '')
  )
    return failure('execution-file-unavailable');
  return failure('execution-file-capture-failed');
}

function objectIdentity(metadata: BigIntStats): string {
  try {
    return workspaceObjectIdentity(metadata);
  } catch {
    throw failure('execution-file-unavailable');
  }
}

function assertRegularFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.nlink !== 1n) throw failure('execution-file-unavailable');
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
    throw failure('execution-file-unavailable');
  const identity = objectIdentity(metadata);
  checkSignal(signal);
  return {
    canonical,
    objectIdentity: identity,
    rootIdentity: fileContentDigest(`${canonical}\0${identity}`),
  };
}

async function checkRoot(root: string, before: RootEvidence, signal: AbortSignal): Promise<void> {
  let after: RootEvidence;
  try {
    after = await rootEvidence(root, signal);
  } catch (error) {
    if (error instanceof AgentExecutionError && error.code === 'execution-file-unavailable')
      throw failure('execution-file-changed');
    throw mappedFailure(error, signal, true);
  }
  if (after.canonical !== before.canonical || after.objectIdentity !== before.objectIdentity)
    throw failure('execution-file-changed');
}

async function inspectPath(
  workspace: WorkspacePolicy,
  root: RootEvidence,
  reference: FileReference,
  signal: AbortSignal,
): Promise<PathEvidence> {
  const candidate = workspace.resolve(reference.path, 'read');
  // Recheck lexical confinement even though Protocol rejects noncanonical refs.
  if (candidate.relativePath !== reference.path.split('/').join(path.sep))
    throw failure('execution-invalid-input');
  const segments = reference.path.split('/');
  const parents: { target: string; identity: string }[] = [];
  let target = root.canonical;
  for (let index = 0; index < segments.length; index++) {
    checkSignal(signal);
    target = path.join(target, segments[index]!);
    const metadata = await lstat(target, { bigint: true });
    checkSignal(signal);
    if (metadata.isSymbolicLink()) throw failure('execution-file-unavailable');
    const identity = objectIdentity(metadata);
    if (index < segments.length - 1) {
      if (!metadata.isDirectory()) throw failure('execution-file-unavailable');
      parents.push({ target, identity });
    } else {
      assertRegularFile(metadata);
      return { target, parents, metadata, identity };
    }
  }
  throw failure('execution-invalid-input');
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
        throw failure('execution-file-changed');
    }
    checkSignal(signal);
    const metadata = await lstat(evidence.target, { bigint: true });
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.nlink !== 1n ||
      !sameMetadata(evidence.metadata, metadata)
    )
      throw failure('execution-file-changed');
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
    throw failure('execution-file-unavailable');
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function decodeText(bytes: Buffer): string {
  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw failure('execution-file-invalid-utf8');
  }
  if (content.includes('\0') || !Buffer.from(content, 'utf8').equals(bytes))
    throw failure('execution-file-invalid-utf8');
  return content;
}

/**
 * Captures explicit UTF-8 files under the cooperative workspace mutation queue.
 * Path checks detect observed replacement; Node lacks a descriptor-relative
 * beneath-root primitive protecting against all external parent-path races.
 */
export async function captureWorkspaceFiles(
  root: string,
  files: readonly FileReference[],
  options: { readonly signal: AbortSignal },
): Promise<Omit<CapturedFileContext, 'projectId'>> {
  const references = fileReferencesSchema.safeParse(files);
  if (!references.success) throw failure('execution-invalid-input');
  const signal = options.signal;
  checkSignal(signal);
  let workspace: WorkspacePolicy;
  try {
    workspace = createWorkspacePolicy({ root });
  } catch {
    throw failure('execution-file-unavailable');
  }
  try {
    const flags = captureOpenFlags();
    const before = await rootEvidence(workspace.root, signal);
    return await withWorkspaceMutation(workspace.root, async () => {
      checkSignal(signal);
      await checkRoot(workspace.root, before, signal);
      const captured: CapturedFileContext['files'][number][] = [];
      const evidence: PathEvidence[] = [];
      const identities = new Set<string>();
      let totalBytes = 0;
      for (const reference of references.data) {
        checkSignal(signal);
        const file = await inspectPath(workspace, before, reference, signal);
        if (file.metadata.size > BigInt(maxFileBytes)) throw failure('execution-file-too-large');
        let handle;
        try {
          checkSignal(signal);
          handle = await open(file.target, flags);
          checkSignal(signal);
          const metadata = await handle.stat({ bigint: true });
          assertRegularFile(metadata);
          const fileIdentity = objectIdentity(metadata);
          if (metadata.size > BigInt(maxFileBytes)) throw failure('execution-file-too-large');
          if (fileIdentity !== file.identity || !sameMetadata(file.metadata, metadata))
            throw failure('execution-file-changed');
          if (identities.has(fileIdentity)) throw failure('execution-file-unavailable');
          const bytes = Buffer.alloc(maxFileBytes + 1);
          let count = 0;
          while (count < bytes.byteLength) {
            checkSignal(signal);
            const result = await handle.read(bytes, count, bytes.byteLength - count, count);
            checkSignal(signal);
            count += result.bytesRead;
            if (count > maxFileBytes || totalBytes + count > maxBatchBytes)
              throw failure('execution-file-too-large');
            if (result.bytesRead === 0) break;
          }
          checkSignal(signal);
          const after = await handle.stat({ bigint: true });
          if (!after.isFile() || !sameMetadata(metadata, after) || BigInt(count) !== metadata.size)
            throw failure('execution-file-changed');
          await checkPath(file, signal);
          await checkRoot(workspace.root, before, signal);
          const contentBytes = bytes.subarray(0, count);
          const content = decodeText(contentBytes);
          captured.push({
            path: reference.path,
            encoding: 'utf-8',
            byteLength: count,
            sha256: fileContentDigest(contentBytes),
            content,
            fileIdentity,
          });
          identities.add(fileIdentity);
          evidence.push(file);
          totalBytes += count;
        } catch (error) {
          throw mappedFailure(error, signal, true);
        } finally {
          await handle?.close();
        }
      }
      for (const file of evidence) await checkPath(file, signal);
      await checkRoot(workspace.root, before, signal);
      checkSignal(signal);
      return { version: 1, rootIdentity: before.rootIdentity, files: captured };
    });
  } catch (error) {
    throw mappedFailure(error, signal);
  }
}
