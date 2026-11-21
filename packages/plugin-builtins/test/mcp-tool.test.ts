import { createHash } from 'node:crypto';
import type { McpConnection, McpToolSnapshot } from '@weave/mcp-client';
import {
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  type ToolPolicy,
} from '@weave/runtime';
import { describe, expect, it, vi } from 'vitest';
import { createMcpTool, mcpToolName } from '../src/mcp-tool.js';
import type { McpPluginOptions } from '../src/mcp-plugin.js';

const snapshot: McpToolSnapshot = Object.freeze({
  name: 'Remote.Read',
  description: 'Remote third-party tool',
  inputSchema: Object.freeze({
    type: 'object',
    properties: { count: { type: 'integer' } },
    required: ['count'],
  }),
  annotations: Object.freeze({ readOnlyHint: true }),
});
function fixture(policy?: ToolPolicy, extra: Partial<McpPluginOptions> = {}) {
  const calls: { name: string; input: Readonly<Record<string, unknown>>; signal: AbortSignal }[] =
    [];
  const connection: McpConnection = {
    tools: [snapshot],
    stderrBytes: 0,
    validateInput: (_name, input) => ({
      valid:
        typeof input === 'object' &&
        input !== null &&
        Number.isInteger((input as Record<string, unknown>).count),
    }),
    async callTool(name, input, { signal }) {
      calls.push({ name, input, signal });
      return { content: [{ type: 'text', text: 'done' }] };
    },
    async close() {},
  };
  const options: McpPluginOptions = {
    serverId: 'test',
    label: 'Test',
    cwd: '/fixed',
    connection,
    ...extra,
  };
  const tool = createMcpTool(options, snapshot);
  const registry = createToolRegistry();
  registry.register(tool);
  const broker = createApprovalBroker();
  const pipeline = createToolPipeline({
    registry,
    approvalBroker: broker,
    ...(policy ? { policy } : {}),
  });
  return { options, connection, tool, calls, broker, pipeline };
}

describe('MCP tool adapter', () => {
  it('maps raw names deterministically with a bounded readable slug and exact UTF-8 hash', () => {
    expect(mcpToolName('test', 'Remote.Read')).toBe(
      `mcp_test_remote_rea_${createHash('sha256').update('Remote.Read').digest('hex').slice(0, 16)}`,
    );
    expect(mcpToolName('test', '远程工具')).toMatch(/^mcp_test_tool_[a-f0-9]{16}$/);
    expect(mcpToolName('a'.repeat(24), 'x'.repeat(256))).toHaveLength(56);
    expect(mcpToolName('test', 'Remote.Read')).not.toBe(mcpToolName('test', 'remote.read'));
    expect(mcpToolName('test', 'Remote.Read')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it.each(['UPPER', 'a_b', '-a', 'a'.repeat(25), ''])('rejects invalid server id %s', (id) => {
    expect(() => mcpToolName(id, 'read')).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition' }),
    );
  });

  it.each(['ask', 'trust'] as const)(
    'requires shared approval in %s despite read-only annotations',
    async (permissionMode) => {
      const { tool, calls, broker, pipeline } = fixture();
      expect(tool).toMatchObject({
        readOnly: false,
        approval: { operation: 'mcp.call_tool', risk: 'high' },
      });
      const pending = pipeline.execute({
        toolCallId: 'call',
        name: tool.name,
        arguments: '{"count":1,"extra":"retained"}',
        permissionMode,
      });
      await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
      expect(calls).toHaveLength(0);
      expect(broker.list()[0]).toMatchObject({
        toolCallId: 'call',
        operation: 'mcp.call_tool',
        risk: 'high',
      });
      broker.approve(broker.list()[0]!.approvalId);
      expect((await pending).content).toContain('done');
      expect(calls[0]).toMatchObject({
        name: 'Remote.Read',
        input: { count: 1, extra: 'retained' },
        signal: expect.any(AbortSignal),
      });
    },
  );

  it('runs yolo through the shared pipeline without ordinary approval', async () => {
    const { tool, calls, broker, pipeline } = fixture();
    await pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: '{"count":1}',
      permissionMode: 'yolo',
    });
    expect(calls).toHaveLength(1);
    expect(broker.list()).toHaveLength(0);
  });

  it('keeps policy denial stricter than yolo', async () => {
    const { tool, calls, broker, pipeline } = fixture(() => 'deny');
    await expect(
      pipeline.execute({
        toolCallId: 'call',
        name: tool.name,
        arguments: '{"count":1}',
        permissionMode: 'yolo',
      }),
    ).rejects.toMatchObject({ code: 'tool-denied' });
    expect(calls).toHaveLength(0);
    expect(broker.list()).toHaveLength(0);
  });

  it('uses the existing approval broker when policy asks in yolo', async () => {
    const { tool, calls, broker, pipeline } = fixture(() => 'ask');
    const pending = pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: '{"count":1}',
      permissionMode: 'yolo',
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    expect(calls).toHaveLength(0);
    broker.approve(broker.list()[0]!.approvalId);
    await pending;
    expect(calls).toHaveLength(1);
  });

  it.each(['{"count":"1"}', '{"extra":1}', 'null', '[]'])(
    'rejects schema-invalid %s before approval and execution',
    async (args) => {
      const { tool, calls, broker, pipeline } = fixture();
      await expect(
        pipeline.execute({
          toolCallId: 'call',
          name: tool.name,
          arguments: args,
          permissionMode: 'ask',
        }),
      ).rejects.toMatchObject({ code: 'tool-invalid-arguments' });
      expect(calls).toHaveLength(0);
      expect(broker.list()).toHaveLength(0);
    },
  );

  it('summarizes only safe attribution, field names and argument bytes', async () => {
    const { tool, broker, pipeline } = fixture(undefined, {
      cwd: '/private/credential',
      redactValues: ['credential'],
    });
    const input = { count: 2, credential: 'value-must-not-be-copied', unicode: '界' };
    const pending = pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: JSON.stringify(input),
      permissionMode: 'ask',
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    const request = broker.list()[0]!;
    expect(request.inputSummary).toMatchObject({
      serverId: 'test',
      originalToolName: 'Remote.Read',
      toolName: tool.name,
      cwd: '/private/[REDACTED]',
      argumentBytes: Buffer.byteLength(JSON.stringify(input)),
      fields: ['count', '[REDACTED]', 'unicode'],
    });
    expect(JSON.stringify(request)).not.toContain('value-must-not-be-copied');
    expect(JSON.stringify(request)).not.toContain('credential');
    broker.reject(request.approvalId);
    await expect(pending).rejects.toMatchObject({ code: 'tool-approval-rejected' });
  });

  it('redacts displayed descriptions and names without changing protocol arguments', async () => {
    const { options, calls } = fixture(undefined, { redactValues: ['Remote'] });
    const tool = createMcpTool(options, { ...snapshot, description: 'Remote credentials' });
    expect(tool.description).not.toContain('Remote');
    const summary = await tool.approval!.summarize(
      { count: 1 },
      { signal: new AbortController().signal },
    );
    expect(JSON.stringify(summary)).not.toContain('Remote');
    await tool.execute({ count: 1 }, { signal: new AbortController().signal });
    expect(calls[0]?.name).toBe('Remote.Read');
  });

  it('converts validator exceptions to a safe schema issue', async () => {
    const { options, calls } = fixture();
    options.connection.validateInput = () => {
      throw new Error('private validator detail');
    };
    const tool = createMcpTool(options, snapshot);
    const parsed = tool.inputSchema.safeParse({ count: 1 });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('private validator detail');
    expect(calls).toHaveLength(0);
  });

  it('passes the pipeline cancellation signal to the original tool', async () => {
    const { tool, calls, pipeline } = fixture();
    const controller = new AbortController();
    await pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: '{"count":1}',
      permissionMode: 'yolo',
      signal: controller.signal,
    });
    controller.abort();
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it('preserves prototype-named JSON properties through validation and execution', async () => {
    const { tool, calls, pipeline } = fixture();
    await pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: '{"count":1,"__proto__":{"safe":true},"constructor":"literal"}',
      permissionMode: 'yolo',
    });
    expect(Object.hasOwn(calls[0]!.input, '__proto__')).toBe(true);
    expect(calls[0]!.input.__proto__).toEqual({ safe: true });
    expect(calls[0]!.input.constructor).toBe('literal');
  });

  it('retains the exact immutable parameter schema including prototype-named properties', () => {
    const { options } = fixture();
    const inputSchema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}',
    ) as Record<string, unknown>;
    const tool = createMcpTool(options, { ...snapshot, inputSchema });
    expect(tool.parameters).toEqual(inputSchema);
    expect(
      Object.hasOwn(
        (tool.parameters as Record<string, Record<string, unknown>>).properties!,
        '__proto__',
      ),
    ).toBe(true);
    expect(Object.isFrozen(tool.parameters)).toBe(true);
    expect(Object.isFrozen((tool.parameters as Record<string, unknown>).properties)).toBe(true);
  });

  it('validates required prototype-named fields against the original complete JSON object', async () => {
    const { options, calls } = fixture();
    options.connection.validateInput = (_name, input) => ({
      valid:
        typeof input === 'object' &&
        input !== null &&
        Object.hasOwn(input, '__proto__') &&
        (input as Record<string, unknown>).__proto__ === 'expected',
    });
    const tool = createMcpTool(options, {
      ...snapshot,
      inputSchema: JSON.parse(
        '{"type":"object","properties":{"__proto__":{"const":"expected"}},"required":["__proto__"],"additionalProperties":false}',
      ) as Record<string, unknown>,
    });
    const registry = createToolRegistry();
    registry.register(tool);
    const pipeline = createToolPipeline({ registry });
    await pipeline.execute({
      toolCallId: 'call',
      name: tool.name,
      arguments: '{"__proto__":"expected"}',
      permissionMode: 'yolo',
    });
    expect(calls[0]?.input).toEqual(JSON.parse('{"__proto__":"expected"}'));
    await expect(
      pipeline.execute({
        toolCallId: 'bad',
        name: tool.name,
        arguments: '{}',
        permissionMode: 'yolo',
      }),
    ).rejects.toMatchObject({ code: 'tool-invalid-arguments' });
    expect(calls).toHaveLength(1);
  });

  it('rejects cyclic snapshot schema instead of retaining a cyclic tool catalog', () => {
    const { options } = fixture();
    const schema: Record<string, unknown> = { type: 'object' };
    schema.default = schema;
    expect(() => createMcpTool(options, { ...snapshot, inputSchema: schema })).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition' }),
    );
  });

  it('maps transport failures to safe client errors without retaining arbitrary detail', async () => {
    const { options } = fixture();
    options.connection.callTool = async () => {
      throw new Error('private connection detail');
    };
    const tool = createMcpTool(options, snapshot);
    const error: unknown = await Promise.resolve(
      tool.execute({ count: 1 }, { signal: new AbortController().signal }),
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'mcp-call-failed', message: 'The MCP tool call failed.' });
    expect((error as Error).cause).toBeUndefined();
  });

  it('maps a throwing snapshot getter to a safe factory error', () => {
    const { options } = fixture();
    const invalid = { ...snapshot };
    Object.defineProperty(invalid, 'description', {
      get() {
        throw new Error('private snapshot detail');
      },
    });
    let caught: unknown;
    try {
      createMcpTool(options, invalid);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'plugin-invalid-definition',
      message: 'The MCP tool plugin definition is invalid.',
    });
    expect((caught as Error).cause).toBeUndefined();
  });
});
