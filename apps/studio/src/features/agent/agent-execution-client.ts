import { z } from 'zod';
import { readSseStream, type SseFrame } from '../../lib/sse.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { AgentStreamError, executionLaunchUnreachableCode } from './agent-stream-error.js';
import {
  agentRunRequestSchema,
  agentStreamErrorPayloadSchema,
  type AgentRunRequestInput,
  type AgentStreamHandlers,
} from './agent-types.js';
import {
  agentExecutionInputSchema,
  agentExecutionSummarySchema,
  agentExecutionSnapshotSchema,
  agentExecutionEventFrameSchema,
  agentExecutionStatusFrameSchema,
  isTerminalExecution,
  type AgentExecutionSnapshot,
  type AgentExecutionSummary,
} from './agent-execution-types.js';

const maxFrameBytes = 8 * 1024 * 1024 + 65536;
type ObserveOptions = { readonly signal?: AbortSignal | undefined };
const pathFor = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}/executions`;
const executionPath = (sessionId: string, executionId: string): string =>
  `${pathFor(sessionId)}/${encodeURIComponent(executionId)}`;
function protocolError(): AgentStreamError {
  return new AgentStreamError('agent-stream-protocol', 'Execution response is invalid');
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Observation stopped', 'AbortError');
}

const defaultLaunchRetryWindowMs = 60_000;

/** Exponential backoff: `baseMs` doubling per attempt, capped at 5 seconds. */
export function executionRetryDelayMs(attempt: number, baseMs = 300): number {
  return Math.min(baseMs * 2 ** Math.min(attempt, 5), 5000);
}

/** Abortable backoff controls only the local observer, never the execution. */
export function waitForExecutionRetry(attempt: number, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, executionRetryDelayMs(attempt));
    const abort = (): void => {
      clearTimeout(timer);
      reject(new DOMException('Observation stopped', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function requestExecutionJson<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(runtimeApiUrl(path), init);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = agentStreamErrorPayloadSchema.safeParse(body);
    const error = new AgentStreamError(
      parsed.success ? parsed.data.error.code : `http-${response.status}`,
      parsed.success ? parsed.data.error.message : 'Execution request failed',
    );
    if (
      response.status >= 500 &&
      !(
        parsed.success &&
        [
          'execution-closed',
          'execution-persistence-error',
          'execution-file-capture-timeout',
          'execution-file-capture-failed',
          'execution-context-capture-failed',
        ].includes(parsed.data.error.code)
      )
    )
      throw new TypeError(error.message, { cause: error });
    throw error;
  }
  const data: unknown = await response.json().catch((error: unknown) => {
    if (error instanceof TypeError) throw error;
    throw protocolError();
  });
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw protocolError();
  return parsed.data;
}
const requestJson = requestExecutionJson;
function validateIdentity(
  snapshot: AgentExecutionSnapshot,
  sessionId: string,
  executionId?: string,
): void {
  if (
    snapshot.sessionId !== sessionId ||
    (executionId !== undefined && snapshot.executionId !== executionId) ||
    snapshot.cursor.split(':')[1] !== snapshot.executionId
  )
    throw protocolError();
}
export async function listAgentExecutions(
  sessionId: string,
): Promise<readonly AgentExecutionSummary[]> {
  const summaries = await requestJson(
    pathFor(sessionId),
    z.array(agentExecutionSummarySchema).max(100),
  );
  if (
    summaries.some(
      (entry) => entry.sessionId !== sessionId || entry.cursor.split(':')[1] !== entry.executionId,
    )
  )
    throw protocolError();
  return summaries;
}
export async function getAgentExecution(
  sessionId: string,
  executionId: string,
  signal?: AbortSignal,
): Promise<AgentExecutionSnapshot> {
  const snapshot = await requestJson(
    executionPath(sessionId, executionId),
    agentExecutionSnapshotSchema,
    signal === undefined ? undefined : { signal },
  );
  validateIdentity(snapshot, sessionId, executionId);
  return snapshot;
}
export async function cancelAgentExecution(
  sessionId: string,
  executionId: string,
): Promise<AgentExecutionSnapshot> {
  const snapshot = await requestJson(
    `${executionPath(sessionId, executionId)}/cancel`,
    agentExecutionSnapshotSchema,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    },
  );
  validateIdentity(snapshot, sessionId, executionId);
  return snapshot;
}

export async function launchAgentExecution(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: ObserveOptions & {
    readonly requestId?: string | undefined;
    /** How long to keep retrying an unconfirmed launch before giving up. */
    readonly retryWindowMs?: number | undefined;
  },
): Promise<AgentExecutionSnapshot> {
  const validated = agentRunRequestSchema.parse(request);
  const { sessionId, ...logicalInput } = validated;
  const input = agentExecutionInputSchema.parse({
    ...logicalInput,
    permissionMode: logicalInput.permissionMode ?? 'ask',
  });
  const requestId = z
    .string()
    .min(1)
    .max(240)
    .parse(options?.requestId ?? crypto.randomUUID());
  // Freeze the serialized logical request before any await: every ambiguous retry is identical.
  const body = JSON.stringify({ requestId, input });
  const launchRetryWindowMs = options?.retryWindowMs ?? defaultLaunchRetryWindowMs;
  const startedAt = Date.now();
  let attempt = 0;
  let snapshot: AgentExecutionSnapshot;
  while (true) {
    checkAbort(options?.signal);
    handlers.onConnection?.(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      snapshot = await requestJson(pathFor(sessionId), agentExecutionSnapshotSchema, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      validateIdentity(snapshot, sessionId);
      if (snapshot.requestId !== requestId) throw protocolError();
      break;
    } catch (error: unknown) {
      checkAbort(options?.signal);
      if (!(error instanceof TypeError)) throw error;
      // The request was never confirmed. Stop after the window so the caller can
      // keep the draft and offer an explicit retry with the same requestId.
      if (Date.now() - startedAt + executionRetryDelayMs(attempt) > launchRetryWindowMs)
        throw new AgentStreamError(
          executionLaunchUnreachableCode,
          '无法连接到本地 Server，消息未发送，草稿已保留',
          { cause: error },
        );
      await waitForExecutionRetry(attempt++, options?.signal);
    }
  }
  checkAbort(options?.signal);
  handlers.onReceipt?.(snapshot);
  handlers.onAccepted?.();
  return snapshot;
}

/** Explicit compatibility helper for callers that own both admission and observation. */
export async function launchAndObserveAgentExecution(
  request: AgentRunRequestInput,
  handlers: AgentStreamHandlers,
  options?: ObserveOptions & { readonly requestId?: string | undefined },
): Promise<void> {
  const snapshot = await launchAgentExecution(request, handlers, options);
  await observeAgentExecution(snapshot, handlers, options);
}

/** Attaches to a known execution. Reconnecting never invokes launch or cancel. */
export async function observeAgentExecution(
  initial: AgentExecutionSnapshot,
  handlers: AgentStreamHandlers,
  options?: ObserveOptions,
): Promise<void> {
  let snapshot = agentExecutionSnapshotSchema.parse(initial);
  validateIdentity(snapshot, snapshot.sessionId, snapshot.executionId);
  let cursor = snapshot.cursor;
  let terminal = isTerminalExecution(snapshot.status);
  handlers.onSnapshot?.(snapshot);
  if (terminal || snapshot.status === 'queued') return;
  let attempt = 0;
  const acceptCursor = (
    next: string,
    replacement = false,
    durableTerminalReset = false,
  ): boolean => {
    const [epoch, executionId, sequence] = next.split(':');
    const [currentEpoch, , currentSequence] = cursor.split(':');
    if (executionId !== snapshot.executionId) throw protocolError();
    if (epoch !== currentEpoch) {
      if (!replacement) throw protocolError();
    } else if (Number(sequence) <= Number(currentSequence) && !durableTerminalReset) return false;
    cursor = next;
    return true;
  };
  const dispatch = (frame: SseFrame): void => {
    if (!['snapshot', 'event', 'status'].includes(frame.event)) return;
    let payload: unknown;
    try {
      payload = JSON.parse(frame.data) as unknown;
    } catch {
      throw protocolError();
    }
    // Server frames may include their discriminant; SSE already carries it.
    if (typeof payload === 'object' && payload !== null && 'type' in payload) {
      if (payload.type !== frame.event) throw protocolError();
      if (frame.event === 'snapshot' && 'snapshot' in payload) payload = payload.snapshot;
      else {
        const { type: _, ...data } = payload;
        void _;
        payload = data;
      }
    }
    if (frame.event === 'snapshot') {
      const parsed = agentExecutionSnapshotSchema.safeParse(payload);
      if (!parsed.success) throw protocolError();
      validateIdentity(parsed.data, snapshot.sessionId, snapshot.executionId);
      if (
        parsed.data.turnId !== snapshot.turnId ||
        parsed.data.userMessageId !== snapshot.userMessageId ||
        parsed.data.requestId !== snapshot.requestId
      )
        throw protocolError();
      const confirmedTerminal = isTerminalExecution(parsed.data.status);
      if (
        confirmedTerminal &&
        (parsed.data.durableThroughSequence === undefined ||
          parsed.data.durableThroughSequence < (snapshot.durableThroughSequence ?? 0))
      )
        throw protocolError();
      // Evicted live executions reconstruct from durable facts at sequence zero,
      // even within the same Server epoch. Only a confirmed, output-free terminal
      // snapshot can end observation without advancing the live cursor.
      const durableTerminalReset =
        confirmedTerminal &&
        parsed.data.cursor.split(':')[2] === '0' &&
        parsed.data.events.length === 0;
      if (!acceptCursor(parsed.data.cursor, true, durableTerminalReset)) return;
      snapshot = parsed.data;
      handlers.onSnapshot?.(snapshot);
      terminal = isTerminalExecution(snapshot.status);
    } else if (frame.event === 'event') {
      const parsed = agentExecutionEventFrameSchema.safeParse(payload);
      if (!parsed.success) throw protocolError();
      if (acceptCursor(parsed.data.cursor)) handlers.onEvent(parsed.data.event);
    } else {
      const parsed = agentExecutionStatusFrameSchema.safeParse(payload);
      if (!parsed.success) throw protocolError();
      if (!acceptCursor(parsed.data.cursor)) return;
      handlers.onStatus?.(parsed.data);
      terminal = isTerminalExecution(parsed.data.status);
    }
  };
  while (!terminal) {
    checkAbort(options?.signal);
    handlers.onConnection?.(attempt === 0 ? 'connecting' : 'reconnecting');
    try {
      const response = await fetch(
        runtimeApiUrl(
          `${executionPath(snapshot.sessionId, snapshot.executionId)}/events?after=${encodeURIComponent(cursor)}`,
        ),
        {
          headers: { Accept: 'text/event-stream' },
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      checkAbort(options?.signal);
      if (!response.ok) {
        if (response.status < 500)
          throw new AgentStreamError(`http-${response.status}`, 'Execution observation failed');
        throw new TypeError('Execution observation unavailable');
      }
      checkAbort(options?.signal);
      const frames = readSseStream(response, {
        maxFrameChars: maxFrameBytes,
        maxBufferChars: maxFrameBytes,
        createError: protocolError,
        signal: options?.signal,
      });
      handlers.onConnection?.('connected');
      for await (const frame of frames) {
        dispatch(frame);
        if (terminal) break;
      }
    } catch (error: unknown) {
      checkAbort(options?.signal);
      if (!(error instanceof TypeError)) throw error;
    }
    if (!terminal) {
      handlers.onConnection?.('reconnecting');
      await waitForExecutionRetry(attempt++, options?.signal);
    }
  }
}
