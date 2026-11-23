import { z } from 'zod';
import { waitForExecutionRetry } from '../agent/agent-execution-client.js';
import { parseSseFrame } from '../agent/agent-legacy-stream.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import {
  agentTaskTreeSnapshotSchema,
  agentTaskViewSchema,
  type AgentTaskTreeSnapshot,
  type AgentTaskView,
} from './task-types.js';

const maxSnapshotBytes = 24_576;
const maxFrameBytes = 256 * 1024;
const bytes = new TextEncoder();
const stopReceiptSchema = z.strictObject({ tasks: z.array(agentTaskViewSchema).max(4) });

export class TaskApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskApiError';
  }
}

function invalidResponse(): TaskApiError {
  return new TaskApiError('task-api-protocol', '任务响应格式无效');
}

function treePath(root: string): string {
  return `/sessions/${encodeURIComponent(root)}/tasks`;
}

function readJson<T>(text: string, schema: z.ZodType<T>): T {
  if (bytes.encode(text).length > maxSnapshotBytes) throw invalidResponse();
  try {
    return schema.parse(JSON.parse(text));
  } catch {
    throw invalidResponse();
  }
}

async function readBoundedBody(response: Response): Promise<string> {
  if (response.body === null) throw invalidResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return body + decoder.decode();
      received += value.byteLength;
      if (received > maxSnapshotBytes) throw invalidResponse();
      body += decoder.decode(value, { stream: true });
    }
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function checkedResponse(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(runtimeApiUrl(path), init);
  if (response.ok) return response;
  throw new TaskApiError(
    `http-${response.status}`,
    response.status === 404 ? '任务已不可用' : '任务请求失败，请重试',
  );
}

function readTree(text: string, root: string): AgentTaskTreeSnapshot {
  const value = readJson(text, agentTaskTreeSnapshotSchema);
  if (
    value.rootSessionId !== root ||
    new Set(value.tasks.map(({ taskId }) => taskId)).size !== value.tasks.length
  )
    throw invalidResponse();
  return value;
}

export async function getAgentTaskTree(
  root: string,
  options?: { readonly cursor?: string; readonly signal?: AbortSignal },
): Promise<AgentTaskTreeSnapshot> {
  const query = new URLSearchParams();
  if (options?.cursor !== undefined) query.set('cursor', options.cursor);
  const response = await checkedResponse(
    `${treePath(root)}${query.size === 0 ? '' : `?${query}`}`,
    options?.signal === undefined ? undefined : { signal: options.signal },
  );
  return readTree(await readBoundedBody(response), root);
}

export async function getAgentTask(
  root: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<AgentTaskView> {
  const response = await checkedResponse(
    `${treePath(root)}/${encodeURIComponent(taskId)}`,
    signal === undefined ? undefined : { signal },
  );
  const task = readJson(await readBoundedBody(response), agentTaskViewSchema);
  if (task.rootSessionId !== root || task.taskId !== taskId) throw invalidResponse();
  return task;
}

export async function stopAgentTask(
  root: string,
  taskId: string | undefined,
  operationId: string,
): Promise<void> {
  const suffix = taskId === undefined ? '/stop-all' : `/${encodeURIComponent(taskId)}/cancel`;
  const response = await checkedResponse(`${treePath(root)}${suffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operationId }),
  });
  const receipt = readJson(await readBoundedBody(response), stopReceiptSchema);
  if (
    receipt.tasks.some(
      (task) => task.rootSessionId !== root || (taskId !== undefined && task.taskId !== taskId),
    )
  )
    throw invalidResponse();
}

export async function observeAgentTaskTree(
  root: string,
  onSnapshot: (snapshot: AgentTaskTreeSnapshot) => void,
  signal: AbortSignal,
  onConnection?: (state: 'connected' | 'reconnecting') => void,
): Promise<void> {
  let latest: AgentTaskTreeSnapshot | undefined;
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => {
      void reader?.cancel().catch(() => undefined);
    };
    try {
      const query = latest === undefined ? '' : `?${new URLSearchParams({ after: latest.cursor })}`;
      const response = await checkedResponse(`${treePath(root)}/events${query}`, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });
      signal.throwIfAborted();
      if (
        response.body === null ||
        !response.headers.get('Content-Type')?.includes('text/event-stream')
      )
        throw invalidResponse();
      reader = response.body.getReader();
      signal.addEventListener('abort', cancel, { once: true });
      const decoder = new TextDecoder();
      let buffer = '';
      onConnection?.('connected');
      while (true) {
        const { value, done } = await reader.read();
        signal.throwIfAborted();
        buffer += decoder.decode(value, { stream: !done });
        let delimiter = /\r?\n\r?\n/.exec(buffer);
        while (delimiter !== null) {
          const raw = buffer.slice(0, delimiter.index);
          buffer = buffer.slice(delimiter.index + delimiter[0].length);
          if (bytes.encode(raw).length > maxFrameBytes) throw invalidResponse();
          const frame = parseSseFrame(raw);
          if (frame?.event === 'tasks') {
            const next = readTree(frame.data, root);
            if (latest?.epoch !== next.epoch || next.revision > latest.revision) {
              latest = next;
              attempt = 0;
              onSnapshot(next);
              signal.throwIfAborted();
            }
          }
          delimiter = /\r?\n\r?\n/.exec(buffer);
        }
        if (bytes.encode(buffer).length > maxFrameBytes) throw invalidResponse();
        if (done) break;
      }
    } catch (cause: unknown) {
      signal.throwIfAborted();
      if (
        !(cause instanceof TypeError) &&
        !(
          cause instanceof TaskApiError &&
          (cause.code === 'http-409' || /^http-5/.test(cause.code))
        )
      )
        throw cause;
    } finally {
      signal.removeEventListener('abort', cancel);
      cancel();
      reader?.releaseLock();
    }
    onConnection?.('reconnecting');
    await waitForExecutionRetry(attempt++, signal);
  }
}
