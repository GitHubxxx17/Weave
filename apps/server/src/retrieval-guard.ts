import type { Hono } from 'hono';
import { registerAgentExecutionGuards } from './agent-execution-guard.js';

export const retrievalPath = '/projects/:projectId/retrieval';

export function registerRetrievalGuard(
  app: Hono,
  studioOrigin?: string,
  trustedHost?: string,
): void {
  registerAgentExecutionGuards(
    app,
    studioOrigin,
    [retrievalPath, `${retrievalPath}/*`],
    {
      forbidden: {
        code: 'retrieval-scope-forbidden',
        message: 'Retrieval requires a trusted local Host and Origin',
      },
      contentType: {
        code: 'retrieval-invalid-input',
        message: 'Retrieval requires application/json',
      },
    },
    trustedHost,
  );
}
