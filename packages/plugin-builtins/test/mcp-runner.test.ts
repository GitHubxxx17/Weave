import type { LlmClient } from '@weave/llm';
import type { McpConnection } from '@weave/mcp-client';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createPluginKernel, toolRegistryRef } from '@weave/plugin';
import { createAgentRunner, createToolPipeline, type AgentRuntimeEvent } from '@weave/runtime';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
import { describe, expect, it, vi } from 'vitest';
import { createMcpPlugin, createToolRegistryPlugin } from '../src/index.js';

describe('MCP through the Agent Runner', () => {
  it('persists a failed MCP result, lets the model correct arguments and completes', async () => {
    const secret = 'private-environment-value';
    const callTool = vi
      .fn<McpConnection['callTool']>()
      .mockResolvedValueOnce({
        isError: true,
        content: [{ type: 'text', text: `Use a positive value. ${secret}` }],
      })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'Corrected result' }] });
    const close = vi.fn(async () => {});
    const connection: McpConnection = {
      tools: [
        {
          name: 'calculate',
          description: 'Calculate a value',
          inputSchema: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] },
        },
      ],
      stderrBytes: 0,
      validateInput: (name, value) => ({
        valid:
          name === 'calculate' &&
          typeof value === 'object' &&
          value !== null &&
          'x' in value &&
          Number.isInteger(value.x),
      }),
      callTool,
      close,
    };
    const kernel = createPluginKernel();
    const store = createInMemorySessionEventStore();
    try {
      await kernel.register(createToolRegistryPlugin());
      await kernel.register(
        createMcpPlugin({
          serverId: 'calculator',
          label: 'Calculator',
          cwd: '/workspace',
          connection,
          redactValues: [secret],
        }),
      );
      const generation = await kernel.seal();
      const registry = await generation.resolve(toolRegistryRef);
      const toolName = registry.list()[0]!.name;
      const scripts: StreamEvent[][] = [
        [
          { type: 'tool-call-start', id: 'call-1', name: toolName },
          { type: 'tool-call-delta', id: 'call-1', argumentsDelta: '{"x":-1}' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [
          { type: 'tool-call-start', id: 'call-2', name: toolName },
          { type: 'tool-call-delta', id: 'call-2', argumentsDelta: '{"x":1}' },
          { type: 'finish', reason: 'tool-call' },
        ],
        [
          { type: 'text-delta', text: '已完成计算' },
          { type: 'finish', reason: 'stop' },
        ],
      ];
      const requests: LlmRequest[] = [];
      const llm: LlmClient = {
        async *stream(request) {
          requests.push(structuredClone(request));
          const script = scripts.shift();
          if (!script) throw new Error('Unexpected model request');
          yield* script;
        },
      };
      const runner = createAgentRunner({
        llm,
        sessionStore: store,
        toolRegistry: registry,
        toolPipeline: createToolPipeline({ registry }),
      });
      const events: AgentRuntimeEvent[] = [];
      for await (const event of runner.run({
        sessionId: 'mcp-session',
        provider: 'mock',
        model: 'test',
        permissionMode: 'yolo',
        userMessage: { role: 'user', content: [{ type: 'text', text: '计算' }] },
      }))
        events.push(event);

      expect(callTool.mock.calls.map(([name, input]) => [name, input])).toEqual([
        ['calculate', { x: -1 }],
        ['calculate', { x: 1 }],
      ]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          status: 'failed',
          errorCode: 'tool-execution-failed',
          result: expect.objectContaining({
            toolCallId: 'call-1',
            content: expect.stringContaining('mcp-tool-error:'),
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          result: expect.objectContaining({ toolCallId: 'call-2' }),
        }),
      );
      expect(events.at(-1)).toMatchObject({ type: 'completed' });
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(requests[1]?.messages.at(-1)).toMatchObject({
        role: 'tool',
        toolCallId: 'call-1',
        content: [expect.objectContaining({ text: expect.stringContaining('mcp-tool-error:') })],
      });
      expect(requests[2]?.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'call-2' });
      const persisted = await store.read('mcp-session');
      expect(persisted).toContainEqual(
        expect.objectContaining({
          type: 'tool-result.created',
          payload: expect.objectContaining({
            toolCallId: 'call-1',
            status: 'failed',
            errorCode: 'tool-execution-failed',
          }),
        }),
      );
      expect(projectSession(persisted).turns[0]).toMatchObject({
        status: 'completed',
        steps: [
          { kind: 'model', status: 'completed' },
          { kind: 'tool', status: 'failed' },
          { kind: 'model', status: 'completed' },
          { kind: 'tool', status: 'completed' },
          { kind: 'model', status: 'completed' },
        ],
        toolResults: [
          { toolCallId: 'call-1', status: 'failed' },
          { toolCallId: 'call-2', status: 'completed' },
        ],
      });
    } finally {
      await kernel.dispose();
      await store.close();
    }
    expect(close).not.toHaveBeenCalled();
  });
});
