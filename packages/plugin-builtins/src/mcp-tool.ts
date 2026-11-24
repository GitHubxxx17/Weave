import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { McpClientError, type McpConnection, type McpToolSnapshot } from '@weave/mcp-client';
import { PluginError } from '@weave/plugin';
import type { ToolDefinition, ToolExecutionContext } from '@weave/runtime';
import { z } from 'zod';
import type { McpPluginOptions } from './mcp-plugin.js';
import { formatMcpResult, mcpDescriptionPrefix, redactMcpText } from './mcp-result.js';

const serverIdSchema = z
  .string()
  .max(24)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const originalNameSchema = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value) <= 256);
const optionsSchema = z.object({
  serverId: serverIdSchema,
  label: z.string().min(1).max(80),
  cwd: z.string().min(1),
  connection: z.custom<McpConnection>((value) => {
    if (typeof value !== 'object' || value === null) return false;
    const connection = value as McpConnection;
    return (
      Array.isArray(connection.tools) &&
      typeof connection.validateInput === 'function' &&
      typeof connection.callTool === 'function' &&
      typeof connection.close === 'function'
    );
  }),
  redactValues: z.array(z.string()).optional(),
});
const snapshotSchema = z.object({
  name: originalNameSchema,
  description: z.string(),
  inputSchema: z.custom<Readonly<Record<string, unknown>>>(
    (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
  ),
  outputSchema: z
    .custom<Readonly<Record<string, unknown>>>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    .optional(),
  annotations: z
    .custom<Readonly<Record<string, unknown>>>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
    )
    .optional(),
});

function invalidDefinition(serverId?: string): PluginError {
  return new PluginError(
    'plugin-invalid-definition',
    'The MCP tool plugin definition is invalid.',
    {
      ...(serverId === undefined ? {} : { pluginId: `mcp-${serverId}` }),
    },
  );
}

/** Internal shared factory boundary; no launch authorization or connection ownership. */
export function parseMcpPluginOptions(value: McpPluginOptions): McpPluginOptions {
  try {
    const parsed = optionsSchema.safeParse(value);
    if (!parsed.success) throw invalidDefinition();
    return Object.freeze({
      serverId: parsed.data.serverId,
      label: parsed.data.label,
      cwd: parsed.data.cwd,
      connection: parsed.data.connection,
      ...(parsed.data.redactValues === undefined
        ? {}
        : { redactValues: Object.freeze([...parsed.data.redactValues]) }),
    });
  } catch {
    throw invalidDefinition();
  }
}

/** Stable identity is derived from the original UTF-8 name, never its display text. */
export function mcpToolName(serverId: string, originalName: string): string {
  try {
    if (
      !serverIdSchema.safeParse(serverId).success ||
      !originalNameSchema.safeParse(originalName).success
    )
      throw invalidDefinition();
    const slug =
      originalName
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 10) || 'tool';
    const hash = createHash('sha256').update(originalName, 'utf8').digest('hex').slice(0, 16);
    return `mcp_${serverId}_${slug}_${hash}`;
  } catch {
    throw invalidDefinition();
  }
}

function copySnapshot(snapshot: McpToolSnapshot, serverId: string): McpToolSnapshot {
  try {
    const parsed = snapshotSchema.safeParse(snapshot);
    if (!parsed.success) throw invalidDefinition(serverId);
    const value: McpToolSnapshot = {
      name: parsed.data.name,
      description: parsed.data.description,
      inputSchema: parsed.data.inputSchema,
      ...(parsed.data.outputSchema === undefined ? {} : { outputSchema: parsed.data.outputSchema }),
      ...(parsed.data.annotations === undefined ? {} : { annotations: parsed.data.annotations }),
    };
    // Validate descriptors before cloning: JSON catalog data cannot invoke
    // accessors or Proxy traps, and a cyclic fake connection must fail promptly.
    const ancestors = new Set<object>();
    const tasks: { value?: unknown; exit?: object; depth: number }[] = [{ value, depth: 0 }];
    while (tasks.length) {
      const task = tasks.pop()!;
      if (task.exit) {
        ancestors.delete(task.exit);
        continue;
      }
      const current = task.value;
      if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
      if (typeof current === 'number' && Number.isFinite(current)) continue;
      if (
        typeof current !== 'object' ||
        current === null ||
        types.isProxy(current) ||
        ancestors.has(current)
      )
        throw invalidDefinition(serverId);
      const array = Array.isArray(current);
      const prototype = Object.getPrototypeOf(current);
      if (
        array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
      )
        throw invalidDefinition(serverId);
      ancestors.add(current);
      tasks.push({ exit: current, depth: task.depth });
      const keys = Reflect.ownKeys(current);
      if (array && keys.length !== current.length + 1) throw invalidDefinition(serverId);
      for (const key of keys) {
        if (array && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
          throw invalidDefinition(serverId);
        tasks.push({ value: descriptor.value, depth: task.depth + 1 });
      }
    }
    const copy = {} as McpToolSnapshot;
    const copies = new Map<object, object>([[value, copy]]);
    const pending: { source: object; target: object }[] = [{ source: value, target: copy }];
    for (let index = 0; index < pending.length; index++) {
      const item = pending[index]!;
      for (const key of Object.keys(item.source)) {
        const child: unknown = Object.getOwnPropertyDescriptor(item.source, key)!.value;
        let cloned: unknown = child;
        if (typeof child === 'object' && child !== null) {
          cloned = copies.get(child);
          if (cloned === undefined) {
            cloned = Array.isArray(child) ? [] : {};
            copies.set(child, cloned as object);
            pending.push({ source: child, target: cloned as object });
          }
        }
        Object.defineProperty(item.target, key, {
          value: cloned,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      Object.freeze(item.target);
    }
    return copy;
  } catch {
    throw invalidDefinition(serverId);
  }
}

export function createMcpTool(
  options: McpPluginOptions,
  snapshot: McpToolSnapshot,
): ToolDefinition<Record<string, unknown>, string> {
  const resolved = parseMcpPluginOptions(options);
  const tool = copySnapshot(snapshot, resolved.serverId);
  const name = mcpToolName(resolved.serverId, tool.name);
  const redact = (text: string): string => redactMcpText(text, resolved.redactValues);
  // Zod 4.6.7 passthrough omits own __proto__ fields. Use its object guard and
  // refinement while validating and returning the original complete JSON value.
  const inputSchema = z.unknown().transform((value, context) => {
    let valid = false;
    try {
      valid = z
        .object({})
        .passthrough()
        .superRefine((_parsed, refinement) => {
          let matches = false;
          try {
            matches = resolved.connection.validateInput(tool.name, value).valid === true;
          } catch {
            /* A broken validator fails closed. */
          }
          if (!matches)
            refinement.addIssue({
              code: 'custom',
              message: 'MCP tool arguments do not match the declared schema.',
            });
        })
        .safeParse(value).success;
    } catch {
      /* Accessors and invalid host values fail closed. */
    }
    if (!valid) {
      context.addIssue({
        code: 'custom',
        message: 'MCP tool arguments do not match the declared schema.',
      });
      return z.NEVER;
    }
    return value as Record<string, unknown>;
  });
  return Object.freeze({
    name,
    description: redact(`${mcpDescriptionPrefix}${tool.description}`),
    trust: 'untrusted' as const,
    parameters: tool.inputSchema,
    inputSchema,
    readOnly: false,
    approval: Object.freeze({
      operation: 'mcp.call_tool',
      risk: 'high' as const,
      summarize: (input: Record<string, unknown>) => ({
        summary: redact(`Call MCP tool ${tool.name} on ${resolved.serverId}`),
        inputSummary: {
          serverId: redact(resolved.serverId),
          originalToolName: redact(tool.name),
          toolName: redact(name),
          cwd: redact(resolved.cwd),
          argumentBytes: Buffer.byteLength(JSON.stringify(input), 'utf8'),
          fields: Object.keys(input).map(redact),
        },
      }),
    }),
    async execute(input: Record<string, unknown>, context: ToolExecutionContext) {
      let result;
      try {
        result = await resolved.connection.callTool(tool.name, input, { signal: context.signal });
      } catch (error) {
        if (error instanceof McpClientError) throw new McpClientError(error.code);
        throw new McpClientError('mcp-call-failed');
      }
      return formatMcpResult(result, {
        serverId: resolved.serverId,
        toolName: tool.name,
        ...(resolved.redactValues === undefined ? {} : { redactValues: resolved.redactValues }),
      });
    },
  });
}
