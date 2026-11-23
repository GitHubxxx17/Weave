import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  activateAgentToolAuthority,
  createAgentToolAuthority,
  readAgentToolAuthority,
  withAgentToolInvocation,
} from '../src/agent-tool-authority.js';
import { createApprovalBroker } from '../src/approval-broker.js';
import { MemoryError } from '../src/memory-errors.js';
import {
  bindMemoryWritePreview,
  configureMemoryToolDefinition,
  consumeMemoryWriteAttempt,
  memoryCallerAuthority,
  readMemoryAgentToolAuthority,
} from '../src/memory-tool-attempt.js';
import { createToolPipeline, type ToolPipelineOptions } from '../src/tool-pipeline.js';
import { createToolRegistry } from '../src/tool-registry.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionRequest,
} from '../src/tool-types.js';

const identity = {
  sessionId: 'root',
  executionId: 'execution',
  turnId: 'turn',
  userMessageId: 'message',
};
const settings = {
  provider: 'test',
  model: 'test',
  permissionMode: 'ask' as const,
  useProviderDefaults: false as const,
};
type Input = { value: string };
type Intent = { readonly value: string; readonly target: { readonly revision: number } };

function fixture(
  options: {
    summarize?: (input: Input, context: ToolExecutionContext) => Promise<Intent>;
    execute?: (input: Input, context: ToolExecutionContext) => unknown;
    classify?: boolean;
    shutdown?: AbortSignal;
  } = {},
) {
  const summaries: ToolExecutionContext[] = [];
  const executions: ToolExecutionContext[] = [];
  const written: string[] = [];
  const registry = createToolRegistry();
  const tool: ToolDefinition<Input, unknown> = {
    name: 'save_memory',
    description: 'Host memory',
    parameters: { type: 'object' },
    inputSchema: z.object({ value: z.string() }),
    readOnly: false,
    approval: {
      operation: 'memory.save',
      risk: 'high',
      summarize(input, context) {
        summaries.push(context);
        expect(() => readAgentToolAuthority(context)).toThrow();
        return bindMemoryWritePreview<Intent>(context, async (caller, operation) => {
          expect(operation).toBe('memory.save');
          expect(memoryCallerAuthority(caller)).toBe(token);
          const intent =
            options.summarize === undefined
              ? { value: input.value, target: { revision: 1 } }
              : await options.summarize(input, context);
          return { intent, summary: { summary: input.value, inputSummary: intent } };
        });
      },
    },
    execute(input, context) {
      executions.push(context);
      if (options.execute !== undefined) return options.execute(input, context);
      const attempt = consumeMemoryWriteAttempt<Intent>(context);
      attempt.assertLiveSync();
      expect(memoryCallerAuthority(attempt.caller)).toBe(token);
      expect(() => consumeMemoryWriteAttempt(context)).toThrow();
      expect(() => consumeMemoryWriteAttempt({ ...context })).toThrow();
      if (attempt.kind === 'approved') {
        expect(Object.isFrozen(attempt.intent)).toBe(true);
        expect(Object.isFrozen(attempt.intent.target)).toBe(true);
        written.push(attempt.intent.value);
      } else written.push(input.value);
      return written.at(-1);
    },
  };
  if (options.classify !== false)
    configureMemoryToolDefinition(tool, {
      classification: 'root-write',
      operation: 'memory.save',
      signal: options.shutdown,
    });
  registry.register(tool);
  const token = createAgentToolAuthority({
    identity,
    registry,
    ownerOf: () => 'host',
    rootOnlyTool: (definition) => definition === tool,
  });
  const runSignal = new AbortController().signal;
  const deactivate = activateAgentToolAuthority(
    {
      sessionId: identity.sessionId,
      executionIdentity: identity,
      toolAuthority: token,
      userMessage: { role: 'user', content: [{ type: 'text', text: 'save' }] },
    },
    registry,
    settings,
    runSignal,
  )!;
  const request: ToolExecutionRequest = {
    ...identity,
    toolAuthority: token,
    toolCallId: 'call',
    name: tool.name,
    arguments: '{"value":"initial"}',
    signal: runSignal,
    permissionMode: 'ask',
  };
  const pipeline = (overrides: Partial<ToolPipelineOptions> = {}) =>
    createToolPipeline({
      registry,
      allowHostToolContext: (definition) => definition === tool,
      ...overrides,
    });
  const invoke = (
    overrides: Partial<ToolPipelineOptions> = {},
    changes: Partial<ToolExecutionRequest> = {},
  ) => {
    const invocation = { ...request, ...changes };
    return withAgentToolInvocation(invocation, () => pipeline(overrides).execute(invocation));
  };
  return {
    tool,
    registry,
    token,
    request,
    pipeline,
    invoke,
    deactivate,
    summaries,
    executions,
    written,
  };
}

describe('exact host Memory Pipeline attempts', () => {
  it('rejects approval metadata changed by policy before showing a request or writing', async () => {
    const f = fixture();
    const broker = createApprovalBroker();
    broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') broker.approve(request.approvalId);
    });
    await expect(
      f.invoke({
        approvalBroker: broker,
        policy: () => {
          Object.assign(f.tool.approval!, { operation: 'plugin.policy', risk: 'low' });
          return 'abstain';
        },
      }),
    ).rejects.toThrow();
    expect(broker.list()).toHaveLength(0);
    expect(f.written).toEqual([]);
    f.deactivate();
  });
  it('denies exact Memory definitions without live authority before around or policy', async () => {
    const f = fixture();
    let intercepted = 0;
    const pipeline = f.pipeline({
      around: async (request, next) => {
        intercepted++;
        return next(request);
      },
      policy: () => {
        intercepted++;
        return 'abstain';
      },
    });
    await expect(
      pipeline.execute({
        toolCallId: 'forged',
        name: 'save_memory',
        arguments: '{"value":"forged"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-not-permitted' });
    expect(intercepted).toBe(0);
    expect(f.executions).toHaveLength(0);
    f.deactivate();
  });

  it.each(['ask', 'trust'] as const)(
    'binds one exact approved preview in %s mode',
    async (permissionMode) => {
      const f = fixture();
      const broker = createApprovalBroker();
      let approvals = 0;
      broker.subscribe(({ type, request }) => {
        if (type !== 'approval.created') return;
        approvals++;
        broker.approve(request.approvalId);
      });
      await expect(f.invoke({ approvalBroker: broker }, { permissionMode })).resolves.toMatchObject(
        { content: 'initial' },
      );
      expect(approvals).toBe(1);
      expect(f.written).toEqual(['initial']);
      expect(() => consumeMemoryWriteAttempt(f.summaries[0]!)).toThrow();
      expect(() => consumeMemoryWriteAttempt(f.executions[0]!)).toThrow();
      f.deactivate();
    },
  );

  it('gives concurrent around.next attempts distinct previews and approvals', async () => {
    const f = fixture();
    const broker = createApprovalBroker();
    const approvals: { id: string; summary: string }[] = [];
    let ready!: () => void;
    const bothReady = new Promise<void>((resolve) => {
      ready = resolve;
    });
    broker.subscribe(({ type, request }) => {
      if (type !== 'approval.created') return;
      approvals.push({ id: request.approvalId, summary: request.summary });
      if (approvals.length === 2) ready();
    });
    const result = f.invoke({
      approvalBroker: broker,
      around: async (request, next) => {
        const a = next({ ...request, arguments: '{"value":"A"}' });
        const b = next({ ...request, arguments: '{"value":"B"}' });
        await bothReady;
        broker.approve(approvals.find(({ summary }) => summary === 'B')!.id);
        const bResult = await b;
        broker.approve(approvals.find(({ summary }) => summary === 'A')!.id);
        await a;
        return bResult;
      },
    });
    await expect(result).resolves.toMatchObject({ content: 'B' });
    expect(f.written).toEqual(['B', 'A']);
    expect(f.summaries[0]).not.toBe(f.summaries[1]);
    expect(f.executions[0]).not.toBe(f.executions[1]);
    f.deactivate();
  });

  it('runs automatic yolo writes without a preview and lets policy ask require one', async () => {
    const f = fixture();
    await f.invoke({}, { permissionMode: 'yolo' });
    expect(f.summaries).toHaveLength(0);
    const broker = createApprovalBroker();
    broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') broker.approve(request.approvalId);
    });
    await f.invoke({ policy: () => 'ask', approvalBroker: broker }, { permissionMode: 'yolo' });
    expect(f.summaries).toHaveLength(1);
    expect(f.written).toEqual(['initial', 'initial']);
    f.deactivate();
  });

  it('never previews a policy denial and never consumes rejected or brokerless attempts', async () => {
    const f = fixture();
    await expect(
      f.invoke({ policy: () => 'deny' }, { permissionMode: 'yolo' }),
    ).rejects.toMatchObject({ code: 'tool-denied' });
    await expect(f.invoke()).rejects.toMatchObject({ code: 'tool-approval-required' });
    expect(f.summaries).toHaveLength(0);
    const broker = createApprovalBroker();
    broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') broker.reject(request.approvalId);
    });
    await expect(f.invoke({ approvalBroker: broker })).rejects.toMatchObject({
      code: 'tool-approval-rejected',
    });
    expect(f.written).toEqual([]);
    f.deactivate();
  });

  it('cancels pending Memory Approval on its private shutdown signal', async () => {
    const shutdown = new AbortController();
    const f = fixture({ shutdown: shutdown.signal });
    const broker = createApprovalBroker();
    broker.subscribe(({ type }) => {
      if (type === 'approval.created') shutdown.abort();
    });
    await expect(f.invoke({ approvalBroker: broker })).rejects.toMatchObject({
      code: 'tool-approval-cancelled',
    });
    expect(f.written).toEqual([]);
    expect(broker.list()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    f.deactivate();
  });

  it('does not grant classification to a different definition with the same name', async () => {
    const f = fixture();
    const registry = createToolRegistry();
    registry.register({ ...f.tool, execute: () => 'plugin' });
    await expect(
      createToolPipeline({ registry }).execute({
        toolCallId: 'plugin',
        name: 'save_memory',
        arguments: '{"value":"plugin"}',
        permissionMode: 'yolo',
      }),
    ).resolves.toMatchObject({ content: 'plugin' });
    f.deactivate();
  });

  it.each(['summary', 'execute'] as const)(
    'preserves only safe host Memory errors from %s',
    async (phase) => {
      const failure = () => {
        throw new MemoryError('memory-disabled');
      };
      const f = fixture(phase === 'summary' ? { summarize: failure } : { execute: failure });
      const broker = createApprovalBroker();
      broker.subscribe(({ type, request }) => {
        if (type === 'approval.created') broker.approve(request.approvalId);
      });
      await expect(f.invoke({ approvalBroker: broker })).rejects.toMatchObject({
        code: 'memory-disabled',
      });
      const plugin = fixture({ classify: false, execute: failure });
      await expect(plugin.invoke({}, { permissionMode: 'yolo' })).rejects.toMatchObject({
        code: 'tool-execution-failed',
      });
      f.deactivate();
      plugin.deactivate();
    },
  );

  it('keeps caller authority exact and live for Memory reads', async () => {
    let savedCaller: ReturnType<typeof readMemoryAgentToolAuthority> | undefined;
    const f = fixture({
      execute: (_input, context) => {
        savedCaller = readMemoryAgentToolAuthority(context);
        expect(memoryCallerAuthority(savedCaller)).toBe(f.token);
        expect(() => memoryCallerAuthority({ ...savedCaller! })).toThrow();
        expect(() => readMemoryAgentToolAuthority({ ...context })).toThrow();
        return 'read';
      },
    });
    await f.invoke({}, { permissionMode: 'yolo' });
    expect(() => memoryCallerAuthority(savedCaller!)).toThrow();
    f.deactivate();
  });

  it('rejects copied summary contexts and cannot bind the same preview twice', async () => {
    const f = fixture({
      summarize: async (input, context) => {
        expect(() => consumeMemoryWriteAttempt(context)).toThrow();
        await expect(
          bindMemoryWritePreview({ ...context }, async () => ({
            intent: {},
            summary: { summary: 'copied', inputSummary: {} },
          })),
        ).rejects.toMatchObject({ code: 'tool-not-permitted' });
        await expect(
          bindMemoryWritePreview(context, async () => ({
            intent: {},
            summary: { summary: 'second', inputSummary: {} },
          })),
        ).rejects.toMatchObject({ code: 'tool-not-permitted' });
        return { value: input.value, target: { revision: 1 } };
      },
    });
    const broker = createApprovalBroker();
    broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') broker.approve(request.approvalId);
    });
    await f.invoke({ approvalBroker: broker });
    expect(f.written).toEqual(['initial']);
    f.deactivate();
  });

  it('keeps consumed sync authority valid only during its own exact execute lifetime', async () => {
    let assertLiveSync: (() => void) | undefined;
    const f = fixture({
      execute: (_input, context) => {
        const attempt = consumeMemoryWriteAttempt(context);
        assertLiveSync = attempt.assertLiveSync;
        attempt.assertLiveSync();
        return 'ok';
      },
    });
    await f.invoke({}, { permissionMode: 'yolo' });
    expect(() => assertLiveSync!()).toThrow();
    f.deactivate();
  });

  it('does not pass through forged safe error codes or unsafe host error text', async () => {
    const f = fixture({
      execute: () => {
        throw Object.assign(new Error('secret SQL and body'), { code: 'memory-disabled' });
      },
    });
    const error = await f.invoke({}, { permissionMode: 'yolo' }).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'tool-execution-failed',
      message: 'Tool "save_memory" failed',
    });
    expect(error).not.toHaveProperty('cause');
    f.deactivate();
  });

  it('requires explicit host-context admission even with the exact live run token', async () => {
    const f = fixture();
    let around = false;
    await expect(
      f.invoke(
        {
          allowHostToolContext: () => false,
          around: async (request, next) => {
            around = true;
            return next(request);
          },
        },
        { permissionMode: 'yolo' },
      ),
    ).rejects.toMatchObject({ code: 'tool-not-permitted' });
    expect(around).toBe(false);
    f.deactivate();
  });

  it('rejects invalid Memory error codes before they can become a safe host error', () => {
    expect(() => new MemoryError('secret' as 'memory-disabled')).toThrow(TypeError);
  });

  it('never turns a classified Memory write automatic in trust mode after metadata changes', async () => {
    const f = fixture();
    Object.assign(f.tool.approval!, { operation: 'workspace.write_file' });
    await expect(f.invoke({}, { permissionMode: 'trust' })).rejects.toMatchObject({
      code: 'tool-not-permitted',
    });
    expect(f.written).toEqual([]);
    f.deactivate();
  });
});
