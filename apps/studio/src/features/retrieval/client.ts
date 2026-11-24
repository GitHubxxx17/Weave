import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import * as dto from './types.js';

export class RetrievalApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'RetrievalApiError';
  }
}

function invalidResponse(): never {
  throw new RetrievalApiError('retrieval-api-protocol', 0);
}

function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RetrievalApiError('retrieval-invalid-input', 400);
  return parsed.data;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
  body?: unknown,
): Promise<T> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  if (encoded !== undefined && dto.utf8Length(encoded) > 16_384)
    throw new RetrievalApiError('retrieval-limit', 400);

  let response: Response;
  let raw: string;
  try {
    response = await fetch(runtimeApiUrl(path), {
      cache: 'no-store',
      ...(signal === undefined ? {} : { signal }),
      ...(encoded === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: encoded,
          }),
    });
    raw = await response.text();
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new RetrievalApiError('retrieval-api-network', 0);
  }
  if (dto.utf8Length(raw) > 24_576) return invalidResponse();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidResponse();
  }
  if (!response.ok) {
    const parsed = dto.error.safeParse(value);
    if (!parsed.success) return invalidResponse();
    throw new RetrievalApiError(parsed.data.error.code, response.status);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return invalidResponse();
  return parsed.data;
}

function page(path: string, cursor?: string): string {
  return cursor === undefined
    ? path
    : `${path}?${new URLSearchParams({ cursor: read(dto.cursor, cursor) })}`;
}

function sameValues(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((item) => right.has(item));
}

/** Request and response DTOs are validated before entering the page state. */
export function createRetrievalClient(rawProjectId: string) {
  const projectId = read(dto.id, rawProjectId);
  const root = `/projects/${encodeURIComponent(projectId)}/retrieval`;
  function ownProject(value: { projectId: string }): void {
    if (value.projectId !== projectId) invalidResponse();
  }
  function ownSource(value: dto.RetrievalSource): void {
    if (
      value.kind === 'memory' &&
      (value.ref.scope.kind !== 'project' || value.ref.scope.projectId !== projectId)
    )
      invalidResponse();
  }
  function ownJob(value: dto.RetrievalJob): void {
    ownProject(value.job.receipt.project);
    const terminal = value.job.terminal;
    if (
      terminal?.status === 'completed' &&
      (!dto.sameProject(terminal.generation.project, value.job.receipt.project) ||
        terminal.generation.jobId !== value.job.receipt.jobId ||
        terminal.generation.manifestDigest !== value.job.receipt.manifestDigest ||
        terminal.generation.mode !== value.job.mode)
    )
      invalidResponse();
  }
  return {
    capabilities: (signal?: AbortSignal) =>
      request(`${root}/capabilities`, dto.capabilities, signal),
    async status(signal?: AbortSignal) {
      const result = await request(`${root}/status`, dto.status, signal);
      ownProject(result.project);
      if (result.active) ownProject(result.active.project);
      if (result.previous) ownProject(result.previous.project);
      if (result.activeJob) ownJob(result.activeJob);
      return result;
    },
    async prepare(raw: dto.RetrievalPrepareInput, signal?: AbortSignal) {
      const input = read(dto.prepareInput, raw);
      if (
        input.intent.memoryRefs.some(
          (ref) => ref.scope.kind !== 'project' || ref.scope.projectId !== projectId,
        )
      )
        throw new RetrievalApiError('retrieval-invalid-input', 400);
      const result = await request(`${root}/preview`, dto.preview, signal, input);
      ownProject(result.project);
      if (result.requestId !== input.requestId || result.mode !== input.intent.mode)
        invalidResponse();
      return result;
    },
    async previewPage(preview: dto.RetrievalPreview, cursor?: string, signal?: AbortSignal) {
      ownProject(preview.project);
      const result = await request(
        page(`${root}/preview/${read(dto.id, preview.previewId)}`, cursor),
        dto.previewPage,
        signal,
      );
      if (
        result.previewId !== preview.previewId ||
        result.manifestDigest !== preview.manifestDigest
      )
        invalidResponse();
      result.sources.forEach(({ source }) => ownSource(source));
      return result;
    },
    async previewText(
      preview: dto.RetrievalPreview,
      source: dto.RetrievalSource,
      cursor?: string,
      signal?: AbortSignal,
    ) {
      ownProject(preview.project);
      ownSource(source);
      const result = await request(`${root}/preview/text`, dto.textPage, signal, {
        previewId: preview.previewId,
        manifestDigest: preview.manifestDigest,
        sourceKey: source.sourceKey,
        ...(cursor === undefined ? {} : { cursor: read(dto.cursor, cursor) }),
      });
      if (!dto.sameSource(result.source, source) || (cursor === undefined && result.offset !== 0))
        invalidResponse();
      return result;
    },
    async build(raw: dto.RetrievalBuildInput, signal?: AbortSignal) {
      const input = read(dto.buildInput, raw);
      const result = await request(`${root}/builds`, dto.receipt, signal, input);
      ownProject(result.project);
      if (result.requestId !== input.requestId || result.manifestDigest !== input.manifestDigest)
        invalidResponse();
      return result;
    },
    async jobs(cursor?: string, signal?: AbortSignal) {
      const result = await request(page(`${root}/builds`, cursor), dto.jobs, signal);
      result.jobs.forEach(ownJob);
      return result;
    },
    async job(jobId: string, signal?: AbortSignal) {
      const result = await request(`${root}/builds/${read(dto.id, jobId)}`, dto.job, signal);
      ownJob(result);
      if (result.job.receipt.jobId !== jobId) invalidResponse();
      return result;
    },
    async cancel(jobId: string, signal?: AbortSignal) {
      const result = await request(`${root}/cancel`, dto.cancel, signal, {
        jobId: read(dto.id, jobId),
      });
      if (result.jobId !== jobId) invalidResponse();
      if (result.terminal?.status === 'completed') ownProject(result.terminal.generation.project);
      return result;
    },
    async query(raw: dto.RetrievalQueryInput, signal?: AbortSignal) {
      const input = read(dto.queryInput, raw);
      const result = await request(`${root}/query`, dto.queryResult, signal, input);
      ownProject(result.generation.project);
      if (
        result.requestId !== input.requestId ||
        result.actualMode !== input.mode ||
        result.hits.length > input.intent.limit ||
        !sameValues(result.filters.sources, input.intent.filters.sources) ||
        !sameValues(result.filters.paths.include, input.intent.filters.paths.include) ||
        !sameValues(result.filters.paths.exclude, input.intent.filters.paths.exclude)
      )
        invalidResponse();
      return result;
    },
    async source(citation: dto.RetrievalCitation, cursor?: string, signal?: AbortSignal) {
      const expected = read(dto.citation, citation);
      ownProject(expected.project);
      const result = await request(`${root}/source`, dto.sourceResult, signal, {
        citation: expected,
        ...(cursor === undefined ? {} : { cursor: read(dto.cursor, cursor) }),
      });
      const actual = result.citation;
      if (
        !dto.sameProject(actual.project, expected.project) ||
        actual.generationId !== expected.generationId ||
        !dto.sameSource(actual.source, expected.source) ||
        JSON.stringify(actual.chunk) !== JSON.stringify(expected.chunk)
      )
        invalidResponse();
      return result;
    },
  };
}
export type RetrievalClient = ReturnType<typeof createRetrievalClient>;

const errors: Record<string, string> = {
  'retrieval-api-network': '无法连接检索服务，请重试。',
  'retrieval-api-protocol': '本地服务返回了无效的检索数据。',
  'retrieval-invalid-input': '请检查查询长度、来源和相对路径。',
  'retrieval-root-changed': '项目文件夹已变更，请重新预览并构建索引。',
  'retrieval-stale-preview': '预览已失效，请重新生成预览。',
  'retrieval-stale-source': '来源已变更或不可用，请重新构建索引。',
  'retrieval-stale-cursor': '这页数据已失效，请重新打开。',
  'retrieval-request-conflict': '请求与原来的构建内容不一致，请重新生成预览。',
  'retrieval-unavailable': '此项目暂时没有可用的检索索引。',
  'retrieval-not-found': '找不到对应的构建或检索来源。',
  'retrieval-limit': '超过检索限制，请缩小范围后再试。',
  'retrieval-busy': '检索服务繁忙，请稍后重试。',
  'retrieval-cancelled': '操作已取消。',
  'retrieval-timeout': '检索超时，请重试。',
  'retrieval-semantic-unavailable': '当前无法使用语义搜索，可选择本地词法搜索。',
  'retrieval-embedding-failed': '向量服务请求失败。',
  'retrieval-persistence-uncertain': '暂时无法确认构建是否已接受，请重试同一构建。',
};
export function retrievalErrorMessage(error: unknown): string {
  return (error instanceof RetrievalApiError && errors[error.code]) || '检索操作失败，请重试。';
}
