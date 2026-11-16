import {
  agentRunRequestSchema,
  agentRuntimeEventSchema,
  agentStreamErrorPayloadSchema,
  type AgentRunRequestInput,
  type AgentRuntimeEvent,
  type AgentStreamHandlers,
} from './agent-types.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** A safe, typed failure surfaced by the browser-side Agent stream client. */
export class AgentStreamError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'AgentStreamError';
    this.code = code;
  }
}

/**
 * Parses one complete SSE frame. Data fields follow the SSE rule of joining
 * multiple lines with a newline; comments and unsupported fields are ignored.
 */
export function parseSseFrame(
  frame: string,
): { readonly event: string; readonly data: string } | null {
  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of frame.split(/\r\n|\n/)) {
    if (line === '' || line.startsWith(':')) {
      continue;
    }

    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    const value =
      separator === -1
        ? ''
        : line.slice(separator + 1).startsWith(' ')
          ? line.slice(separator + 2)
          : line.slice(separator + 1);

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (event === undefined || dataLines.length === 0) {
    return null;
  }

  return { event, data: dataLines.join('\n') };
}

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
export async function streamAgentRun(
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        buffer += decoder.decode();
        if (buffer.length > 0) {
          dispatchFrame(buffer, handlers);
        }
        return;
      }

      buffer += decoder.decode(result.value, { stream: true });
      let delimiterIndex = findFrameDelimiter(buffer);
      while (delimiterIndex !== -1) {
        const delimiterLength = buffer.startsWith('\r\n', delimiterIndex) ? 4 : 2;
        const frame = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + delimiterLength);
        if (dispatchFrame(frame, handlers)) {
          await cancelReader(reader);
          return;
        }
        delimiterIndex = findFrameDelimiter(buffer);
      }
    }
  } catch (error: unknown) {
    await cancelReader(reader);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function findFrameDelimiter(buffer: string): number {
  const lfIndex = buffer.indexOf('\n\n');
  const crlfIndex = buffer.indexOf('\r\n\r\n');
  if (lfIndex === -1) {
    return crlfIndex;
  }
  if (crlfIndex === -1) {
    return lfIndex;
  }
  return Math.min(lfIndex, crlfIndex);
}

function dispatchFrame(frame: string, handlers: AgentStreamHandlers): boolean {
  const parsedFrame = parseSseFrame(frame);
  if (parsedFrame === null) {
    return false;
  }

  const event = parseAgentEvent(parsedFrame.event, parsedFrame.data);
  if (event !== null) {
    handlers.onEvent(event);
    return event.type === 'completed';
  }
  return false;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Preserve the original stream or protocol error if cancellation fails.
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
