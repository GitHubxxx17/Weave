import {
  ToolExecutionError,
  toolExecutionRequestSchema,
  type RegisteredToolDefinition,
  type ToolExecutionRequest,
  type ToolExecutionResult,
} from './tool-types.js';
import type { ToolRegistry } from './tool-registry.js';

const defaultMaxResultBytes = 32_000;

/** Configuration used to create a shared Tool Pipeline. */
export interface ToolPipelineOptions {
  /** Registry containing executable tool definitions. */
  readonly registry: ToolRegistry;
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

  let validPrefix = bytes.slice(0, maxBytes);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (validPrefix.byteLength > 0) {
    try {
      return {
        content: decoder.decode(validPrefix),
        truncated: true,
      };
    } catch {
      validPrefix = validPrefix.slice(0, -1);
    }
  }

  return {
    content: '',
    truncated: true,
  };
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
          throw new ToolExecutionError(
            'tool-execution-failed',
            `Tool "${request.name}" failed`,
            { cause: error },
          );
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
