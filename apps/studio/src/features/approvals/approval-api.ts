import { z } from 'zod';

import { parseSseFrame } from '../agent/agent-stream.js';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';

/** Approval snapshot as exposed by `GET /approvals/stream`. */
export const approvalRequestSchema = z.object({
  approvalId: z.string().min(1),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  operation: z.string().min(1),
  summary: z.string().min(1),
  risk: z.enum(['low', 'medium', 'high']),
  inputSummary: z.unknown(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']),
  createdAt: z.string().min(1),
  resolvedAt: z.string().optional(),
  expiresAt: z.string().optional(),
  decisionReason: z.string().optional(),
});

export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

const snapshotSchema = z.object({ approvals: z.array(approvalRequestSchema) });

export interface ApprovalStreamHandlers {
  /** Replaces the whole list; sent first on every (re)connection. */
  readonly onSnapshot: (approvals: readonly ApprovalRequest[]) => void;
  /** Adds or replaces one request after a live create/resolve event. */
  readonly onUpdate: (approval: ApprovalRequest) => void;
}

export interface ApprovalStreamOptions {
  readonly signal: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
  /** Delay before reconnecting after the stream ends or fails. */
  readonly retryDelayMs?: number;
}

function dispatch(frame: string, handlers: ApprovalStreamHandlers): void {
  const parsed = parseSseFrame(frame);
  if (parsed === null) {
    return;
  }
  let data: unknown;
  try {
    data = JSON.parse(parsed.data) as unknown;
  } catch {
    return;
  }
  if (parsed.event === 'approval.snapshot') {
    const snapshot = snapshotSchema.safeParse(data);
    if (snapshot.success) {
      handlers.onSnapshot(snapshot.data.approvals);
    }
    return;
  }
  if (parsed.event === 'approval.created' || parsed.event === 'approval.resolved') {
    const approval = approvalRequestSchema.safeParse(data);
    if (approval.success) {
      handlers.onUpdate(approval.data);
    }
  }
}

function waitFor(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, delayMs);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Keeps an Approval list in sync with the local Server until `signal` aborts.
 *
 * The Server sends a snapshot on connect, so a reconnect after a dropped
 * stream rebuilds the full view; no event replay is needed.
 */
export async function subscribeApprovals(
  handlers: ApprovalStreamHandlers,
  options: ApprovalStreamOptions,
): Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const retryDelayMs = options.retryDelayMs ?? 2000;

  while (!options.signal.aborted) {
    try {
      const response = await fetchImpl(runtimeApiUrl('/approvals/stream'), {
        headers: { Accept: 'text/event-stream' },
        signal: options.signal,
      });
      if (response.ok && response.body !== null) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          let index = buffer.search(/\r?\n\r?\n/);
          while (index !== -1) {
            const delimiter = buffer.slice(index).match(/^\r?\n\r?\n/)?.[0] ?? '\n\n';
            dispatch(buffer.slice(0, index), handlers);
            buffer = buffer.slice(index + delimiter.length);
            index = buffer.search(/\r?\n\r?\n/);
          }
        }
      }
    } catch {
      // Network errors and aborts fall through to the retry or exit below.
    }
    await waitFor(retryDelayMs, options.signal);
  }
}

export class ApprovalApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApprovalApiError';
    this.code = code;
  }
}

const errorPayloadSchema = z.object({
  error: z.object({ code: z.string().min(1), message: z.string().min(1) }),
});

/** Approves or rejects one pending request through the local Server. */
export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  options: { readonly reason?: string; readonly fetch?: typeof globalThis.fetch } = {},
): Promise<ApprovalRequest> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(
      runtimeApiUrl(`/approvals/${encodeURIComponent(approvalId)}/${decision}`),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(options.reason === undefined ? {} : { reason: options.reason }),
      },
    );
  } catch {
    throw new ApprovalApiError('approval-api-network', '无法连接到本地服务');
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const parsed = errorPayloadSchema.safeParse(body);
    throw parsed.success
      ? new ApprovalApiError(parsed.data.error.code, parsed.data.error.message)
      : new ApprovalApiError('approval-api-invalid-response', '审批请求失败');
  }
  const approval = approvalRequestSchema.safeParse(body);
  if (!approval.success) {
    throw new ApprovalApiError('approval-api-invalid-response', '审批响应格式不正确');
  }
  return approval.data;
}

/** Fields of a `workspace.write_file` summary that are safe to show. */
export interface WriteFileApprovalSummary {
  readonly path: string;
  readonly bytes: number;
  readonly overwrite: boolean;
  /** Line count of the new content. */
  readonly lines?: number | undefined;
  /** Size of the file an overwrite replaces. */
  readonly previousBytes?: number | undefined;
  readonly previousLines?: number | undefined;
  /** Directories the write creates, relative to the project folder. */
  readonly createdDirectories?: readonly string[] | undefined;
}

const writeFileSummarySchema = z.object({
  path: z.string(),
  bytes: z.number(),
  overwrite: z.boolean(),
  lines: z.number().optional(),
  previousBytes: z.number().optional(),
  previousLines: z.number().optional(),
  createdDirectories: z.array(z.string()).optional(),
});

export function readWriteFileSummary(
  approval: ApprovalRequest,
): WriteFileApprovalSummary | undefined {
  if (approval.operation !== 'workspace.write_file') {
    return undefined;
  }
  const parsed = writeFileSummarySchema.safeParse(approval.inputSummary);
  return parsed.success ? parsed.data : undefined;
}

/** Fields of a `shell.run_command` summary. */
export interface CommandApprovalSummary {
  /** The complete command line; the request summary only shows its start. */
  readonly command: string;
  /** Working directory relative to the project folder. */
  readonly cwd: string;
  readonly timeoutMs: number;
}

const commandSummarySchema = z.object({
  command: z.string(),
  cwd: z.string(),
  timeoutMs: z.number(),
});

export function readCommandSummary(approval: ApprovalRequest): CommandApprovalSummary | undefined {
  if (approval.operation !== 'shell.run_command') {
    return undefined;
  }
  const parsed = commandSummarySchema.safeParse(approval.inputSummary);
  return parsed.success ? parsed.data : undefined;
}

/** Fields of a `workspace.edit_file` summary. */
export interface EditFileApprovalSummary {
  readonly path: string;
  readonly replacements: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** Unified diff of the change, capped by the Server. */
  readonly diff: string;
  readonly diffTruncated: boolean;
}

const editFileSummarySchema = z.object({
  path: z.string(),
  replacements: z.number(),
  linesAdded: z.number(),
  linesRemoved: z.number(),
  diff: z.string(),
  diffTruncated: z.boolean(),
});

export function readEditFileSummary(
  approval: ApprovalRequest,
): EditFileApprovalSummary | undefined {
  if (approval.operation !== 'workspace.edit_file') {
    return undefined;
  }
  const parsed = editFileSummarySchema.safeParse(approval.inputSummary);
  return parsed.success ? parsed.data : undefined;
}
