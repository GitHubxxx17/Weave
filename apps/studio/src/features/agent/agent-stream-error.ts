/** A safe, typed failure surfaced by the browser-side Agent stream client. */
export class AgentStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'AgentStreamError';
    this.code = code;
  }
}

export { parseSseFrame } from '../../lib/sse.js';
