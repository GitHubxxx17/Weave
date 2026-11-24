import {
  retrievalBuildInputSchema,
  retrievalCancelInputSchema,
  retrievalLimits,
  retrievalPageInputSchema,
  retrievalPrepareInputSchema,
  retrievalPreviewTextInputSchema,
  retrievalQueryInputSchema,
  retrievalSourceInputSchema,
  type RetrievalErrorCode,
} from '@weave/protocol';
import {
  RetrievalError,
  describeRetrievalQueryBatch,
  isRetrievalError,
  issueLocalRetrievalPermit,
  revokeRetrievalPermit,
  type EmbeddingClientPort,
  type RetrievalEgressPermit,
  type RetrievalService,
} from '@weave/runtime';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';
import { ExecutionHttpError, readExecutionJson } from './agent-execution-guard.js';
import { retrievalPath } from './retrieval-guard.js';

export interface RetrievalRouteOptions {
  readonly service?: RetrievalService | undefined;
  readonly embedding?: EmbeddingClientPort | undefined;
}

const uuid = z.uuid();
const noQuery = z.strictObject({});
const statusByCode = {
  'retrieval-invalid-input': 400,
  'retrieval-unavailable': 503,
  'retrieval-not-found': 404,
  'retrieval-scope-forbidden': 403,
  'retrieval-project-ambiguous': 403,
  'retrieval-root-changed': 409,
  'retrieval-stale-preview': 409,
  'retrieval-stale-source': 409,
  'retrieval-invalid-cursor': 400,
  'retrieval-stale-cursor': 409,
  'retrieval-request-conflict': 409,
  'retrieval-limit': 413,
  'retrieval-busy': 409,
  'retrieval-cancelled': 409,
  'retrieval-timeout': 504,
  'retrieval-semantic-unavailable': 503,
  'retrieval-embedding-failed': 502,
  'retrieval-persistence-error': 503,
  'retrieval-persistence-uncertain': 503,
} satisfies Record<RetrievalErrorCode, ContentfulStatusCode>;

function query(context: Context): Record<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of new URL(context.req.url).searchParams) {
    if (values.has(key) || key === '__proto__') throw new RetrievalError('retrieval-invalid-input');
    values.set(key, value);
  }
  return Object.fromEntries(values);
}

function safeError(error: unknown): RetrievalError {
  if (isRetrievalError(error)) return error;
  if (error instanceof ExecutionHttpError)
    return new RetrievalError(error.status === 413 ? 'retrieval-limit' : 'retrieval-invalid-input');
  return new RetrievalError(
    error instanceof z.ZodError ? 'retrieval-invalid-input' : 'retrieval-persistence-error',
  );
}

function failure(context: Context, error: unknown): Response {
  const { code, message } = safeError(error);
  return context.json({ error: { code, message } }, statusByCode[code]);
}

async function withPermit<T>(
  binding: Parameters<typeof issueLocalRetrievalPermit>[0] | undefined,
  operation: (permit: RetrievalEgressPermit | undefined) => Promise<T>,
): Promise<T> {
  const permit = binding === undefined ? undefined : issueLocalRetrievalPermit(binding);
  try {
    return await operation(permit);
  } finally {
    if (permit !== undefined) revokeRetrievalPermit(permit);
  }
}

export function registerRetrievalRoutes(app: Hono, options: RetrievalRouteOptions): void {
  const handle =
    (
      operation: (
        context: Context,
        local: RetrievalService['local'],
        projectId: string,
        signal: AbortSignal,
      ) => unknown,
      paged = false,
    ) =>
    async (context: Context) => {
      try {
        const projectId = uuid.parse(context.req.param('projectId'));
        if (!paged) noQuery.parse(query(context));
        const { service } = options;
        if (service === undefined) throw new RetrievalError('retrieval-unavailable');
        const data = await operation(context, service.local, projectId, context.req.raw.signal);
        const body = JSON.stringify(data);
        if (Buffer.byteLength(body) > retrievalLimits.maxResponseBytes)
          throw new RetrievalError('retrieval-limit');
        return context.body(body, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
      } catch (error) {
        return failure(context, error);
      }
    };
  const read = (context: Context) => readExecutionJson(context.req.raw, 16_384);
  const page = (context: Context) => {
    const { cursor } = retrievalPageInputSchema.parse(query(context));
    return cursor === undefined ? {} : { cursor };
  };
  app.get(
    `${retrievalPath}/capabilities`,
    handle((_context, local) => local.capabilities()),
  );
  app.post(
    `${retrievalPath}/preview`,
    handle(async (context, local, id, signal) =>
      local.prepare(id, retrievalPrepareInputSchema.parse(await read(context)), signal),
    ),
  );
  app.get(
    `${retrievalPath}/preview/:id`,
    handle(
      (context, local, id, signal) =>
        local.preview(id, uuid.parse(context.req.param('id')), page(context), signal),
      true,
    ),
  );
  app.post(
    `${retrievalPath}/preview/text`,
    handle(async (context, local, id, signal) =>
      local.previewText(id, retrievalPreviewTextInputSchema.parse(await read(context)), signal),
    ),
  );
  app.post(
    `${retrievalPath}/builds`,
    handle(async (context, local, projectId, signal) => {
      const input = retrievalBuildInputSchema.parse(await read(context));
      return withPermit(
        input.mode === 'hybrid'
          ? {
              operation: 'build',
              projectId,
              requestId: input.requestId,
              digest: input.manifestDigest,
            }
          : undefined,
        (permit) => local.build(projectId, input, permit, signal),
      );
    }),
  );
  app.get(
    `${retrievalPath}/builds`,
    handle((context, local, id, signal) => local.jobs(id, page(context), signal), true),
  );
  app.get(
    `${retrievalPath}/builds/:jobId`,
    handle((context, local, id, signal) =>
      local.job(id, uuid.parse(context.req.param('jobId')), signal),
    ),
  );
  app.post(
    `${retrievalPath}/cancel`,
    handle(async (context, local, id, signal) => {
      const { jobId } = retrievalCancelInputSchema.parse(await read(context));
      return local.cancel(id, jobId, signal);
    }),
  );
  app.get(
    `${retrievalPath}/status`,
    handle((_context, local, id, signal) => local.status(id, signal)),
  );
  app.post(
    `${retrievalPath}/query`,
    handle(async (context, local, projectId, signal) => {
      const input = retrievalQueryInputSchema.parse(await read(context));
      if (input.mode === 'lexical') return local.query(projectId, input, undefined, signal);
      if (options.embedding === undefined)
        throw new RetrievalError('retrieval-semantic-unavailable');
      const { description } = describeRetrievalQueryBatch(options.embedding, input.intent.query);
      return withPermit(
        {
          operation: 'query',
          projectId,
          requestId: input.requestId,
          digest: description.requestBodyDigest,
          batch: description,
        },
        (permit) => local.query(projectId, input, permit, signal),
      );
    }),
  );
  app.post(
    `${retrievalPath}/source`,
    handle(async (context, local, id, signal) =>
      local.source(id, retrievalSourceInputSchema.parse(await read(context)), signal),
    ),
  );
}
