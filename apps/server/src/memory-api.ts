import type { Context, Hono } from 'hono';
import type { MemoryService } from '@weave/runtime';
import type { ProjectStore } from '@weave/workspace';
import {
  memoryAccessLevelSchema,
  memoryDigestSchema,
  memoryErrorCodeSchema,
  memoryIdSchema,
  memoryQuerySchema,
  memoryRecordInputSchema,
  memoryRefSchema,
  memoryRevisionSchema,
  memoryScopeSchema,
  type MemoryScope,
} from '@weave/protocol';
import { z } from 'zod';
import { ExecutionHttpError, readExecutionJson } from './agent-execution-guard.js';

export interface MemoryAppOptions {
  readonly memoryService?: MemoryService | undefined;
  readonly projectStore?: ProjectStore | undefined;
}
const scopeQuery = z.discriminatedUnion('scope', [
  z.strictObject({ scope: z.literal('user') }),
  z.strictObject({ scope: z.literal('project'), projectId: memoryIdSchema }),
]);
const cursor = z.string().min(1).max(2048).optional();
const integer = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number);
const listQuery = z.strictObject({
  query: z.string().optional(),
  tag: z.string().optional(),
  cursor,
  limit: integer.pipe(z.number().int().min(1).max(50)).optional(),
  includeAgentAuthored: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
const historyQuery = z.strictObject({
  limit: integer.pipe(z.number().int().min(1).max(20)).optional(),
  cursor,
});
const exactQuery = z
  .strictObject({
    revision: integer.pipe(memoryRevisionSchema).optional(),
    sha256: memoryDigestSchema.optional(),
  })
  .refine((value) => (value.revision === undefined) === (value.sha256 === undefined));
const accessInput = z.strictObject({
  scope: memoryScopeSchema,
  requestId: memoryIdSchema,
  level: memoryAccessLevelSchema,
  expectedSettingRevision: z.number().int().nonnegative().safe(),
});
const recordInput = z.discriminatedUnion('operation', [
  memoryRecordInputSchema.options[0].extend({ scope: memoryScopeSchema }).strict(),
  memoryRecordInputSchema.options[1].extend({ scope: memoryScopeSchema }).strict(),
]);
const reviewInput = z.strictObject({
  scope: memoryScopeSchema,
  requestId: memoryIdSchema,
  targetRef: memoryRefSchema,
});
const deleteInput = z.strictObject({
  scope: memoryScopeSchema,
  requestId: memoryIdSchema,
  expectedRevision: memoryRevisionSchema,
  reason: z.string().max(512).optional(),
});

function query(context: Context): { scope: MemoryScope; remaining: Record<string, string> } {
  const values = new Map<string, string>();
  for (const [key, value] of new URL(context.req.url).searchParams) {
    if (values.has(key) || key === '__proto__')
      throw new ExecutionHttpError(400, 'memory-invalid-input', 'Memory query is invalid');
    values.set(key, value);
  }
  const { scope, projectId, ...remaining } = Object.fromEntries(values);
  const parsed = scopeQuery.parse({ scope, ...(projectId === undefined ? {} : { projectId }) });
  return {
    scope:
      parsed.scope === 'user' ? { kind: 'user' } : { kind: 'project', projectId: parsed.projectId },
    remaining,
  };
}
function failure(context: Context, error: unknown): Response {
  if (error instanceof ExecutionHttpError)
    return context.json({ error: { code: error.code, message: error.message } }, error.status);
  if (error instanceof z.ZodError)
    return context.json(
      { error: { code: 'memory-invalid-input', message: 'Memory input is invalid' } },
      400,
    );
  const code = memoryErrorCodeSchema.safeParse(
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
  );
  const safeCode = code.success ? code.data : 'memory-persistence-error';
  const status =
    safeCode === 'memory-not-found'
      ? 404
      : ['memory-stale-revision', 'memory-stale-cursor', 'memory-request-conflict'].includes(
            safeCode,
          )
        ? 409
        : safeCode === 'memory-invalid-cursor'
          ? 400
          : [
                'memory-disabled',
                'memory-read-only',
                'memory-scope-forbidden',
                'memory-project-ambiguous',
              ].includes(safeCode)
            ? 403
            : safeCode === 'memory-limit'
              ? 413
              : 503;
  return context.json(
    {
      error: {
        code: safeCode,
        message:
          status === 409
            ? 'Memory changed. Reload the current version before retrying.'
            : status === 404
              ? 'Memory was not found in this scope.'
              : 'Memory request could not be completed.',
      },
    },
    status,
  );
}

/** Thin guarded local-user HTTP mapping; no Agent role can be selected by JSON. */
export function registerMemoryRoutes(app: Hono, options: MemoryAppOptions): void {
  const handle =
    (operation: (context: Context, service: MemoryService) => Promise<Response>) =>
    async (context: Context) => {
      if (options.memoryService === undefined)
        return failure(context, { code: 'memory-persistence-error' });
      try {
        return await operation(context, options.memoryService);
      } catch (error) {
        return failure(context, error);
      }
    };
  app.get(
    '/memory/scopes',
    handle(async (context, service) => {
      z.strictObject({}).parse(Object.fromEntries(new URL(context.req.url).searchParams));
      if (options.projectStore === undefined)
        return failure(context, { code: 'memory-persistence-error' });
      const projects = await options.projectStore.listProjects();
      const named = [
        ...projects.map((project) => ({
          scope: { kind: 'project' as const, projectId: project.id },
          name: project.name,
        })),
        { scope: { kind: 'user' as const }, name: '个人记忆' },
      ];
      const scopes = await Promise.all(
        named.map(async (item) => ({ ...item, access: await service.local.getAccess(item.scope) })),
      );
      const body = { scopes };
      if (Buffer.byteLength(JSON.stringify(body)) > 65536)
        return failure(context, { code: 'memory-limit' });
      return context.json(body);
    }),
  );
  app.get(
    '/memory/access',
    handle(async (context, service) => {
      const { scope, remaining } = query(context);
      z.strictObject({}).parse(remaining);
      return context.json({ access: await service.local.getAccess(scope) });
    }),
  );
  app.post(
    '/memory/access',
    handle(async (context, service) => {
      const { scope, ...input } = accessInput.parse(
        await readExecutionJson(context.req.raw, 65536),
      );
      return context.json({ receipt: await service.local.setAccess(scope, input) });
    }),
  );
  app.get(
    '/memory/records',
    handle(async (context, service) => {
      const { scope, remaining } = query(context);
      const input = memoryQuerySchema.parse(listQuery.parse(remaining));
      const page =
        input.query || input.tag
          ? await service.local.search(scope, input, context.req.raw.signal)
          : await service.local.list(scope, input);
      return context.json({
        records: page.entries,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
    }),
  );
  app.post(
    '/memory/records',
    handle(async (context, service) => {
      const { scope, ...raw } = recordInput.parse(await readExecutionJson(context.req.raw, 65536));
      const input = memoryRecordInputSchema.parse(raw);
      const receipt =
        input.operation === 'create'
          ? await service.local.create(memoryScopeSchema.parse(scope), input)
          : await service.local.revise(memoryScopeSchema.parse(scope), input);
      return context.json({ receipt }, input.operation === 'create' ? 201 : 200);
    }),
  );
  app.get(
    '/memory/records/:memoryId',
    handle(async (context, service) => {
      const { scope, remaining } = query(context);
      const memoryId = memoryIdSchema.parse(context.req.param('memoryId'));
      const input = exactQuery.parse(remaining);
      const ref =
        input.revision === undefined
          ? undefined
          : memoryRefSchema.parse({ scope, memoryId, ...input });
      return context.json({
        record: await service.local.read(scope, memoryId, ref === undefined ? {} : { ref }),
      });
    }),
  );
  app.get(
    '/memory/records/:memoryId/history',
    handle(async (context, service) => {
      const { scope, remaining } = query(context);
      return context.json(
        await service.local.history(
          scope,
          memoryIdSchema.parse(context.req.param('memoryId')),
          historyQuery.parse(remaining),
        ),
      );
    }),
  );
  app.post(
    '/memory/records/:memoryId/review',
    handle(async (context, service) => {
      const { scope, ...input } = reviewInput.parse(
        await readExecutionJson(context.req.raw, 65536),
      );
      if (input.targetRef.memoryId !== memoryIdSchema.parse(context.req.param('memoryId')))
        throw new ExecutionHttpError(
          400,
          'memory-invalid-input',
          'Review target does not match the record',
        );
      return context.json({ receipt: await service.local.review(scope, input) });
    }),
  );
  app.post(
    '/memory/records/:memoryId/delete',
    handle(async (context, service) => {
      const { scope, ...input } = deleteInput.parse(
        await readExecutionJson(context.req.raw, 65536),
      );
      return context.json({
        receipt: await service.local.remove(scope, {
          ...input,
          memoryId: memoryIdSchema.parse(context.req.param('memoryId')),
        }),
      });
    }),
  );
}
