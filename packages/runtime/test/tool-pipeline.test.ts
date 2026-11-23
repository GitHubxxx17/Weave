import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ToolExecutionError,
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  type ToolAround,
  type ToolDefinition,
  type ToolPolicy,
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
    expect(summarize).toHaveBeenCalledWith(
      { value: 'x' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const pending = broker.list()[0]!;
    expect(pending.expiresAt).toBeDefined();
    expect(new Date(pending.expiresAt!).getTime() - new Date(pending.createdAt).getTime()).toBe(50);

    requestController.abort();
    await expect(execution).rejects.toMatchObject({
      code: 'tool-approval-cancelled',
    });
    expect(broker.get(pending.approvalId)?.status).toBe('cancelled');
  });

  it('awaits an asynchronous summary and fails before Approval when it throws', async () => {
    const broker = createApprovalBroker();
    const execute = vi.fn(() => 'done');
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute, async ({ value }, context) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (value === 'bad') {
          throw Object.assign(new Error('Text not found'), { code: 'workspace-edit-no-match' });
        }
        return { summary: `异步摘要 ${value} ${context.sessionId ?? ''}`, inputSummary: {} };
      }),
      approvalBroker: broker,
    });

    await expect(
      pipeline.execute({ toolCallId: 'call-bad', name: 'protected', arguments: '{"value":"bad"}' }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-edit-no-match' }),
    });
    expect(broker.list()).toEqual([]);

    const execution = pipeline.execute({
      toolCallId: 'call-good',
      name: 'protected',
      arguments: '{"value":"good"}',
      sessionId: 'session-1',
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));
    expect(broker.list()[0]?.summary).toBe('异步摘要 good session-1');
    broker.approve(broker.list()[0]!.approvalId);
    await expect(execution).resolves.toMatchObject({ content: 'done' });
  });

  it('gates Approval by permission mode', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
    });

    // trust: an unknown-operation protected tool stays conservative and asks.
    const trusting = pipeline.execute({
      toolCallId: 'call-trust',
      name: 'protected',
      arguments: '{"value":"x"}',
      permissionMode: 'trust',
    });
    await Promise.resolve();
    expect(broker.list()).toHaveLength(1);
    broker.approve(broker.list()[0]!.approvalId);
    await expect(trusting).resolves.toMatchObject({ content: 'done' });

    // yolo: no Approval, runs directly.
    const yoloExecute = vi.fn(() => 'done');
    const yoloBroker = createApprovalBroker();
    const yoloPipeline = createToolPipeline({
      registry: createProtectedRegistry(yoloExecute),
      approvalBroker: yoloBroker,
    });
    await expect(
      yoloPipeline.execute({
        toolCallId: 'call-yolo',
        name: 'protected',
        arguments: '{"value":"x"}',
        permissionMode: 'yolo',
      }),
    ).resolves.toMatchObject({ content: 'done' });
    expect(yoloBroker.list()).toEqual([]);
    expect(yoloExecute).toHaveBeenCalledOnce();
  });

  it('tells the model when a result was truncated', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(() => 'a'.repeat(500)),
      maxResultBytes: 200,
    });

    const result = await pipeline.execute({
      toolCallId: 'call-1',
      name: 'echo',
      arguments: '{"text":"x"}',
    });

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(200);
    expect(result.content).toMatch(/\[结果超过 200 字节，后面的内容已截断\]$/);
  });
});

describe('Tool Pipeline around middleware', () => {
  const request = { toolCallId: 'call-1', name: 'echo', arguments: '{"text":"hi"}' };

  it('behaves as before without a middleware', async () => {
    const pipeline = createToolPipeline({ registry: createRegistry() });

    await expect(pipeline.execute(request)).resolves.toEqual({
      toolCallId: 'call-1',
      name: 'echo',
      content: 'hi',
      truncated: false,
    });
  });

  it('runs the middleware around the execution and lets it shape the result', async () => {
    const seen: string[] = [];
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async (incoming, next) => {
        seen.push(`before ${incoming.name}`);
        const result = await next(incoming);
        seen.push('after');
        return { ...result, content: `${result.content}!` };
      },
    });

    await expect(pipeline.execute(request)).resolves.toMatchObject({ content: 'hi!' });
    expect(seen).toEqual(['before echo', 'after']);
  });

  it('lets the middleware answer without calling the tool', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      around: async (incoming) => ({
        toolCallId: incoming.toolCallId,
        name: incoming.name,
        content: 'cached',
        truncated: false,
      }),
    });

    await expect(pipeline.execute(request)).resolves.toMatchObject({ content: 'cached' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('lets the middleware retry a failed execution', async () => {
    let calls = 0;
    const execute = vi.fn(({ text }: EchoInput) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('flaky');
      }
      return text;
    });
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      around: async (incoming, next) => {
        try {
          return await next(incoming);
        } catch {
          return next(incoming);
        }
      },
    });

    await expect(pipeline.execute(request)).resolves.toMatchObject({ content: 'hi' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('validates the request before the middleware sees it', async () => {
    const around = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(), around });

    await expect(
      pipeline.execute({ toolCallId: '', name: 'echo', arguments: '{}' }),
    ).rejects.toMatchObject({ code: 'tool-invalid-input' });
    expect(around).not.toHaveBeenCalled();
  });

  it('still validates the arguments a middleware adjusted', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      around: (incoming, next) => next({ ...incoming, arguments: '{"text":1}' }),
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-invalid-arguments',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks for approval of the arguments the middleware adjusted, not the original ones', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
      around: (incoming, next) => next({ ...incoming, arguments: '{"value":"changed"}' }),
    });

    const result = pipeline.execute({
      toolCallId: 'call-1',
      name: 'protected',
      arguments: '{"value":"original"}',
    });
    await vi.waitFor(() => expect(broker.list()).toHaveLength(1));

    expect(broker.list()[0]?.inputSummary).toEqual({ value: 'changed' });
    expect(execute).not.toHaveBeenCalled();
    broker.approve(broker.list()[0]!.approvalId);
    await expect(result).resolves.toMatchObject({ content: 'done' });
  });

  it('asks for approval again when the middleware retries a protected tool', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
      around: async (incoming, next) => {
        await next(incoming);
        return next(incoming);
      },
    });

    const result = pipeline.execute({
      toolCallId: 'call-1',
      name: 'protected',
      arguments: '{"value":"x"}',
    });
    const pending = () => broker.list().filter((approval) => approval.status === 'pending');
    for (let approvals = 0; approvals < 2; approvals += 1) {
      await vi.waitFor(() => expect(pending()).toHaveLength(1));
      broker.approve(pending()[0]!.approvalId);
      await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(approvals + 1));
    }

    await expect(result).resolves.toMatchObject({ content: 'done' });
    expect(broker.list()).toHaveLength(2);
  });

  it('rejects a result that belongs to another call', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async (incoming, next) => ({ ...(await next(incoming)), toolCallId: 'other-call' }),
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-execution-failed',
      message: expect.stringContaining('invalid result'),
    });
  });

  it('rejects a middleware that returns something other than a result', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: (async () => 'not a result') as unknown as ToolAround,
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-execution-failed',
    });
  });

  it('limits the content a middleware returns to the byte limit', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      maxResultBytes: 200,
      around: async (incoming, next) => ({
        ...(await next(incoming)),
        content: 'a'.repeat(500),
      }),
    });

    const result = await pipeline.execute(request);

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content, 'utf8')).toBeLessThanOrEqual(200);
  });

  it('lets nothing beyond the four result fields through', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async (incoming, next) => ({
        ...(await next(incoming)),
        secret: 'smuggled',
      }),
    });

    expect(Object.keys(await pipeline.execute(request)).sort()).toEqual([
      'content',
      'name',
      'toolCallId',
      'truncated',
    ]);
  });

  it('keeps the stable code of an error the middleware raises on purpose', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async () => {
        throw new ToolExecutionError('tool-not-permitted', 'blocked by policy');
      },
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-not-permitted',
    });
  });

  it('turns an unexpected middleware crash into a tool failure', async () => {
    const cause = new Error('bug in the middleware');
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async () => {
        throw cause;
      },
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause,
    });
  });

  it('reports a crash after the caller aborted as a cancellation', async () => {
    const controller = new AbortController();
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      around: async () => {
        controller.abort();
        throw new Error('stopped');
      },
    });

    await expect(pipeline.execute({ ...request, signal: controller.signal })).rejects.toMatchObject(
      { code: 'tool-cancelled' },
    );
  });

  it.each(['returns', 'throws', 'cancels'] as const)(
    'drains detached attempts when around middleware %s',
    async (outcome) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const abort = new AbortController();
      let executes = 0;
      let detached: Promise<unknown> | undefined;
      let lateNext: (() => Promise<unknown>) | undefined;
      const pipeline = createToolPipeline({
        registry: createRegistry(async () => {
          executes += 1;
          entered.resolve();
          await release.promise;
          return 'executed';
        }),
        around: async (incoming, next) => {
          lateNext = async () => next(incoming);
          detached = next(incoming).catch((error: unknown) => error);
          await entered.promise;
          if (outcome === 'throws') throw new Error('around failure');
          return {
            toolCallId: incoming.toolCallId,
            name: incoming.name,
            content: 'synthetic',
            truncated: false,
          };
        },
      });
      let settled = false;
      const result = pipeline
        .execute({ ...request, signal: abort.signal })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      try {
        await entered.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (outcome === 'cancels') abort.abort();
        expect(settled).toBe(false);
        await expect(lateNext!()).rejects.toMatchObject({ code: 'tool-invalid-input' });
      } finally {
        release.resolve();
        await result;
        await detached;
      }
      expect(executes).toBe(1);
      expect(await result).toMatchObject(
        outcome === 'throws'
          ? { code: 'tool-execution-failed' }
          : outcome === 'cancels'
            ? { code: 'tool-cancelled' }
            : { content: 'synthetic' },
      );
    },
  );
});

describe('Tool Pipeline policy', () => {
  const request = { toolCallId: 'call-1', name: 'echo', arguments: '{"text":"hi"}' };
  const protectedRequest = {
    toolCallId: 'call-1',
    name: 'protected',
    arguments: '{"value":"x"}',
  };

  function pendingApprovals(broker: ReturnType<typeof createApprovalBroker>) {
    return broker.list().filter((approval) => approval.status === 'pending');
  }

  it('leaves the usual flow alone when the policy abstains', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const policy = vi.fn(() => 'abstain' as const);
    const pipeline = createToolPipeline({ registry: createRegistry(execute), policy });

    await expect(pipeline.execute(request)).resolves.toMatchObject({ content: 'hi' });
    expect(policy).toHaveBeenCalledWith(expect.objectContaining(request));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('stops a denied call before the tool runs and before any Approval', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
      policy: () => 'deny',
    });

    await expect(pipeline.execute(protectedRequest)).rejects.toMatchObject({
      code: 'tool-denied',
      message: 'Tool "protected" was denied by a policy',
    });
    expect(execute).not.toHaveBeenCalled();
    expect(broker.list()).toEqual([]);
  });

  it('requires Approval for a tool that has none of its own when the policy asks', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      approvalBroker: broker,
      policy: () => 'ask',
    });

    const result = pipeline.execute(request);
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));

    expect(execute).not.toHaveBeenCalled();
    expect(pendingApprovals(broker)[0]).toMatchObject({
      toolName: 'echo',
      operation: 'plugin.policy',
      risk: 'medium',
      inputSummary: { tool: 'echo', arguments: '{"text":"hi"}' },
    });
    broker.approve(pendingApprovals(broker)[0]!.approvalId);
    await expect(result).resolves.toMatchObject({ content: 'hi' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('does not run a tool whose policy-required Approval is rejected', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      approvalBroker: broker,
      policy: () => 'ask',
    });

    const result = pipeline.execute(request);
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));
    broker.reject(pendingApprovals(broker)[0]!.approvalId);

    await expect(result).rejects.toMatchObject({ code: 'tool-approval-rejected' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('asks even in yolo mode, using the Approval the tool itself describes', async () => {
    const execute = vi.fn(() => 'done');
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(execute),
      approvalBroker: broker,
      policy: () => 'ask',
    });

    const result = pipeline.execute({ ...protectedRequest, permissionMode: 'yolo' });
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));

    expect(execute).not.toHaveBeenCalled();
    expect(pendingApprovals(broker)[0]).toMatchObject({
      operation: 'test.protected',
      risk: 'high',
      summary: '执行受保护操作 x',
    });
    broker.approve(pendingApprovals(broker)[0]!.approvalId);
    await expect(result).resolves.toMatchObject({ content: 'done' });
  });

  it('asks in yolo mode for a tool that has no Approval of its own', async () => {
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      approvalBroker: broker,
      policy: () => 'ask',
    });

    const result = pipeline.execute({ ...request, permissionMode: 'yolo' });
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));
    broker.approve(pendingApprovals(broker)[0]!.approvalId);

    await expect(result).resolves.toMatchObject({ content: 'hi' });
  });

  it('does not let an abstaining policy relax the permission mode', async () => {
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createProtectedRegistry(() => 'done'),
      approvalBroker: broker,
      policy: () => 'abstain',
    });

    const result = pipeline.execute(protectedRequest);
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));
    broker.approve(pendingApprovals(broker)[0]!.approvalId);

    await expect(result).resolves.toMatchObject({ content: 'done' });
  });

  it('refuses to run an asked call when there is no Approval Broker', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      policy: () => 'ask',
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-approval-required',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('shortens very long arguments in the Approval it creates', async () => {
    const broker = createApprovalBroker();
    const pipeline = createToolPipeline({
      registry: createRegistry(),
      approvalBroker: broker,
      policy: () => 'ask',
    });
    const longText = 'a'.repeat(5_000);

    const result = pipeline.execute({
      ...request,
      arguments: JSON.stringify({ text: longText }),
    });
    await vi.waitFor(() => expect(pendingApprovals(broker)).toHaveLength(1));

    const summary = pendingApprovals(broker)[0]?.inputSummary as { arguments: string };
    expect(summary.arguments.length).toBeLessThan(1_100);
    expect(summary.arguments.endsWith('…')).toBe(true);
    broker.cancel(pendingApprovals(broker)[0]!.approvalId);
    await expect(result).rejects.toMatchObject({ code: 'tool-approval-cancelled' });
  });

  it('waits for an asynchronous policy', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      policy: async () => {
        await Promise.resolve();
        return 'deny' as const;
      },
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({ code: 'tool-denied' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies when the policy throws, and keeps the cause', async () => {
    const cause = new Error('policy bug');
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      policy: () => {
        throw cause;
      },
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({
      code: 'tool-denied',
      message: 'Tool "echo" was denied because a policy could not decide',
      cause,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('denies when the policy answers with something that is not a vote, such as allow', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      policy: (() => 'allow') as unknown as ToolPolicy,
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({ code: 'tool-denied' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('only consults the policy for a call that is well formed', async () => {
    const policy = vi.fn(() => 'abstain' as const);
    const pipeline = createToolPipeline({ registry: createRegistry(), policy });

    await expect(pipeline.execute({ ...request, name: 'missing' })).rejects.toMatchObject({
      code: 'tool-not-found',
    });
    await expect(pipeline.execute({ ...request, arguments: '{' })).rejects.toMatchObject({
      code: 'tool-invalid-json',
    });
    await expect(pipeline.execute({ ...request, arguments: '{"text":1}' })).rejects.toMatchObject({
      code: 'tool-invalid-arguments',
    });
    expect(policy).not.toHaveBeenCalled();
  });

  it('ends the call at its deadline when a policy never answers', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      timeoutMs: 20,
      policy: () => new Promise<never>(() => undefined),
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({ code: 'tool-timeout' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('ends the call when the caller cancels while a policy has not answered', async () => {
    const controller = new AbortController();
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      policy: () => new Promise<never>(() => undefined),
    });

    const result = pipeline.execute({ ...request, signal: controller.signal });
    controller.abort();

    await expect(result).rejects.toMatchObject({ code: 'tool-cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('judges the request a middleware adjusted, so a middleware cannot get around it', async () => {
    const seen: string[] = [];
    const execute = vi.fn(({ text }: EchoInput) => text);
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      around: (incoming, next) => next({ ...incoming, arguments: '{"text":"changed"}' }),
      policy: (incoming) => {
        seen.push(incoming.arguments);
        return incoming.arguments.includes('changed') ? 'deny' : 'abstain';
      },
    });

    await expect(pipeline.execute(request)).rejects.toMatchObject({ code: 'tool-denied' });
    expect(seen).toEqual(['{"text":"changed"}']);
    expect(execute).not.toHaveBeenCalled();
  });
});
