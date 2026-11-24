import {
  ToolExecutionError,
  toolExecutionRequestSchema,
  type RegisteredToolDefinition,
  type ToolApprovalSummary,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from './tool-types.js';
import { ApprovalError, type ApprovalDecision, type ApprovalBroker } from './approval-types.js';
import { approvalRequiredForMode } from './approval-risk.js';
import {
  assertAuthorizedTool,
  beginAgentToolExecution,
  bindToolApproval,
  checkAgentToolCheckpoint,
} from './agent-tool-authority.js';
import type { ToolRegistry } from './tool-registry.js';
import { isMemoryError } from './memory-errors.js';
import { isRetrievalError } from './retrieval-errors.js';
import {
  assertRetrievalToolAuthority,
  beginRetrievalToolAttempt,
  retrievalToolConfiguration,
} from './retrieval-tool-attempt.js';
import {
  assertMemoryToolAuthority,
  beginMemoryToolAttempt,
  memoryToolConfiguration,
} from './memory-tool-attempt.js';

export const defaultToolResultMaxBytes = 32_000;

/**
 * Middleware around one whole tool execution: validation, approval, the tool
 * and result shaping. It may adjust the request it passes on and the result it
 * returns, call `next` again to retry, or answer without calling it. Because it
 * sits outside the pipeline, an adjusted request still goes through approval,
 * and a retry asks for approval again.
 *
 * The pipeline keeps its guarantees around the middleware: the result must
 * still be the result of the original call (same `toolCallId` and `name`), its
 * content is limited to `maxResultBytes` again, and nothing beyond the four
 * result fields gets through.
 */
export type ToolAround = (
  request: ToolExecutionRequest,
  next: (request: ToolExecutionRequest) => Promise<ToolExecutionResult>,
) => Promise<ToolExecutionResult>;

/**
 * A policy's vote on one tool call: stop it (`deny`), require Approval
 * (`ask`), or leave the usual flow alone (`abstain`).
 */
export type ToolPolicyVote = 'deny' | 'ask' | 'abstain';

/**
 * A security policy, consulted for every call once its arguments are valid and
 * before Approval. A policy can only make the outcome stricter: `deny` ends the
 * call, `ask` requires Approval even where the tool, its permission mode or its
 * own metadata would not, and `abstain` changes nothing. No vote skips
 * Approval. A policy that throws or returns anything else is treated as `deny`,
 * so a broken policy never lets a call through.
 */
export type ToolPolicy = (
  request: ToolExecutionRequest,
) => ToolPolicyVote | PromiseLike<ToolPolicyVote>;

/** Configuration used to create a shared Tool Pipeline. */
export interface ToolPipelineOptions {
  /** Registry containing executable tool definitions. */
  readonly registry: ToolRegistry;
  /**
   * Broker used to pause protected tools until an external decision arrives.
   * Only `request` is used, so a view that cannot approve or reject is enough.
   */
  readonly approvalBroker?: Pick<ApprovalBroker, 'request'> | undefined;
  /** Default timeout applied when a request does not specify one. */
  readonly timeoutMs?: number | undefined;
  /** Maximum UTF-8 byte length returned in tool content. */
  readonly maxResultBytes?: number | undefined;
  /** Middleware around each execution; see {@link ToolAround}. */
  readonly around?: ToolAround | undefined;
  /** Security policy for each call, inside `around`; see {@link ToolPolicy}. */
  readonly policy?: ToolPolicy | undefined;
  /** Host policy for exposing private authority to tool implementations. */
  readonly allowHostToolContext?: ((tool: RegisteredToolDefinition) => boolean) | undefined;
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

/** Rebuilds what a middleware returned as the result of `request`, or rejects it. */
function checkAroundResult(
  request: ToolExecutionRequest,
  result: unknown,
  maxResultBytes: number,
): ToolExecutionResult {
  const candidate =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : undefined;
  if (
    candidate === undefined ||
    candidate.toolCallId !== request.toolCallId ||
    candidate.name !== request.name ||
    typeof candidate.content !== 'string' ||
    typeof candidate.truncated !== 'boolean'
  ) {
    throw new ToolExecutionError(
      'tool-execution-failed',
      `Tool "${request.name}" around middleware returned an invalid result`,
    );
  }
  const limited = limitUtf8(candidate.content, maxResultBytes);
  return {
    toolCallId: request.toolCallId,
    name: request.name,
    content: limited.content,
    truncated: candidate.truncated || limited.truncated,
  };
}

/** Runs `around` outside `pipeline`, holding its result to the pipeline's guarantees. */
function withAround(
  pipeline: ToolPipeline,
  around: ToolAround,
  maxResultBytes: number,
  registry: ToolRegistry,
  allowHostToolContext: ToolPipelineOptions['allowHostToolContext'],
): ToolPipeline {
  return {
    async execute(requestInput): Promise<ToolExecutionResult> {
      const parsedRequest = toolExecutionRequestSchema.safeParse(requestInput);
      if (!parsedRequest.success) {
        throw new ToolExecutionError('tool-invalid-input', 'Tool execution input is invalid', {
          cause: parsedRequest.error,
        });
      }
      const request = Object.freeze(parsedRequest.data);
      assertRetrievalToolAuthority(
        request,
        registry,
        registry.get(request.name),
        allowHostToolContext,
      );
      assertMemoryToolAuthority(
        request,
        registry,
        registry.get(request.name),
        allowHostToolContext,
      );
      if (request.toolAuthority !== undefined) {
        assertAuthorizedTool(request, registry, registry.get(request.name));
      }

      let result: unknown;
      let acceptingAttempts = true;
      const pendingAttempts = new Set<Promise<ToolExecutionResult>>();
      try {
        result = await around(request, (next) => {
          if (!acceptingAttempts) {
            throw new ToolExecutionError(
              'tool-invalid-input',
              'Tool middleware invocation is closed',
            );
          }
          // Normalize once before identity comparisons: plugin accessors must
          // not return one identity here and a different one during execution.
          const parsedNext = toolExecutionRequestSchema.safeParse(next);
          if (!parsedNext.success) {
            throw new ToolExecutionError('tool-invalid-input', 'Tool middleware input is invalid', {
              cause: parsedNext.error,
            });
          }
          const nextRequest = Object.freeze(parsedNext.data);
          // Middleware can retry/adjust arguments, but cannot borrow another
          // turn's host-owned authority or upgrade the user's permission mode.
          if (
            nextRequest.name !== request.name ||
            nextRequest.toolCallId !== request.toolCallId ||
            nextRequest.sessionId !== request.sessionId ||
            nextRequest.turnId !== request.turnId ||
            nextRequest.executionId !== request.executionId ||
            nextRequest.toolAuthority !== request.toolAuthority ||
            nextRequest.signal !== request.signal ||
            nextRequest.permissionMode !== request.permissionMode
          ) {
            throw new ToolExecutionError(
              'tool-invalid-input',
              'Tool middleware changed invocation identity',
            );
          }
          const attempt = pipeline.execute(nextRequest);
          pendingAttempts.add(attempt);
          const forget = () => pendingAttempts.delete(attempt);
          void attempt.then(forget, forget);
          return attempt;
        });
      } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
          throw error;
        }
        if (request.signal?.aborted === true || isAbortError(error)) {
          throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
            cause: error,
          });
        }
        throw new ToolExecutionError(
          'tool-execution-failed',
          `Tool "${request.name}" around middleware failed`,
          { cause: error },
        );
      } finally {
        acceptingAttempts = false;
        await Promise.allSettled(pendingAttempts);
      }
      if (request.signal?.aborted === true) {
        throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
          cause: createAbortError(),
        });
      }
      return checkAroundResult(request, result, maxResultBytes);
    },
  };
}

/** Asks `policy` for its vote; a policy that throws or answers wrongly denies. */
async function consultPolicy(
  policy: ToolPolicy,
  request: ToolExecutionRequest,
  signal: AbortSignal,
): Promise<{ readonly vote: ToolPolicyVote; readonly cause?: unknown; readonly aborted?: true }> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    // A policy that never answers must not outlive the call's deadline or cancellation.
    const vote = await Promise.race([Promise.resolve().then(() => policy(request)), aborted]);
    if (vote === 'aborted') {
      return { vote: 'deny', aborted: true };
    }
    if (vote === 'deny' || vote === 'ask' || vote === 'abstain') {
      return { vote };
    }
    return { vote: 'deny', cause: new TypeError('A tool policy returned an invalid vote') };
  } catch (error: unknown) {
    return { vote: 'deny', cause: error };
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

const policyApprovalArgumentChars = 1_000;

/** The Approval shown when a policy asks about a tool that has none of its own. */
function policyApproval(
  request: ToolExecutionRequest,
): NonNullable<ToolDefinition<unknown, unknown>['approval']> {
  return {
    operation: 'plugin.policy',
    risk: 'medium',
    summarize: () => ({
      summary: `插件策略要求确认工具 ${request.name} 的调用`,
      inputSummary: {
        tool: request.name,
        arguments:
          request.arguments.length > policyApprovalArgumentChars
            ? `${request.arguments.slice(0, policyApprovalArgumentChars)}…`
            : request.arguments,
      },
    }),
  };
}

/** Creates a Tool Pipeline that owns validation and execution lifecycle. */
export function createToolPipeline(options: ToolPipelineOptions): ToolPipeline {
  const timeoutMs = options.timeoutMs;
  const maxResultBytes = options.maxResultBytes ?? defaultToolResultMaxBytes;

  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new RangeError('timeoutMs must be a finite non-negative number');
  }
  if (!Number.isFinite(maxResultBytes) || maxResultBytes < 0) {
    throw new RangeError('maxResultBytes must be a finite non-negative number');
  }

  const pipeline: ToolPipeline = {
    async execute(requestInput): Promise<ToolExecutionResult> {
      const parsedRequest = toolExecutionRequestSchema.safeParse(requestInput);
      if (!parsedRequest.success) {
        throw new ToolExecutionError('tool-invalid-input', 'Tool execution input is invalid', {
          cause: parsedRequest.error,
        });
      }
      const request = Object.freeze(parsedRequest.data);

      const tool = options.registry.get(request.name);
      assertMemoryToolAuthority(request, options.registry, tool, options.allowHostToolContext);
      assertRetrievalToolAuthority(request, options.registry, tool, options.allowHostToolContext);
      const authority = assertAuthorizedTool(request, options.registry, tool);
      if (tool === undefined) {
        throw new ToolExecutionError('tool-not-found', `Tool "${request.name}" was not found`);
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
      const memory = memoryToolConfiguration(tool);
      const retrieval = retrievalToolConfiguration(tool);
      const invocationSignal = createCombinedSignal(request.signal, controller);
      const signal =
        (memory?.signal ?? retrieval?.signal) === undefined
          ? invocationSignal
          : AbortSignal.any([invocationSignal, (memory?.signal ?? retrieval?.signal)!]);
      const effectiveTimeoutMs = request.timeoutMs ?? timeoutMs;
      const publicContext = {
        signal,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        ...(request.turnId === undefined ? {} : { turnId: request.turnId }),
        toolCallId: request.toolCallId,
      };
      const hostContext: ToolExecutionContext = Object.freeze({
        ...publicContext,
        ...(request.toolAuthority === undefined
          ? {}
          : {
              toolAuthority: request.toolAuthority,
              executionId: request.executionId,
            }),
      });
      const context =
        request.toolAuthority !== undefined && options.allowHostToolContext?.(tool) === false
          ? Object.freeze(publicContext)
          : hostContext;
      const summaryContext = Object.freeze({ ...context });
      let memoryAttempt: ReturnType<typeof beginMemoryToolAttempt> | undefined;
      let retrievalAttempt: ReturnType<typeof beginRetrievalToolAttempt> | undefined;
      let timedOut = false;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      function assertCurrent(): void {
        if (timedOut) {
          throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`);
        }
        if (signal.aborted) {
          throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
            cause: createAbortError(),
          });
        }
        assertAuthorizedTool(request, options.registry, options.registry.get(request.name));
        if (retrieval !== undefined)
          assertRetrievalToolAuthority(
            request,
            options.registry,
            options.registry.get(request.name),
            options.allowHostToolContext,
          );
        if (memory !== undefined)
          assertMemoryToolAuthority(
            request,
            options.registry,
            options.registry.get(request.name),
            options.allowHostToolContext,
          );
      }

      async function checkHostAuthority(): Promise<void> {
        assertCurrent();
        try {
          await checkAgentToolCheckpoint(authority, hostContext);
        } catch (cause: unknown) {
          assertCurrent();
          throw new ToolExecutionError(
            'tool-not-permitted',
            'The tool failed its host authority check',
            { cause },
          );
        }
      }

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

        if (memory !== undefined) {
          memoryAttempt = beginMemoryToolAttempt({
            definition: tool,
            request,
            registry: options.registry,
            context,
            summaryContext,
            assertCurrent,
          });
        }

        if (retrieval !== undefined && retrievalAttempt === undefined)
          retrievalAttempt = beginRetrievalToolAttempt({
            definition: tool,
            request,
            registry: options.registry,
            context,
            summaryContext,
            assertCurrent,
          });
        if (authority !== undefined) {
          await checkHostAuthority();
          assertCurrent();
        }
        const toolWithApproval = tool as unknown as ToolDefinition<unknown, unknown>;
        let forceApproval = retrieval?.forceApproval?.(inputResult.data) === true;
        if (options.policy !== undefined) {
          const { vote, cause, aborted } = await consultPolicy(options.policy, request, signal);
          if (aborted === true) {
            if (timedOut) {
              throw new ToolExecutionError('tool-timeout', `Tool "${request.name}" timed out`);
            }
            throw new ToolExecutionError('tool-cancelled', 'Tool execution was cancelled', {
              cause: createAbortError(),
            });
          }
          if (vote === 'deny') {
            throw new ToolExecutionError(
              'tool-denied',
              cause === undefined
                ? `Tool "${request.name}" was denied by a policy`
                : `Tool "${request.name}" was denied because a policy could not decide`,
              cause === undefined ? undefined : { cause },
            );
          }
          forceApproval = forceApproval || vote === 'ask';
        }
        // A policy that asks makes Approval mandatory: for a tool without its own
        // Approval metadata, and in any permission mode.
        const approval =
          toolWithApproval.approval ?? (forceApproval ? policyApproval(request) : undefined);
        let approved = false;
        if (
          approval !== undefined &&
          (forceApproval ||
            approvalRequiredForMode(
              request.permissionMode ?? 'ask',
              approval.operation,
              inputResult.data,
            ))
        ) {
          const approvalBroker = options.approvalBroker;
          if (approvalBroker === undefined) {
            throw new ToolExecutionError(
              'tool-approval-required',
              `Tool "${request.name}" requires an Approval Broker`,
            );
          }

          let summary: ToolApprovalSummary;
          if (authority !== undefined && options.policy !== undefined) {
            await checkHostAuthority();
            assertCurrent();
          }
          try {
            const endPreview =
              memory?.classification === 'root-write'
                ? memoryAttempt!.beginPreview()
                : retrieval?.protected
                  ? retrievalAttempt!.beginPreview()
                  : undefined;
            try {
              const pendingSummary = approval.summarize(
                inputResult.data,
                memory === undefined && retrieval === undefined ? { ...context } : summaryContext,
              );
              summary = isPromiseLike(pendingSummary) ? await pendingSummary : pendingSummary;
            } finally {
              endPreview?.();
            }
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
            if (retrieval !== undefined && isRetrievalError(error))
              throw new ToolExecutionError(error.code, error.message);
            if (memory !== undefined && isMemoryError(error)) {
              throw new ToolExecutionError(error.code, error.message);
            }
            // A summary failure is a tool failure (for example an edit whose text
            // no longer matches); no Approval is created for it.
            throw new ToolExecutionError(
              'tool-execution-failed',
              `Tool "${request.name}" failed`,
              memory === undefined ? { cause: error } : undefined,
            );
          }

          let decision: ApprovalDecision;
          if (authority !== undefined) {
            await checkHostAuthority();
            assertCurrent();
          }
          try {
            decision = await approvalBroker.request(
              bindToolApproval(
                {
                  toolCallId: request.toolCallId,
                  toolName: request.name,
                  operation: approval.operation,
                  summary: summary.summary,
                  risk: approval.risk,
                  inputSummary: summary.inputSummary,
                  ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
                  signal,
                  ...(effectiveTimeoutMs === undefined ? {} : { timeoutMs: effectiveTimeoutMs }),
                },
                authority,
              ),
            );
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
          approved = true;
          if (memory?.classification === 'root-write') memoryAttempt!.approve();
          if (retrieval?.protected) retrievalAttempt!.approve();
        }

        if (memory?.classification === 'root-write' && !approved) memoryAttempt!.automatic();
        if (retrieval?.protected && !approved) retrievalAttempt!.automatic();

        let result: unknown;
        if (authority !== undefined) {
          await checkHostAuthority();
          assertCurrent();
        }
        const endExecution = beginAgentToolExecution(context, request);
        const endMemoryExecution = memoryAttempt?.beginExecute();
        const endRetrievalExecution = retrievalAttempt?.beginExecute();
        try {
          result = await (tool as RegisteredToolDefinition).execute(inputResult.data, context);
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
          if (retrieval !== undefined && isRetrievalError(error))
            throw new ToolExecutionError(error.code, error.message);
          if (memory !== undefined && isMemoryError(error)) {
            throw new ToolExecutionError(error.code, error.message);
          }
          throw new ToolExecutionError(
            'tool-execution-failed',
            `Tool "${request.name}" failed`,
            memory === undefined ? { cause: error } : undefined,
          );
        } finally {
          endRetrievalExecution?.();
          endMemoryExecution?.();
          endExecution();
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
        retrievalAttempt?.close();
        memoryAttempt?.close();
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
        }
        controller.abort();
      }
    },
  };

  return options.around === undefined
    ? pipeline
    : withAround(
        pipeline,
        options.around,
        maxResultBytes,
        options.registry,
        options.allowHostToolContext,
      );
}
