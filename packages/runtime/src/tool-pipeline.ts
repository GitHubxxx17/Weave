import {
  ToolExecutionError,
  toolExecutionRequestSchema,
  type RegisteredToolDefinition,
  type ToolApprovalSummary,
  type ToolDefinition,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from './tool-types.js';
import { ApprovalError, type ApprovalDecision, type ApprovalBroker } from './approval-types.js';
import type { ToolRegistry } from './tool-registry.js';

const defaultMaxResultBytes = 32_000;

/** Configuration used to create a shared Tool Pipeline. */
export interface ToolPipelineOptions {
  /** Registry containing executable tool definitions. */
  readonly registry: ToolRegistry;
  /** Broker used to pause protected tools until an external decision arrives. */
  readonly approvalBroker?: ApprovalBroker | undefined;
  /** Default timeout applied when a request does not specify one. */
  readonly timeoutMs?: number | undefined;
  /** Maximum UTF-8 byte length returned in tool content. */
  readonly maxResultBytes?: number | undefined;
}

/** Public execution boundary for all registered tools. */
export interface ToolPipeline {
  /** Validates, executes and normalizes one model-produced tool call. */
  execute(request: ToolExecutionRequest): Promise<ToolExecutionResult>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function mapApprovalError(toolName: string, error: ApprovalError): ToolExecutionError {
  switch (error.code) {
    case 'approval-cancelled':
      return new ToolExecutionError(
        'tool-approval-cancelled',
        `Tool "${toolName}" approval was cancelled`,
        { cause: error },
      );
    case 'approval-expired':
      return new ToolExecutionError(
        'tool-approval-expired',
        `Tool "${toolName}" approval expired`,
        { cause: error },
      );
    default:
      return new ToolExecutionError('tool-execution-failed', `Tool "${toolName}" approval failed`, {
        cause: error,
      });
  }
}

function createRejectedApprovalError(
  toolName: string,
  decision: Extract<ApprovalDecision, { status: 'rejected' }>,
): ToolExecutionError {
  return new ToolExecutionError(
    'tool-approval-rejected',
    `Tool "${toolName}" approval was rejected`,
    {
      cause: decision.reason === undefined ? undefined : new Error(decision.reason),
    },
  );
}

function parseArguments(toolName: string, argumentsText: string): unknown {
  try {
    return JSON.parse(argumentsText) as unknown;
  } catch (error: unknown) {
    throw new ToolExecutionError(
      'tool-invalid-json',
      `Tool "${toolName}" arguments are not valid JSON`,
      { cause: error },
    );
  }
}

function serializeResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (result === undefined) {
    return '';
  }
  const serialized = JSON.stringify(result);
  if (serialized === undefined) {
    throw new TypeError('Tool result cannot be serialized as JSON');
  }
  return serialized;
}

function limitUtf8(text: string, maxBytes: number): { content: string; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) {
    return { content: text, truncated: false };
  }

  // Tell the model the result is incomplete, when the notice fits comfortably.
  const notice = `\n[结果超过 ${maxBytes} 字节，后面的内容已截断]`;
  const noticeBytes = encoder.encode(notice).byteLength;
  const withNotice = noticeBytes * 2 <= maxBytes;
  let validPrefix = bytes.slice(0, withNotice ? maxBytes - noticeBytes : maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (validPrefix.byteLength > 0) {
    try {
      const prefix = decoder.decode(validPrefix);
      return {
        content: withNotice ? `${prefix}${notice}` : prefix,
        truncated: true,
      };
    } catch {
      validPrefix = validPrefix.slice(0, -1);
    }
  }

  return {
    content: withNotice ? notice.trimStart() : '',
    truncated: true,
  };
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function createCombinedSignal(
  requestSignal: AbortSignal | undefined,
  controller: AbortController,
): AbortSignal {
  if (requestSignal === undefined) {
    return controller.signal;
  }
  return AbortSignal.any([requestSignal, controller.signal]);
}

/** Creates a Tool Pipeline that owns validation and execution lifecycle. */
export function createToolPipeline(options: ToolPipelineOptions): ToolPipeline {
  const timeoutMs = options.timeoutMs;
  const maxResultBytes = options.maxResultBytes ?? defaultMaxResultBytes;

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new RangeError('timeoutMs must be a finite non-negative number');
  }
  if (!Number.isFinite(maxResultBytes) || maxResultBytes < 0) {
    throw new RangeError('maxResultBytes must be a finite non-negative number');
  }

  return {
    async execute(requestInput): Promise<ToolExecutionResult> {
      const parsedRequest = toolExecutionRequestSchema.safeParse(requestInput);
      if (!parsedRequest.success) {
        throw new ToolExecutionError('tool-invalid-input', 'Tool execution input is invalid', {
          cause: parsedRequest.error,
        });
      }
      const request = parsedRequest.data;

      const tool = options.registry.get(request.name);
      if (tool === undefined) {
        throw new ToolExecutionError('tool-not-found', `Tool "${request.name}" was not found`);
      }
      if (request.permissionMode === 'read-only' && tool.readOnly !== true) {
        throw new ToolExecutionError(
          'tool-not-permitted',
          `Tool "${request.name}" is not available in read-only mode`,
        );
      }

      const parsedArguments = parseArguments(request.name, request.arguments);
      const inputResult = tool.inputSchema.safeParse(parsedArguments);
      if (!inputResult.success) {
        throw new ToolExecutionError(
          'tool-invalid-arguments',
          `Tool "${request.name}" arguments are invalid`,
          { cause: inputResult.error },
        );
      }

      const controller = new AbortController();
      const signal = createCombinedSignal(request.signal, controller);
      const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (request.signal?.aborted) {
        throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
          cause: createAbortError(),
        });
      }
      if (effectiveTimeoutMs !== undefined) {
        const markTimedOut = (): void => {
          timedOut = true;
          controller.abort();
        };
        if (effectiveTimeoutMs === 0) {
          markTimedOut();
        } else {
          timeoutId = setTimeout(markTimedOut, effectiveTimeoutMs);
        }
      }

      try {
        if (timedOut) {
          throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`);
        }

        const toolWithApproval = tool as unknown as ToolDefinition<unknown, unknown>;
        if (toolWithApproval.approval !== undefined) {
          const approval = toolWithApproval.approval;
          const approvalBroker = options.approvalBroker;
          if (approvalBroker === undefined) {
            throw new ToolExecutionError(
              'tool-approval-required',
              `Tool "${request.name}" requires an Approval Broker`,
            );
          }

          let summary: ToolApprovalSummary;
          try {
            const pendingSummary = approval.summarize(inputResult.data, {
              signal,
              ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
            });
            summary = isPromiseLike(pendingSummary) ? await pendingSummary : pendingSummary;
          } catch (error: unknown) {
            if (timedOut) {
              throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`, {
                cause: error,
              });
            }
            if (signal.aborted || isAbortError(error)) {
              throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
                cause: error,
              });
            }
            // A summary failure is a tool failure (for example an edit whose text
            // no longer matches); no Approval is created for it.
            throw new ToolExecutionError('tool-execution-failed', `Tool "${request.name}" failed`, {
              cause: error,
            });
          }

          let decision: ApprovalDecision;
          try {
            decision = await approvalBroker.request({
              toolCallId: request.toolCallId,
              toolName: request.name,
              operation: approval.operation,
              summary: summary.summary,
              risk: approval.risk,
              inputSummary: summary.inputSummary,
              signal,
              ...(effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs }),
            });
          } catch (error: unknown) {
            if (error instanceof ApprovalError) {
              if (timedOut) {
                throw new ToolExecutionError(
                  'tool-approval-expired',
                  `Tool "${request.name}" approval expired`,
                  { cause: error },
                );
              }
              throw mapApprovalError(request.name, error);
            }
            throw new ToolExecutionError(
              'tool-execution-failed',
              `Tool "${request.name}" approval could not be created`,
              { cause: error },
            );
          }

          if (decision.status === 'rejected') {
            throw createRejectedApprovalError(request.name, decision);
          }
          if (decision.status !== 'approved') {
            throw new ToolExecutionError(
              'tool-execution-failed',
              `Tool "${request.name}" approval ended with ${decision.status}`,
            );
          }
        }

        let result: unknown;
        try {
          result = await (tool as RegisteredToolDefinition).execute(inputResult.data, {
            signal,
            ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          });
        } catch (error: unknown) {
          if (timedOut) {
            throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`, {
              cause: error,
            });
          }
          if (signal.aborted || isAbortError(error)) {
            throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
              cause: error,
            });
          }
          throw new ToolExecutionError('tool-execution-failed', `Tool "${request.name}" failed`, {
            cause: error,
          });
        }

        if (timedOut) {
          throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`);
        }
        if (signal.aborted) {
          throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
            cause: createAbortError(),
          });
        }

        let content: string;
        try {
          content = serializeResult(result);
        } catch (error: unknown) {
          throw new ToolExecutionError(
            'tool-result-serialization-failed',
            `Tool "${request.name}" result could not be serialized`,
            { cause: error },
          );
        }

        return {
          toolCallId: request.toolCallId,
          name: request.name,
          ...limitUtf8(content, maxResultBytes),
        };
      } finally {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        controller.abort();
      }
    },
  };
}
