import { readSseStream } from '../../lib/sse.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { AgentStreamError } from './agent-legacy-stream.js';
import { requestExecutionJson, waitForExecutionRetry } from './agent-execution-client.js';
import {
  agentExecutionQueueSnapshotSchema,
  agentExecutionQueuedCancelSchema,
  agentExecutionQueueReorderSchema,
  type AgentExecutionQueueSnapshot,
  type AgentExecutionQueuedCancel,
  type AgentExecutionQueueReorder,
} from './agent-execution-types.js';
const pathFor = (sessionId: string): string =>
  `/sessions/${encodeURIComponent(sessionId)}/executions`;
function validateQueue(
  state: AgentExecutionQueueSnapshot,
  sessionId: string,
): AgentExecutionQueueSnapshot {
  const members = [state.active, ...state.queued].filter((entry) => entry !== null);
  if (
    state.sessionId !== sessionId ||
    state.cursor.split(':')[1] !== encodeURIComponent(sessionId) ||
    members.some(
      (entry) => entry.sessionId !== sessionId || entry.cursor.split(':')[1] !== entry.executionId,
    ) ||
    new Set(members.map((entry) => entry.executionId)).size !== members.length ||
    state.queued.some((entry) => entry.status !== 'queued') ||
    state.active?.status === 'queued' ||
    (state.active !== null &&
      ['completed', 'failed', 'cancelled', 'interrupted'].includes(state.active.status))
  )
    throw new AgentStreamError('agent-stream-protocol', 'Queue response is invalid');
  return state;
}
export async function getExecutionQueue(sessionId: string): Promise<AgentExecutionQueueSnapshot> {
  return validateQueue(
    await requestExecutionJson(`${pathFor(sessionId)}/queue`, agentExecutionQueueSnapshotSchema),
    sessionId,
  );
}
async function controlQueue(
  sessionId: string,
  path: string,
  request: AgentExecutionQueuedCancel | AgentExecutionQueueReorder,
  signal?: AbortSignal,
): Promise<AgentExecutionQueueSnapshot> {
  const body = JSON.stringify(request);
  let attempt = 0;
  while (true) {
    signal?.throwIfAborted();
    try {
      return validateQueue(
        await requestExecutionJson(path, agentExecutionQueueSnapshotSchema, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          ...(signal === undefined ? {} : { signal }),
        }),
        sessionId,
      );
    } catch (error: unknown) {
      if (!(error instanceof TypeError)) throw error;
      await waitForExecutionRetry(attempt++, signal);
    }
  }
}
export function cancelQueuedExecution(
  sessionId: string,
  executionId: string,
  request: AgentExecutionQueuedCancel,
  signal?: AbortSignal,
): Promise<AgentExecutionQueueSnapshot> {
  return controlQueue(
    sessionId,
    `${pathFor(sessionId)}/${encodeURIComponent(executionId)}/cancel-queued`,
    agentExecutionQueuedCancelSchema.parse(request),
    signal,
  );
}
export function reorderExecutionQueue(
  sessionId: string,
  request: AgentExecutionQueueReorder,
  signal?: AbortSignal,
): Promise<AgentExecutionQueueSnapshot> {
  return controlQueue(
    sessionId,
    `${pathFor(sessionId)}/queue/reorder`,
    agentExecutionQueueReorderSchema.parse(request),
    signal,
  );
}
/** Queue streams replace metadata, including across epochs; they never promote work. */
export async function observeExecutionQueue(
  sessionId: string,
  onSnapshot: (snapshot: AgentExecutionQueueSnapshot) => void,
  options?: {
    readonly signal?: AbortSignal | undefined;
    readonly onConnection?: ((state: 'connected' | 'reconnecting') => void) | undefined;
  },
): Promise<void> {
  let cursor = '';
  let attempt = 0;
  while (true) {
    options?.signal?.throwIfAborted();
    try {
      const response = await fetch(runtimeApiUrl(`${pathFor(sessionId)}/queue/events`), {
        headers: { Accept: 'text/event-stream' },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      options?.signal?.throwIfAborted();
      if (!response.ok) {
        if (response.status >= 500) throw new TypeError('Queue unavailable');
        throw new AgentStreamError(`http-${response.status}`, 'Queue observation failed');
      }
      const frames = readSseStream(response, {
        maxFrameChars: 65536,
        maxBufferChars: 65536,
        signal: options?.signal,
        createError: (reason) =>
          reason === 'frame-too-large' || reason === 'buffer-too-large'
            ? new AgentStreamError('agent-stream-protocol', 'Queue frame exceeds limit')
            : new AgentStreamError('agent-stream-protocol', 'Queue stream is invalid'),
      });
      options?.onConnection?.('connected');
      for await (const frame of frames) {
        if (frame.event === 'queue') {
          let payload: unknown;
          try {
            payload = JSON.parse(frame.data) as unknown;
          } catch {
            throw new AgentStreamError('agent-stream-protocol', 'Queue frame is invalid');
          }
          const parsed = agentExecutionQueueSnapshotSchema.safeParse(payload);
          if (!parsed.success)
            throw new AgentStreamError('agent-stream-protocol', 'Queue frame is invalid');
          const state = validateQueue(parsed.data, sessionId);
          const [epoch, , sequence] = state.cursor.split(':');
          const [previousEpoch, , previousSequence] = cursor.split(':');
          if (epoch !== previousEpoch || Number(sequence) > Number(previousSequence)) {
            cursor = state.cursor;
            onSnapshot(state);
          }
        }
      }
    } catch (error: unknown) {
      options?.signal?.throwIfAborted();
      if (!(error instanceof TypeError)) throw error;
    }
    options?.onConnection?.('reconnecting');
    await waitForExecutionRetry(attempt++, options?.signal);
  }
}
