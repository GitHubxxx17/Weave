import {
  agentRunRequestSchema,
  agentRuntimeEventSchema,
  agentStreamErrorPayloadSchema,
  type AgentRunRequestInput,
  type AgentRuntimeEvent,
  type AgentStreamHandlers,
} from './agent-types.js';
import { readSseStream } from '../../lib/sse.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** Largest single frame (or unterminated buffer) accepted from the legacy Agent stream. */
const legacyMaxFrameChars = 8 * 1024 * 1024 + 65536;

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

/** Validates and maps a known SSE event, ignoring events added in the future. */
export function parseAgentEvent(eventName: string, dataText: string): AgentRuntimeEvent | null {
  if (eventName === 'error') {
    throw parseAgentStreamError(dataText);
  }

  const knownEventNames = new Set([
    'text-delta',
    'reasoning-delta',
    'tool-call',
    'tool-executing',
    'tool-result',
    'usage',
    'context',
    'plan',
    'completed',
  ]);
  if (!knownEventNames.has(eventName)) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(dataText) as unknown;
  } catch {
    throw new AgentStreamError('agent-stream-protocol', 'Agent stream data is invalid');
  }

  const parsed = agentRuntimeEventSchema.safeParse(payload);
  if (!parsed.success || parsed.data.type !== eventName) {
    throw new AgentStreamError('agent-stream-protocol', 'Agent stream event is invalid');
  }
  return parsed.data;
}

/** Opens one Agent turn and delivers validated events in wire order. */
export async function streamLegacyAgentRun(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: { readonly signal?: AbortSignal },
): Promise<void> {
  const validatedRequest = agentRunRequestSchema.parse(request);
  const fetchInit: RequestInit = {
    method: 'POST',
    headers: {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(validatedRequest),
  };
  if (options?.signal !== undefined) {
    fetchInit.signal = options.signal;
  }
  const response = await fetch(runtimeApiUrl('/agent/runs/stream'), fetchInit);

  if (!response.ok) {
    throw await createHttpError(response);
  }

  if (response.body === null) {
    throw new AgentStreamError('agent-stream-protocol', 'Agent stream has no response body');
  }

  const frames = readSseStream(response, {
    maxFrameChars: legacyMaxFrameChars,
    maxBufferChars: legacyMaxFrameChars,
    flushTrailingFrame: true,
    createError: () => new AgentStreamError('agent-stream-protocol', 'Agent stream is invalid'),
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  handlers.onAccepted?.();
  for await (const frame of frames) {
    const event = parseAgentEvent(frame.event, frame.data);
    if (event !== null) {
      handlers.onEvent(event);
      if (event.type === 'completed') return;
    }
  }
}

async function createHttpError(response: Response): Promise<AgentStreamError> {
  const fallback = new AgentStreamError(`http-${response.status}`, 'Agent request failed');

  try {
    const payload: unknown = await response.json();
    const parsed = agentStreamErrorPayloadSchema.safeParse(payload);
    if (parsed.success) {
      return new AgentStreamError(parsed.data.error.code, parsed.data.error.message);
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function parseAgentStreamError(dataText: string): AgentStreamError {
  try {
    const payload: unknown = JSON.parse(dataText);
    const parsed = agentStreamErrorPayloadSchema.safeParse(payload);
    if (parsed.success) {
      return new AgentStreamError(parsed.data.error.code, parsed.data.error.message);
    }
  } catch {
    // Convert malformed server data into a safe protocol error below.
  }

  return new AgentStreamError('agent-stream-protocol', 'Agent stream error is invalid');
}
