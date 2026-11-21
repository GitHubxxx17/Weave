import {
  Client,
  ProtocolError,
  ProtocolErrorCode,
  SdkError,
  SdkErrorCode,
  specTypeSchemas,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
  type Tool,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { McpClientError } from './errors.js';
import { MCP_LIMITS } from './limits.js';
import { assertJsonValue, compileMcpSchema } from './schema.js';
import type {
  ConnectMcpOptions,
  McpCallResult,
  McpConnection,
  McpToolSnapshot,
  McpValidationResult,
} from './types.js';

const ListToolsResultSchema = specTypeSchemas.ListToolsResult;
type Validator = (input: unknown) => McpValidationResult;
const launchOptionsSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  env: z.record(z.string(), z.string()),
  signal: z.instanceof(AbortSignal),
  onStale: z.custom<() => void>((value) => typeof value === 'function').optional(),
  onClosed: z.custom<() => void>((value) => typeof value === 'function').optional(),
});
const callResultSchema = z.object({
  content: z.array(z.object({ type: z.string() }).passthrough()),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});
const callOptionsSchema = z.object({ signal: z.instanceof(AbortSignal) });

/** State observers cannot interrupt protocol handling or resource cleanup. */
function notifyObserver(observer: (() => void) | undefined): void {
  try {
    observer?.();
  } catch {
    // Observer errors are host implementation details, not MCP service output.
  }
}

/** The SDK asks on every call; it only receives validators compiled in preparation. */
class PreparedOutputSchemas implements jsonSchemaValidator {
  private readonly validators = new Map<string, Validator>();

  add(schema: Readonly<Record<string, unknown>>, validator: Validator): void {
    this.validators.set(JSON.stringify(schema), validator);
  }

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validate = this.validators.get(JSON.stringify(schema));
    if (!validate) throw new McpClientError('mcp-unsupported-schema');
    return (input) =>
      validate(input).valid
        ? { valid: true, data: input as T, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: 'Invalid MCP tool output.' };
  }
}

/** Copies the validated JSON tree, including unknown annotation fields. */
function frozenCopy<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  const copied = Array.isArray(value) ? [] : {};
  const pending: { source: object; target: object }[] = [{ source: value, target: copied }];
  for (let index = 0; index < pending.length; index++) {
    const item = pending[index]!;
    for (const [key, child] of Object.entries(item.source)) {
      let copy: unknown = child;
      if (child !== null && typeof child === 'object') {
        copy = Array.isArray(child) ? [] : {};
        pending.push({ source: child, target: copy as object });
      }
      Object.defineProperty(item.target, key, {
        value: copy,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    Object.freeze(item.target);
  }
  return copied as T;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Owns a fixed deadline and only sends safe reasons through SDK cancellation. */
function operationScope(
  signals: readonly { signal: AbortSignal; code: 'mcp-cancelled' | 'mcp-closed' }[],
  timeoutMs: number,
) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const cleanups: (() => void)[] = [];
  for (const { signal, code } of signals) {
    const cancel = () => controller.abort(new McpClientError(code));
    if (signal.aborted) cancel();
    else {
      signal.addEventListener('abort', cancel, { once: true });
      cleanups.push(() => signal.removeEventListener('abort', cancel));
    }
  }
  const timer = setTimeout(() => controller.abort(new McpClientError('mcp-timeout')), timeoutMs);
  const check = (): void => {
    if (Date.now() >= deadline) {
      controller.abort(new McpClientError('mcp-timeout'));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    signal: controller.signal,
    check,
    remaining: () => Math.max(1, deadline - Date.now()),
    dispose: () => {
      clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
    },
  };
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      reject(signal.reason);
      void promise.catch(() => {});
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function safeCallError(error: unknown): McpClientError {
  if (error instanceof McpClientError) return error;
  if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) {
    return new McpClientError('mcp-invalid-result');
  }
  if (
    error instanceof ProtocolError &&
    (error.code === ProtocolErrorCode.InvalidParams ||
      error.code === ProtocolErrorCode.InvalidRequest)
  ) {
    return new McpClientError('mcp-invalid-result');
  }
  return new McpClientError('mcp-call-failed');
}

export async function connectMcp(launchOptions: ConnectMcpOptions): Promise<McpConnection> {
  let options: z.infer<typeof launchOptionsSchema>;
  try {
    const parsedOptions = launchOptionsSchema.safeParse(launchOptions);
    if (!parsedOptions.success) throw new McpClientError('mcp-connect-failed');
    options = parsedOptions.data;
  } catch {
    throw new McpClientError('mcp-connect-failed');
  }
  if (options.signal.aborted) throw new McpClientError('mcp-cancelled');
  const preparedOutputs = new PreparedOutputSchemas();
  const lifecycle = new AbortController();
  let closed = false;
  let stderrBytes = 0;
  let inFlight = 0;
  let closePromise: Promise<void> | undefined;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    lifecycle.abort(new McpClientError('mcp-closed'));
    notifyObserver(options.onClosed);
  };
  const client = new Client(
    { name: 'weave', version: '0.0.0' },
    {
      capabilities: {},
      enforceStrictCapabilities: true,
      versionNegotiation: { mode: 'legacy' },
      inputRequired: { autoFulfill: false },
      jsonSchemaValidator: preparedOutputs,
      listChanged: {
        tools: {
          autoRefresh: false,
          debounceMs: 0,
          onChanged: () => {
            if (!closed) notifyObserver(options.onStale);
          },
        },
      },
    },
  );
  // Late replies to cancelled calls also reach onerror; consuming them must not
  // close a connection that another turn is still using.
  client.onerror = () => {};
  client.onclose = markClosed;
  const transport = new StdioClientTransport({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: { ...options.env },
    stderr: 'pipe',
    maxBufferSize: MCP_LIMITS.maxBufferBytes,
  });
  transport.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(chunk);
  });

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    markClosed();
    closePromise = (async () => {
      const scope = operationScope([], MCP_LIMITS.closeTimeoutMs);
      try {
        await bounded(client.close(), scope.signal);
      } catch {
        throw new McpClientError('mcp-close-failed');
      } finally {
        scope.dispose();
      }
    })();
    return closePromise;
  };

  const tools: McpToolSnapshot[] = [];
  const definitions = new Map<string, Tool>();
  const validators = new Map<string, Validator>();
  const inputSchemaCache = new Map<string, Validator>();
  const outputSchemaCache = new Map<string, Validator>();
  const scope = operationScope(
    [{ signal: options.signal, code: 'mcp-cancelled' }],
    MCP_LIMITS.connectTimeoutMs,
  );
  try {
    scope.check();
    await bounded(
      client.connect(transport, {
        signal: scope.signal,
        timeout: scope.remaining(),
        maxTotalTimeout: scope.remaining(),
        resetTimeoutOnProgress: false,
      }),
      scope.signal,
    );
    scope.check();
    if (!client.getServerCapabilities()?.tools) {
      throw new McpClientError('mcp-connect-failed');
    }
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let catalogBytes = 0;
    for (let pageNumber = 0; ; pageNumber++) {
      scope.check();
      if (closed) throw new McpClientError('mcp-connect-failed');
      if (pageNumber >= MCP_LIMITS.maxCatalogPages) {
        throw new McpClientError('mcp-catalog-limit');
      }
      const page = await bounded(
        client
          .request(
            { method: 'tools/list', ...(cursor === undefined ? {} : { params: { cursor } }) },
            ListToolsResultSchema,
            {
              signal: scope.signal,
              timeout: scope.remaining(),
              maxTotalTimeout: scope.remaining(),
              resetTimeoutOnProgress: false,
            },
          )
          .catch((error: unknown) => {
            if (error instanceof SdkError && error.code === SdkErrorCode.InvalidResult) {
              throw new McpClientError('mcp-invalid-catalog');
            }
            throw error;
          }),
        scope.signal,
      );
      scope.check();
      catalogBytes += bytes(page);
      if (
        tools.length + page.tools.length > MCP_LIMITS.maxTools ||
        catalogBytes > MCP_LIMITS.maxCatalogBytes
      ) {
        throw new McpClientError('mcp-catalog-limit');
      }
      for (const tool of page.tools) {
        if (
          Buffer.byteLength(tool.name) > MCP_LIMITS.maxToolNameBytes ||
          Buffer.byteLength(tool.description ?? '') > MCP_LIMITS.maxDescriptionBytes ||
          bytes(tool.inputSchema) > MCP_LIMITS.maxSchemaBytes ||
          (tool.outputSchema !== undefined && bytes(tool.outputSchema) > MCP_LIMITS.maxSchemaBytes)
        ) {
          throw new McpClientError('mcp-catalog-limit');
        }
        if (definitions.has(tool.name)) throw new McpClientError('mcp-invalid-catalog');
        const definition = frozenCopy(tool);
        const inputKey = JSON.stringify(definition.inputSchema);
        let validateInput = inputSchemaCache.get(inputKey);
        if (!validateInput) {
          validateInput = compileMcpSchema(definition.inputSchema, { input: true });
          inputSchemaCache.set(inputKey, validateInput);
        }
        if (definition.outputSchema !== undefined) {
          const outputKey = JSON.stringify(definition.outputSchema);
          let validateOutput = outputSchemaCache.get(outputKey);
          if (!validateOutput) {
            validateOutput = compileMcpSchema(definition.outputSchema);
            outputSchemaCache.set(outputKey, validateOutput);
          }
          preparedOutputs.add(definition.outputSchema, validateOutput);
        }
        scope.check();
        definitions.set(tool.name, definition);
        validators.set(tool.name, validateInput);
        tools.push(
          frozenCopy({
            name: definition.name,
            description: definition.description ?? '',
            inputSchema: definition.inputSchema,
            ...(definition.outputSchema === undefined
              ? {}
              : { outputSchema: definition.outputSchema }),
            ...(definition.annotations === undefined
              ? {}
              : { annotations: definition.annotations }),
          }),
        );
      }
      if (page.nextCursor === undefined) break;
      if (cursors.has(page.nextCursor)) throw new McpClientError('mcp-invalid-catalog');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    scope.check();
    if (closed) throw new McpClientError('mcp-connect-failed');
  } catch (error) {
    const failure = scope.signal.aborted
      ? (scope.signal.reason as McpClientError)
      : error instanceof McpClientError
        ? error
        : new McpClientError('mcp-connect-failed');
    await close().catch(() => {});
    throw failure;
  } finally {
    scope.dispose();
  }

  const validateInput = (name: string, input: unknown): McpValidationResult => {
    const validate = validators.get(name);
    if (!validate) return { valid: false, issue: 'Unknown MCP tool.' };
    return validate(input);
  };

  return {
    tools: Object.freeze(tools),
    get stderrBytes() {
      return stderrBytes;
    },
    validateInput,
    async callTool(name, input, callOptions): Promise<McpCallResult> {
      if (closed) throw new McpClientError('mcp-closed');
      let callSignal: AbortSignal;
      try {
        const parsedCallOptions = callOptionsSchema.safeParse(callOptions);
        if (!parsedCallOptions.success) throw new McpClientError('mcp-invalid-input');
        callSignal = parsedCallOptions.data.signal;
      } catch {
        throw new McpClientError('mcp-invalid-input');
      }
      if (callSignal.aborted) throw new McpClientError('mcp-cancelled');
      const definition = definitions.get(name);
      if (!definition || !validateInput(name, input).valid) {
        throw new McpClientError('mcp-invalid-input');
      }
      let argumentsCopy: Readonly<Record<string, unknown>>;
      try {
        assertJsonValue(input, {
          maxBytes: MCP_LIMITS.maxInputBytes,
          maxDepth: MCP_LIMITS.maxInputDepth,
          maxNodes: MCP_LIMITS.maxInputNodes,
        });
        argumentsCopy = frozenCopy(input);
      } catch {
        throw new McpClientError('mcp-invalid-input');
      }
      if (inFlight >= MCP_LIMITS.maxConcurrentCalls) throw new McpClientError('mcp-busy');
      inFlight++;
      const callScope = operationScope(
        [
          { signal: callSignal, code: 'mcp-cancelled' },
          { signal: lifecycle.signal, code: 'mcp-closed' },
        ],
        MCP_LIMITS.callTimeoutMs,
      );
      try {
        callScope.check();
        const result = await bounded(
          client.callTool(
            { name, arguments: argumentsCopy },
            {
              toolDefinition: definition,
              signal: callScope.signal,
              timeout: MCP_LIMITS.callTimeoutMs,
              maxTotalTimeout: MCP_LIMITS.callTimeoutMs,
              resetTimeoutOnProgress: false,
            },
          ),
          callScope.signal,
        );
        callScope.check();
        try {
          assertJsonValue(result, {
            maxBytes: MCP_LIMITS.maxResultBytes,
            maxDepth: MCP_LIMITS.maxResultBytes,
            maxNodes: MCP_LIMITS.maxResultBytes,
          });
        } catch {
          throw new McpClientError('mcp-invalid-result');
        }
        const parsedResult = callResultSchema.safeParse(result);
        if (!parsedResult.success) throw new McpClientError('mcp-invalid-result');
        return frozenCopy({
          content: parsedResult.data.content,
          ...(parsedResult.data.structuredContent === undefined
            ? {}
            : { structuredContent: parsedResult.data.structuredContent }),
          ...(parsedResult.data.isError === undefined
            ? {}
            : { isError: parsedResult.data.isError }),
        });
      } catch (error) {
        if (callScope.signal.aborted) throw callScope.signal.reason;
        throw safeCallError(error);
      } finally {
        callScope.dispose();
        inFlight--;
      }
    },
    close,
  };
}
