import path from 'node:path';
import {
  compareRetrievalCodepoints,
  retrievalCapturedDocumentSchema,
  retrievalLimits,
  retrievalPathMatches,
  retrievalSourceIdentitySchema,
  type RetrievalCapturedDocument,
  type RetrievalErrorCode,
  type RetrievalSkip,
  type RetrievalSkipReason,
  type RetrievalSourceIdentity,
} from '@weave/protocol';
import { isRetrievalError, RetrievalError } from './retrieval-errors.js';
import type {
  RetrievalProjectEvidence,
  RetrievalWorkspaceCapture,
  RetrievalWorkspaceCapturePort,
} from './retrieval-types.js';
import { defaultIgnoredNames, listRetrievalWorkspaceFiles } from './workspace-file-index.js';
import {
  captureWorkspaceText,
  WorkspaceTextCaptureError,
  type WorkspaceCapturedText,
} from './workspace-text-capture.js';

type DescribedCapture = ReturnType<RetrievalWorkspaceCapturePort['describe']>;
type WorkspaceSource = Extract<RetrievalSourceIdentity, { kind: 'workspace' }>;
type WorkspaceSelection = Parameters<RetrievalWorkspaceCapturePort['capture']>[0]['selection'];

interface CaptureState extends DescribedCapture {
  readonly project: RetrievalProjectEvidence;
  readonly rootDigest: string;
}

const captureBatchFiles = 16;

// weave.discovery.v1
const excludedSegments = new Set([
  ...defaultIgnoredNames,
  '.aws',
  '.azure',
  '.docker',
  '.gnupg',
  '.kube',
  '.ssh',
  '.output',
  'vendor',
  '__macosx',
  '.pnpm-store',
  '.ds_store',
]);
const excludedNames = new Set([
  '.gitignore',
  '.gitmodules',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.yarnrc',
  '.yarnrc.yml',
  'authorized_keys',
  'known_hosts',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'credentials.yml',
  'credentials.yaml',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'composer.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'gemfile.lock',
  'pipfile.lock',
]);
const excludedExtensions = new Set([
  '.key',
  '.pem',
  '.crt',
  '.cer',
  '.der',
  '.pfx',
  '.p12',
  '.jks',
  '.keystore',
  '.pub',
  '.lock',
  '.exe',
  '.dll',
  '.dylib',
  '.so',
  '.o',
  '.a',
  '.wasm',
  '.class',
  '.jar',
  '.zip',
  '.tar',
  '.tgz',
  '.gz',
  '.7z',
  '.rar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.pdf',
  '.woff',
  '.woff2',
  '.mp3',
  '.mp4',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.bin',
]);

function excluded(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  const segments = lower.split('/');
  if (
    segments.some(
      (segment) =>
        excludedSegments.has(segment) || segment === '.env' || segment.startsWith('.env.'),
    )
  )
    return true;
  const name = segments.at(-1)!;
  return excludedNames.has(name) || excludedExtensions.has(path.posix.extname(name));
}

function cancellationError(signal: AbortSignal): RetrievalError | undefined {
  if (!signal.aborted) return undefined;
  const reason: unknown = signal.reason;
  if (isRetrievalError(reason)) return reason;
  return new RetrievalError(
    reason instanceof DOMException && reason.name === 'TimeoutError'
      ? 'retrieval-timeout'
      : 'retrieval-cancelled',
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  const error = cancellationError(signal);
  if (error !== undefined) throw error;
}

function captureError(
  error: unknown,
  signal: AbortSignal,
  stale?: RetrievalErrorCode,
): RetrievalError {
  error = cancellationError(signal) ?? error;
  if (isRetrievalError(error)) {
    if (stale !== undefined && error.code === 'retrieval-root-changed')
      return new RetrievalError(stale);
    return error;
  }
  if (error instanceof WorkspaceTextCaptureError) {
    if (stale !== undefined && error.code !== 'io') return new RetrievalError(stale);
    if (error.code === 'root-changed') return new RetrievalError('retrieval-root-changed');
  }
  return new RetrievalError('retrieval-unavailable');
}

function skipReason(error: WorkspaceTextCaptureError): RetrievalSkipReason {
  switch (error.code) {
    case 'file-limit':
      return 'too-large';
    case 'batch-limit':
      return 'capture-limit';
    case 'changed':
      return 'changed';
    case 'invalid-utf8':
      return 'invalid-utf8';
    case 'binary':
      return 'binary';
    case 'unsafe-file':
    case 'invalid-path':
      return 'unsafe-file';
    default:
      return 'unavailable';
  }
}

function capturedDocument(file: WorkspaceCapturedText): RetrievalCapturedDocument | undefined {
  const document = retrievalCapturedDocumentSchema.safeParse({
    source: {
      kind: 'workspace',
      sourceKey: `workspace:${file.path}`,
      path: file.path,
      sourceSha256: file.sha256,
      sourceBytes: file.byteLength,
      fileObjectDigest: file.fileIdentity,
    },
    title: [...path.posix.basename(file.path)].slice(0, 160).join(''),
    lexicalMetadata: { tags: [] },
    body: file.content,
    capturedAt: new Date().toISOString(),
  });
  if (!document.success) return undefined;
  Object.freeze(document.data.source);
  Object.freeze(document.data.lexicalMetadata.tags);
  Object.freeze(document.data.lexicalMetadata);
  return Object.freeze(document.data);
}

async function readBatch(
  project: RetrievalProjectEvidence,
  expectedRootDigest: string,
  paths: readonly string[],
  maxBatchBytes: number,
  signal: AbortSignal,
  allowFileSkips: boolean,
) {
  project.assertCurrentSync();
  const result = await captureWorkspaceText(project.workspaceRoot, paths, {
    expectedRootDigest,
    maxFileBytes: retrievalLimits.maxFileBytes,
    maxBatchBytes,
    signal,
    allowFileSkips,
  });
  project.assertCurrentSync();
  throwIfCancelled(signal);
  return result.entries;
}

function sameSource(file: WorkspaceCapturedText, source: WorkspaceSource): boolean {
  return (
    file.path === source.path &&
    file.fileIdentity === source.fileObjectDigest &&
    file.byteLength === source.sourceBytes &&
    file.sha256 === source.sourceSha256
  );
}

async function assembleCapture(
  project: RetrievalProjectEvidence,
  selection: WorkspaceSelection,
  signal: AbortSignal,
): Promise<CaptureState> {
  const rootDigest = project.project.rootDigest;
  const documents: RetrievalCapturedDocument[] = [];
  const details: RetrievalSkip[] = [];
  const omissions = new Map<RetrievalSkipReason, number>();
  let skippedFiles = 0;
  let skippedDetailsTruncated = false;

  function skip(reason: RetrievalSkipReason, relativePath?: string): void {
    skippedFiles++;
    omissions.set(reason, (omissions.get(reason) ?? 0) + 1);
    if (relativePath !== undefined && details.length < retrievalLimits.maxSkipDetails) {
      details.push(Object.freeze({ path: relativePath, reason }));
    } else {
      skippedDetailsTruncated = true;
    }
  }

  project.assertCurrentSync();
  throwIfCancelled(signal);
  const listing = selection.enabled
    ? await discoverBoundWorkspace(project, rootDigest, signal)
    : undefined;
  const candidates: { readonly path: string; readonly unsafe: boolean }[] = [];
  if (listing !== undefined) {
    project.assertCurrentSync();
    const selected =
      selection.selectedPaths === undefined ? undefined : new Set(selection.selectedPaths);
    const entries = [...listing.files].sort((left, right) =>
      compareRetrievalCodepoints(left.path ?? '', right.path ?? ''),
    );
    for (const entry of entries) {
      throwIfCancelled(signal);
      const relativePath = entry.path;
      if (relativePath === undefined) skip('unsafe-file');
      else if (entry.ignored === true || excluded(relativePath))
        skip('system-exclusion', relativePath);
      else if (
        !retrievalPathMatches(relativePath, selection.paths) ||
        (selected !== undefined && !selected.has(relativePath))
      )
        skip('not-selected', relativePath);
      else if (candidates.length >= retrievalLimits.maxFiles) skip('source-limit', relativePath);
      else candidates.push({ path: relativePath, unsafe: entry.unsafe === true });
    }

    let availableBytes = retrievalLimits.maxCaptureBytes;
    const identities = new Set<string>();
    // An empty batch also checks the bound root after discovery.
    for (let index = 0; index < Math.max(1, candidates.length); index += captureBatchFiles) {
      const paths: string[] = [];
      for (const candidate of candidates.slice(index, index + captureBatchFiles)) {
        if (candidate.unsafe) skip('unsafe-file', candidate.path);
        else paths.push(candidate.path);
      }
      const entries = await readBatch(project, rootDigest, paths, availableBytes, signal, true);
      for (const entry of entries) {
        if ('error' in entry) {
          skip(skipReason(entry.error), entry.path);
          continue;
        }
        const { file } = entry;
        if (identities.has(file.fileIdentity)) {
          skip('unsafe-file', file.path);
          continue;
        }
        if (file.byteLength === 0) {
          skip('empty', file.path);
          continue;
        }
        const document = capturedDocument(file);
        if (document === undefined) {
          skip('binary', file.path);
          continue;
        }
        availableBytes -= file.byteLength;
        identities.add(file.fileIdentity);
        documents.push(document);
      }
    }
  }

  const skipCounts = [...omissions].map(([reason, count]) => Object.freeze({ reason, count }));
  Object.freeze(skipCounts);
  return Object.freeze({
    project,
    rootDigest,
    documents: Object.freeze(documents),
    coverage: Object.freeze({
      discovery: listing?.source ?? 'memory-only',
      truncated: listing?.truncated ?? false,
      skippedDetailsTruncated,
      skipCounts,
    }),
    counts: Object.freeze({
      discoveredFiles: listing?.files.length ?? 0,
      selectedFiles: candidates.length,
      skippedFiles,
    }),
    skipped: Object.freeze(
      details.sort((left, right) => compareRetrievalCodepoints(left.path, right.path)),
    ),
  });
}

async function discoverBoundWorkspace(
  project: RetrievalProjectEvidence,
  rootDigest: string,
  signal: AbortSignal,
) {
  await readBatch(project, rootDigest, [], 0, signal, false);
  return listRetrievalWorkspaceFiles(project.workspaceRoot, signal);
}

export function createRetrievalWorkspaceCapture(): RetrievalWorkspaceCapturePort {
  const captures = new WeakMap<RetrievalWorkspaceCapture, CaptureState>();

  function get(handle: RetrievalWorkspaceCapture): CaptureState {
    const state = captures.get(handle);
    if (state === undefined) throw new RetrievalError('retrieval-stale-preview');
    return state;
  }

  return {
    async capture({ project, selection, signal: callerSignal }) {
      const signal = AbortSignal.any([callerSignal, project.signal]);
      try {
        const state = await assembleCapture(project, selection, signal);
        project.assertCurrentSync();
        throwIfCancelled(signal);
        const handle = Object.freeze({}) as RetrievalWorkspaceCapture;
        captures.set(handle, state);
        return handle;
      } catch (error) {
        throw captureError(error, signal);
      }
    },

    describe(handle) {
      const { documents, coverage, counts, skipped } = get(handle);
      return { documents, coverage, counts, skipped };
    },

    async verify(handle, callerSignal, retainedProject) {
      const state = get(handle);
      const { rootDigest, documents } = state;
      const project = retainedProject ?? state.project;
      if (
        project.project.projectId !== state.project.project.projectId ||
        project.project.folderRevision !== state.project.project.folderRevision ||
        project.project.rootDigest !== rootDigest
      )
        throw new RetrievalError('retrieval-stale-preview');
      const signal = AbortSignal.any([callerSignal, project.signal]);
      try {
        let available = retrievalLimits.maxCaptureBytes;
        const batches =
          state.coverage.discovery === 'memory-only' ? 0 : Math.max(1, documents.length);
        for (let index = 0; index < batches; index += captureBatchFiles) {
          const sources = documents.slice(index, index + captureBatchFiles).map(({ source }) => {
            if (source.kind !== 'workspace') throw new RetrievalError('retrieval-stale-preview');
            return source;
          });
          const entries = await readBatch(
            project,
            rootDigest,
            sources.map(({ path }) => path),
            available,
            signal,
            false,
          );
          for (const [position, entry] of entries.entries()) {
            if ('error' in entry) throw entry.error;
            if (!sameSource(entry.file, sources[position]!))
              throw new RetrievalError('retrieval-stale-preview');
            available -= entry.file.byteLength;
          }
        }
        get(handle);
        project.assertCurrentSync();
        throwIfCancelled(signal);
      } catch (error) {
        throw captureError(error, signal, 'retrieval-stale-preview');
      }
    },

    async readCurrent({ project, source: sourceInput, signal: callerSignal }) {
      const signal = AbortSignal.any([callerSignal, project.signal]);
      const parsed = retrievalSourceIdentitySchema.safeParse(sourceInput);
      if (!parsed.success || parsed.data.kind !== 'workspace' || excluded(parsed.data.path))
        throw new RetrievalError('retrieval-stale-source');
      const source = parsed.data;
      try {
        const [entry] = await readBatch(
          project,
          project.project.rootDigest,
          [source.path],
          retrievalLimits.maxFileBytes,
          signal,
          false,
        );
        if (entry === undefined) throw new RetrievalError('retrieval-stale-source');
        if ('error' in entry) throw entry.error;
        if (!sameSource(entry.file, source)) throw new RetrievalError('retrieval-stale-source');
        const document = capturedDocument(entry.file);
        if (document === undefined) throw new RetrievalError('retrieval-stale-source');
        return document;
      } catch (error) {
        throw captureError(error, signal, 'retrieval-stale-source');
      }
    },

    release(handle) {
      captures.delete(handle);
    },
  };
}
