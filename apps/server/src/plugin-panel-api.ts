import type { Hono } from 'hono';
import type { PanelService } from './plugin-panel-types.js';
import {
  panelSessionIdSchema,
  panelTokenSchema,
  prepareRequestSchema,
} from './plugin-panel-types.js';
import { PanelError, panelErrorBody } from './plugin-panel-errors.js';
import { panelRequestGuard, readPanelRequest } from './plugin-panel-request-guard.js';
export interface PanelAppOptions {
  readonly panelService?: PanelService;
  readonly studioOrigin?: string;
  readonly trustedHost?: string;
}
/** Register guards before global CORS, whose OPTIONS short circuit would bypass them. */
export function registerPanelGuards(app: Hono, options: PanelAppOptions) {
  for (const path of [
    '/plugins/panels',
    '/plugins/panels/*',
    '/sessions/:sessionId/plugin-panels',
    '/sessions/:sessionId/plugin-panels/*',
  ])
    app.use(path, panelRequestGuard(options.studioOrigin, options.trustedHost));
}
export function registerPanelRoutes(app: Hono, options: PanelAppOptions) {
  const service = () => {
    if (!options.panelService) throw new PanelError('panel-unavailable');
    return options.panelService;
  };
  const params = (sessionId: string, panelRef: string) => {
    if (!panelSessionIdSchema.safeParse(sessionId).success)
      throw new PanelError('session-invalid-input');
    if (!panelTokenSchema.safeParse(panelRef).success) throw new PanelError('panel-invalid-input');
  };
  app.get('/plugins/panels', (context) => {
    try {
      return context.json(service().catalog());
    } catch (error) {
      const { body, status } = panelErrorBody(error);
      return context.json(body, status);
    }
  });
  app.get('/sessions/:sessionId/plugin-panels/:panelRef', async (context) => {
    try {
      const { sessionId, panelRef } = context.req.param();
      params(sessionId, panelRef);
      return context.json(
        await service().read(sessionId, panelRef, { signal: context.req.raw.signal }),
      );
    } catch (error) {
      const { body, status } = panelErrorBody(error);
      return context.json(body, status);
    }
  });
  app.post('/sessions/:sessionId/plugin-panels/:panelRef/prepare-command', async (context) => {
    try {
      const { sessionId, panelRef } = context.req.param();
      params(sessionId, panelRef);
      const parsed = prepareRequestSchema.safeParse(await readPanelRequest(context.req.raw));
      if (!parsed.success) throw new PanelError('panel-invalid-input');
      return context.json(
        await service().prepare(sessionId, panelRef, parsed.data, {
          signal: context.req.raw.signal,
        }),
      );
    } catch (error) {
      const { body, status } = panelErrorBody(error);
      return context.json(body, status);
    }
  });
}
