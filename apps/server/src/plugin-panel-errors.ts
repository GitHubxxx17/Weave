import type { PanelErrorCode, PanelErrorBody } from './plugin-panel-types.js';
const statuses = {
  'panel-invalid-input': 400,
  'session-invalid-input': 400,
  'panel-request-forbidden': 403,
  'panel-not-found': 404,
  'session-not-found': 404,
  'panel-stale': 409,
  'session-archived': 409,
  'session-deleted': 410,
  'panel-request-too-large': 413,
  'panel-prompt-too-large': 413,
  'panel-data-too-large': 413,
  'panel-unavailable': 503,
  'panel-busy': 503,
  'panel-store-unavailable': 503,
  'panel-session-invalid': 503,
} as const;
const messages: Record<PanelErrorCode, string> = {
  'panel-invalid-input': 'Panel input is invalid',
  'session-invalid-input': 'Session input is invalid',
  'panel-request-forbidden': 'Panel request requires a trusted local origin and Host',
  'panel-not-found': 'Panel form was not found',
  'session-not-found': 'Session was not found',
  'panel-stale': 'Panel reference is no longer current',
  'session-archived': 'Archived Sessions cannot prepare commands',
  'session-deleted': 'Session was deleted',
  'panel-request-too-large': 'Panel request exceeds the size limit',
  'panel-prompt-too-large': 'Prepared prompt exceeds the size limit',
  'panel-data-too-large': 'Panel data exceeds the size limit',
  'panel-unavailable': 'Panel is unavailable',
  'panel-busy': 'Panel service is busy',
  'panel-store-unavailable': 'Session store is unavailable',
  'panel-session-invalid': 'Session event prefix is invalid',
};
export class PanelError extends Error {
  readonly status;
  constructor(readonly code: PanelErrorCode) {
    super(messages[code]);
    this.name = 'PanelError';
    this.status = statuses[code];
  }
}
export function panelErrorBody(error: unknown): {
  body: PanelErrorBody;
  status: 400 | 403 | 404 | 409 | 410 | 413 | 503;
} {
  const safe = error instanceof PanelError ? error : new PanelError('panel-unavailable');
  return { body: { error: { code: safe.code, message: safe.message } }, status: safe.status };
}
