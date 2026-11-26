import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { skillRefSchema } from '@weave/protocol';
import type { SkillCatalogService } from './skill-catalog.js';
import { SkillError } from './skill-errors.js';
import { managementWriteGuard } from './plugin-write-guard.js';
import { SessionServiceError, type SessionService } from './session-service.js';
export interface SkillAppOptions {
  readonly skillCatalogService?: SkillCatalogService | undefined;
  readonly sessionService?: SessionService | undefined;
  readonly studioOrigin?: string | undefined;
  readonly trustedHost?: string | undefined;
}
const previewSchema = z.strictObject({ skill: skillRefSchema });
function failure(context: Context, error: unknown): Response {
  let status: ContentfulStatusCode = 500;
  let code = 'server-internal-error';
  let message = 'Skill request failed';
  if (error instanceof SkillError) {
    code = error.code;
    message = error.message;
    status =
      code === 'skill-not-found'
        ? 404
        : code === 'skill-unavailable'
          ? 503
          : code === 'skill-catalog-stale' || code === 'skill-source-changed'
            ? 409
            : 400;
  } else if (error instanceof SessionServiceError) {
    code = error.code;
    message = error.message;
    status =
      code === 'session-not-found'
        ? 404
        : code === 'session-deleted'
          ? 410
          : code === 'session-projection-invalid'
            ? 422
            : 409;
  }
  return context.json({ error: { code, message } }, status);
}
/** Thin inert Skill adapters: no discovery, activation or Agent behavior in handlers. */
export function registerSkillRoutes(app: Hono, options: SkillAppOptions): void {
  app.use(
    '/sessions/:id/skills/*',
    managementWriteGuard(options.studioOrigin, options.trustedHost),
  );
  const available = async (sessionId: string): Promise<SkillCatalogService> => {
    if (options.skillCatalogService === undefined || options.sessionService === undefined)
      throw new SkillError('skill-unavailable', 'Skills are unavailable');
    await options.sessionService.assertRunnable(sessionId);
    return options.skillCatalogService;
  };
  app.get('/sessions/:id/skills', async (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      const service = await available(context.req.param('id'));
      return context.json(await service.catalog(context.req.param('id'), context.req.raw.signal));
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
  app.post('/sessions/:id/skills/preview', async (context) => {
    context.header('Cache-Control', 'no-store');
    try {
      if (Number(context.req.header('Content-Length') ?? 0) > 4096)
        throw new SkillError('skill-invalid-input', 'Skill preview request is too large');
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = context.req.raw.body?.getReader();
      if (reader !== undefined) {
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4096) {
              await reader.cancel().catch(() => undefined);
              throw new SkillError('skill-invalid-input', 'Skill preview request is too large');
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      } catch {
        throw new SkillError('skill-invalid-input', 'Skill preview request is invalid');
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new SkillError('skill-invalid-input', 'Skill preview request is invalid');
      }
      const parsed = previewSchema.safeParse(body);
      if (!parsed.success)
        throw new SkillError('skill-invalid-input', 'Skill preview request is invalid');
      const service = await available(context.req.param('id'));
      return context.json({
        schemaVersion: 1,
        ...(await service.preview(
          context.req.param('id'),
          parsed.data.skill,
          context.req.raw.signal,
        )),
      });
    } catch (error: unknown) {
      return failure(context, error);
    }
  });
}
