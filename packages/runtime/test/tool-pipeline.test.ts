import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  type ToolDefinition,
} from '../src/index.js';

interface EchoInput {
  readonly text: string;
}

function createRegistry(
  execute: ToolDefinition<EchoInput, unknown>['execute'] = ({ text }) => text,
) {
  const registry = createToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Returns the input text',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
    inputSchema: z.object({ text: z.string() }),
    execute,
  });
  return registry;
}

function createProtectedRegistry(
  execute: ToolDefinition<{ value: string }, unknown>['execute'],
  summarize: ToolDefinition<{ value: string }, unknown>['approval'] extends {
    summarize: infer TSummarize;
  }
    ? TSummarize
    : never = ({ value }) => ({
    summary: `执行受保护操作 ${value}`,
    inputSummary: { value },
  }),
) {
  const registry = createToolRegistry();
  registry.register({
    name: 'protected',
    description: 'Protected test tool',
    parameters: { type: 'object' },
    inputSchema: z.object({ value: z.string() }),
    approval: {
      operation: 'test.protected',
      risk: 'high',
      summarize,
    },
    execute,
  });
  return registry;
}

describe('Tool Pipeline', () => {
  it('parses and validates arguments before invoking the tool', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text.toUpperCase());
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({
      toolCallId: 'call-1',
      name: 'echo',
      content: 'HELLO',
      truncated: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unknown tools and invalid JSON without invoking a handler', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({ toolCallId: 'call-1', name: 'missing', arguments: '{}' }),
    ).rejects.toMatchObject({ code: 'tool-not-found' });
    await expect(
      pipeline.execute({ toolCallId: 'call-2', name: 'echo', arguments: '{' }),
    ).rejects.toMatchObject({ code: 'tool-invalid-json' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before invoking a handler', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":42}',
      }),
    ).rejects.toMatchObject({ code: 'tool-invalid-arguments' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps an already aborted request to tool-cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'tool-cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a deadline to tool-timeout', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(
        (_input, { signal }) =>
          new Promise<string>((resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('', 'AbortError')), {
              once: true,
            });
          }),
      ),
      timeoutMs: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-timeout' });
  });

  it('does not invoke a tool when the timeout budget is zero', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      timeoutMs: 0,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-timeout' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves tool errors as causes', async () => {
    const cause = new Error('disk unavailable');
    const pipeline = createToolPipeline({
      registry: createRegistry(() => Promise.reject(cause)),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-execution-failed', cause });
  });

  it('limits UTF-8 output without splitting a multibyte character', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(() => '你好a'),
      maxResultBytes: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '你', truncated: true });
  });

  it('serializes structured results and marks undefined as empty content', async () => {
    const structured = createToolPipeline({
      registry: createRegistry(() => ({ ok: true })),
    });
    const empty = createToolPipeline({
      registry: createRegistry(() => undefined),
    });

    await expect(
      structured.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}', truncated: false });
    await expect(
      empty.execute({
        toolCallId: 'call-2',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '', truncated: false });
  });

  it('classifies circular results as serialization failures', async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const pipeline = createToolPipeline({
      registry: createRegistry(() => circular),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-result-serialization-failed' });
  });

  it('does not execute a protected tool before approval', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
    });

    const execution = pipeline.execute({
      toolCallId: 'call-protected-1',
      name: 'protected',
      arguments: '{"value":"x"}',
    });

    await Promise.resolve();
    expect(execute).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
    expect(broker.list()[0]).toMatchObject({
      status: 'pending',
      operation: 'test.protected',
      summary: '执行受保护操作 x',
      inputSummary: { value: 'x' },
    });

    broker.approve(broker.list()[0]!.approvalId, '用户确认');
    await expect(execution).resolves.toMatchObject({ content: 'done' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects a protected tool without invoking its implementation', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
    });

    const execution = pipeline.execute({
      toolCallId: 'call-protected-2',
      name: 'protected',
      arguments: '{"value":"x"}',
    });
    await Promise.resolve();
    broker.reject(broker.list()[0]!.approvalId, '需要人工复核');

    await expect(execution).rejects.toMatchObject({
      code: 'tool-approval-rejected',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps cancelled and expired approvals to stable pipeline errors', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
    });

    const cancelledExecution = pipeline.execute({
      toolCallId: 'call-protected-3',
      name: 'protected',
      arguments: '{"value":"cancelled"}',
    });
    await Promise.resolve();
    broker.cancel(broker.list()[0]!.approvalId, '调用方取消');
    await expect(cancelledExecution).rejects.toMatchObject({
      code: 'tool-approval-cancelled',
    });

    const expiredExecution = pipeline.execute({
      toolCallId: 'call-protected-4',
      name: 'protected',
      arguments: '{"value":"expired"}',
    });
    await Promise.resolve();
    broker.expire(broker.list()[1]!.approvalId, '审批已过期');
    await expect(expiredExecution).rejects.toMatchObject({
      code: 'tool-approval-expired',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reports a pipeline deadline reached while waiting for approval as expired', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
      timeoutMs: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-protected-deadline',
        name: 'protected',
        arguments: '{"value":"slow"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-approval-expired' });
    expect(execute).not.toHaveBeenCalled();
    expect(broker.list()[0]?.status).not.toBe('pending');
  });

  it('does not silently execute a protected tool without an Approval Broker', async () => {
    const execute = vi.fn(() => 'done');
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-protected-5',
        name: 'protected',
        arguments: '{"value":"x"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-approval-required' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('passes the effective timeout and combined signal to Approval', async () => {
    const summarize = vi.fn(({ value }: { value: string }) => ({
      summary: `执行受保护操作 ${value}`,
      inputSummary: { value },
    }));
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(
        vi.fn(() => 'done'),
        summarize,
      ),
      approvalBroker: broker,
      timeoutMs: 100,
    });
    const requestController = new AbortController();

    const execution = pipeline.execute({
      toolCallId: 'call-protected-6',
      name: 'protected',
      arguments: '{"value":"x"}',
      signal: requestController.signal,
      timeoutMs: 50,
    });

    await Promise.resolve();
    expect(summarize).toHaveBeenCalledWith({ value: 'x' });
    const pending = broker.list()[0]!;
    expect(pending.expiresAt).toBeDefined();
    expect(new Date(pending.expiresAt!).getTime() - new Date(pending.createdAt).getTime()).toBe(50);

    requestController.abort();
    await expect(execution).rejects.toMatchObject({
      code: 'tool-approval-cancelled',
    });
    expect(broker.get(pending.approvalId)?.status).toBe('cancelled');
  });
});
