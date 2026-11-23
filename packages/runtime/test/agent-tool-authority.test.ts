import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  agentTaskFactDigest,
  createInMemorySessionEventStore,
  type NewSessionEvent,
} from '@weave/session';
import { createLlmProviderRegistry, type LlmClient } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import {
  createAgentRunner,
  createAgentToolAuthority,
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  deriveAgentToolAuthority,
  describeAgentToolAuthority,
  readAgentToolAuthority,
  type AgentRunRequest,
  type AgentRuntimeEvent,
  type AgentToolAuthority,
  type RegisteredToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolPipeline,
} from '../src/index.js';

const root = {
  sessionId: 'parent',
  executionId: 'parent-execution',
  turnId: 'parent-turn',
  userMessageId: 'parent-message',
};
const child = {
  sessionId: '00000000-0000-4000-8000-000000000002',
  executionId: '00000000-0000-4000-8000-000000000003',
  turnId: '00000000-0000-4000-8000-000000000004',
  userMessageId: '00000000-0000-4000-8000-000000000005',
};
const taskId = '00000000-0000-4000-8000-000000000001';
const userMessage = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Test' }] };
const finish = { type: 'finish' as const, reason: 'stop' as const };

function callTool(name: string, id = 'call'): readonly StreamEvent[] {
  return [
    { type: 'tool-call-start', id, name },
    { type: 'tool-call-delta', id, argumentsDelta: '{"value":"first"}' },
    { type: 'finish', reason: 'tool-call' },
  ];
}

function provider(scripts: readonly (readonly StreamEvent[])[], requests: LlmRequest[] = []) {
  const client: LlmClient = {
    stream(request) {
      requests.push(request);
      const events = scripts[requests.length - 1];
      return (async function* () {
        if (events === undefined) throw new Error('Unexpected model request');
        yield* events;
      })();
    },
  };
  return client;
}

function input(identity = root, toolAuthority?: AgentToolAuthority): AgentRunRequest {
  const { sessionId, ...executionIdentity } = identity;
  return {
    sessionId,
    executionIdentity,
    toolAuthority,
    userMessage,
    provider: 'test-provider',
    model: 'test-model',
    temperature: 0.25,
    reasoningEffort: 'low',
    permissionMode: 'ask',
  };
}

async function drain(events: AsyncIterable<unknown>): Promise<void> {
  for await (const event of events) void event;
}

async function childStore(request: AgentRunRequest, accepted = true) {
  const store = createInMemorySessionEventStore();
  const events: NewSessionEvent[] = [
    { type: 'session.created', payload: {} },
    {
      type: 'agent.task.origin',
      payload: {
        version: 1,
        taskId,
        parentSessionId: root.sessionId,
        rootSessionId: root.sessionId,
        childSessionId: child.sessionId,
        childExecutionId: child.executionId,
        childTurnId: child.turnId,
        childUserMessageId: child.userMessageId,
        parentAcceptedSequence: 8,
        parentAcceptedDigest: 'a'.repeat(64),
        admissionClass: 'agent-task-once',
      },
    },
  ];
  if (accepted) {
    const { sessionId, toolAuthority: _authority, executionIdentity, ...input } = request;
    void _authority;
    expect(sessionId).toBe(child.sessionId);
    events.push(
      {
        type: 'execution.accepted',
        payload: {
          ...executionIdentity!,
          requestId: `agent-task:${taskId}`,
          requestDigest: agentTaskFactDigest(input),
          input,
          runInput: input,
          dispatch: 'queued',
        },
      },
      { type: 'execution.claimed', payload: { executionId: child.executionId } },
    );
  }
  await store.append(child.sessionId, events);
  return store;
}

function tool(
  name: string,
  readOnly: boolean,
  execute: (input: { value: string }, context: ToolExecutionContext) => unknown = () => 'ok',
) {
  return {
    name,
    description: name + ' description',
    parameters: { type: 'object', properties: { value: { type: 'string' } } },
    inputSchema: z.object({ value: z.string() }),
    readOnly,
    execute,
  };
}

function tools() {
  const registry = createToolRegistry();
  const ownerIds = new Map<RegisteredToolDefinition, string>();
  function register<T extends ReturnType<typeof tool>>(definition: T, ownerId = 'host') {
    registry.register(definition);
    ownerIds.set(registry.get(definition.name)!, ownerId);
    return definition;
  }
  return {
    registry,
    register,
    ownerIds,
    ownerOf: (definition: RegisteredToolDefinition) => ownerIds.get(definition),
  };
}

function runner(
  llm: LlmClient,
  registry: ReturnType<typeof createToolRegistry>,
  pipeline: ToolPipeline = createToolPipeline({ registry }),
  sessionStore = createInMemorySessionEventStore(),
) {
  return createAgentRunner({
    llm,
    sessionStore,
    toolRegistry: registry,
    toolPipeline: pipeline,
  });
}

describe('Agent tool authority', () => {
  it('refuses asynchronous root-only classifiers instead of treating them as unrestricted', () => {
    const fixtures = tools();
    fixtures.register(tool('save_memory', false));
    expect(() =>
      createAgentToolAuthority({
        identity: root,
        ...fixtures,
        rootOnlyTool: (() => Promise.resolve(true)) as unknown as (
          tool: RegisteredToolDefinition,
        ) => boolean,
      }),
    ).toThrow(TypeError);
  });

  it.each(['read-only', 'workspace'] as const)(
    'excludes captured root-only entries from %s children and their Provider tools',
    async (access) => {
      const fixtures = tools();
      fixtures.register(tool('search_memory', true));
      fixtures.register(tool('read_memory', true));
      // Mark a read-only declaration too: root authority must take precedence
      // over the generic workspace/readOnly inheritance rule.
      const save = fixtures.register(tool('save_memory', true));
      const remove = fixtures.register(tool('delete_memory', false));
      let childAuthority: AgentToolAuthority | undefined;
      fixtures.register(
        tool('agent_spawn', false, (_input, context) => {
          childAuthority = deriveAgentToolAuthority(context, { identity: child, access });
        }),
      );
      let classifyAsRootOnly = true;
      const token = createAgentToolAuthority({
        identity: root,
        ...fixtures,
        rootOnlyTool: (definition: RegisteredToolDefinition) =>
          classifyAsRootOnly && (definition === save || definition === remove),
      });
      // Classification belongs to the captured exact entry at mint time.
      classifyAsRootOnly = false;
      await drain(
        runner(provider([callTool('agent_spawn'), [finish]]), fixtures.registry).run(
          input(root, token),
        ),
      );
      expect(describeAgentToolAuthority(childAuthority!).tools.map(({ name }) => name)).toEqual([
        'search_memory',
        'read_memory',
      ]);
      const requests: LlmRequest[] = [];
      const childRequest = {
        ...input(child, childAuthority),
        ...describeAgentToolAuthority(childAuthority!).settings,
      };
      let instructionsTools: readonly string[] | undefined;
      let intercepted = false;
      const events = await Array.fromAsync(
        createAgentRunner({
          llm: provider([callTool('save_memory'), [finish]], requests),
          sessionStore: await childStore(childRequest),
          toolRegistry: fixtures.registry,
          toolPipeline: createToolPipeline({
            registry: fixtures.registry,
            around: async (request, next) => {
              intercepted = true;
              return next(request);
            },
          }),
          instructions: (request) => {
            instructionsTools = request.tools?.map(({ name }) => name);
            return 'Authorized child instructions';
          },
        }).run(childRequest),
      );
      expect(instructionsTools).toEqual(['search_memory', 'read_memory']);
      expect(intercepted).toBe(false);
      expect(
        requests.every((request) =>
          request.tools?.every(({ name }) => name !== 'save_memory' && name !== 'delete_memory'),
        ),
      ).toBe(true);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          status: 'failed',
          errorCode: 'tool-not-permitted',
        }),
      );
    },
  );

  it('rejects forged run tokens and an exact token bound to another run', async () => {
    const fixtures = tools();
    const requests: LlmRequest[] = [];
    const instance = runner(provider([[finish]], requests), fixtures.registry);
    const token = createAgentToolAuthority({ identity: root, ...fixtures });

    for (const unauthorized of [
      input(root, {} as AgentToolAuthority),
      input(root, structuredClone(token)),
      input(child, token),
      input({ ...root, executionId: 'stolen' }, token),
      input({ ...root, turnId: 'stolen' }, token),
    ]) {
      await expect(drain(instance.run(unauthorized))).rejects.toBeDefined();
    }
    expect(requests).toHaveLength(0);
    await drain(instance.run(input(root, token)));
    await expect(drain(instance.run(input(root, token)))).rejects.toBeDefined();
    expect(requests).toHaveLength(1);
  });

  it('derives exact child tool subsets and inherits effective settings without clients', async () => {
    const fixtures = tools();
    fixtures.register(tool('read_file', true));
    fixtures.register(tool('write_file', false));
    fixtures.register(tool('edit_file', false));
    fixtures.register(tool('run_command', false));
    fixtures.register(tool('agent_status', true));
    fixtures.register(tool('agent_wait', true));
    fixtures.register(tool('agent_cancel', false));
    let parentContext: ToolExecutionContext | undefined;
    let readOnly: AgentToolAuthority | undefined;
    let workspace: AgentToolAuthority | undefined;
    fixtures.register(
      tool('agent_spawn', false, (_input, context) => {
        parentContext = context;
        expect(readAgentToolAuthority(context)).toMatchObject({
          identity: root,
          settings: {
            provider: 'test-provider',
            model: 'test-model',
            temperature: 0.25,
            maxTokens: 321,
            reasoningEffort: 'low',
            permissionMode: 'ask',
            useProviderDefaults: false,
          },
          toolCallId: 'call',
        });
        expect(() => readAgentToolAuthority({ ...context })).toThrow();
        readOnly = deriveAgentToolAuthority(context, { identity: child, access: 'read-only' });
        workspace = deriveAgentToolAuthority(context, { identity: child, access: 'workspace' });
        return 'ok';
      }),
    );
    const token = createAgentToolAuthority({ identity: root, ...fixtures });
    const registry = fixtures.registry;
    const instance = createAgentRunner({
      llmRegistry: createLlmProviderRegistry([
        {
          id: 'test-provider',
          label: 'Provider',
          type: 'mock',
          maxTokens: 321,
          client: provider([callTool('agent_spawn'), [finish]]),
        },
      ]),
      sessionStore: createInMemorySessionEventStore(),
      toolRegistry: registry,
      toolPipeline: createToolPipeline({ registry }),
    });
    await drain(instance.run(input(root, token)));

    expect(() =>
      deriveAgentToolAuthority(parentContext!, { identity: child, access: 'workspace' }),
    ).toThrow();
    expect(describeAgentToolAuthority(readOnly!).tools.map((entry) => entry.name)).toEqual([
      'read_file',
    ]);
    expect(describeAgentToolAuthority(workspace!).tools.map((entry) => entry.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'run_command',
    ]);
    const requests: LlmRequest[] = [];
    const childRequest = {
      ...input(child, readOnly),
      ...describeAgentToolAuthority(readOnly!).settings,
    };
    const store = await childStore(childRequest);
    await drain(
      runner(provider([[finish]], requests), registry, undefined, store).run(childRequest),
    );
    expect(requests[0]?.tools?.map((entry) => entry.name)).toEqual(['read_file']);
    expect(requests[0]?.maxTokens).toBe(321);
  });

  it('rejects direct execution of a task origin even with its exact claimed identity', async () => {
    const fixtures = tools();
    const requests: LlmRequest[] = [];
    const request = { ...input(child), useProviderDefaults: false };
    const wrongAuthority = createAgentToolAuthority({ identity: child, ...fixtures });
    const store = await childStore(request);
    const original = await store.read(child.sessionId);
    const instance = runner(provider([[finish]], requests), fixtures.registry, undefined, store);
    await expect(drain(instance.run(request))).rejects.toBeDefined();
    await expect(
      drain(instance.run({ ...request, toolAuthority: wrongAuthority })),
    ).rejects.toBeDefined();
    expect(await store.read(child.sessionId)).toEqual(original);
    expect(requests).toEqual([]);
  });

  it('caps an authorized child at fifty model steps in a Generation configured for one hundred', async () => {
    const fixtures = tools();
    let childAuthority: AgentToolAuthority | undefined;
    fixtures.register(tool('read_file', true));
    fixtures.register(
      tool('agent_spawn', false, (_input, context) => {
        childAuthority = deriveAgentToolAuthority(context, {
          identity: child,
          access: 'read-only',
        });
      }),
    );
    const rootAuthority = createAgentToolAuthority({ identity: root, ...fixtures });
    await drain(
      runner(provider([callTool('agent_spawn'), [finish]]), fixtures.registry).run(
        input(root, rootAuthority),
      ),
    );
    const childRequest = {
      ...input(child, childAuthority),
      ...describeAgentToolAuthority(childAuthority!).settings,
    };
    const store = await childStore(childRequest);
    let requests = 0;
    const instance = createAgentRunner({
      llm: {
        async *stream() {
          requests += 1;
          for (const event of callTool('read_file')) {
            yield event.type === 'tool-call-start' || event.type === 'tool-call-delta'
              ? { ...event, id: `call-${requests}` }
              : event;
          }
        },
      },
      sessionStore: store,
      toolRegistry: fixtures.registry,
      toolPipeline: createToolPipeline({ registry: fixtures.registry }),
      maxSteps: 100,
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of instance.run(childRequest)) events.push(event);
    expect(requests).toBe(50);
    expect(events.at(-1)).toMatchObject({ type: 'completed', reason: 'agent-step-limit' });
  });

  it('rejects a middleware-synthesized child call even if an around hook could answer it', async () => {
    const fixtures = tools();
    let childAuthority: AgentToolAuthority | undefined;
    let called = false;
    fixtures.register(
      tool('run_command', false, () => {
        called = true;
      }),
    );
    fixtures.register(
      tool('agent_spawn', false, (_input, context) => {
        childAuthority = deriveAgentToolAuthority(context, {
          identity: child,
          access: 'read-only',
        });
        return 'accepted';
      }),
    );
    const token = createAgentToolAuthority({ identity: root, ...fixtures });
    await drain(
      runner(provider([callTool('agent_spawn'), [finish]]), fixtures.registry).run(
        input(root, token),
      ),
    );
    const events: AgentRuntimeEvent[] = [];
    const requests: LlmRequest[] = [];
    const childRequest = {
      ...input(child, childAuthority),
      ...describeAgentToolAuthority(childAuthority!).settings,
    };
    const instance = createAgentRunner({
      llm: provider([[finish]], requests),
      sessionStore: await childStore(childRequest),
      toolRegistry: fixtures.registry,
      toolPipeline: createToolPipeline({
        registry: fixtures.registry,
        around: async (request) => {
          called = true;
          return {
            toolCallId: request.toolCallId,
            name: request.name,
            content: 'synthetic',
            truncated: false,
          };
        },
      }),
      llmMiddleware: async function* () {
        if (events.length === 1) yield* callTool('run_command');
        else yield finish;
      },
    });
    for await (const event of instance.run(childRequest)) events.push(event);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        status: 'failed',
        errorCode: 'tool-not-permitted',
      }),
    );
    expect(called).toBe(false);
    expect(requests).toHaveLength(0);
  });

  it('reports an absent tool on the root Turn and denies it on the child Turn', async () => {
    const fixtures = tools();
    let childAuthority: AgentToolAuthority | undefined;
    fixtures.register(
      tool('agent_spawn', false, (_input, context) => {
        childAuthority = deriveAgentToolAuthority(context, {
          identity: child,
          access: 'read-only',
        });
        return 'accepted';
      }),
    );
    const registry = fixtures.registry;
    const intercepted: string[] = [];
    const pipeline = createToolPipeline({
      registry,
      around: async (request, next) => {
        intercepted.push(request.name);
        return next(request);
      },
    });
    const rootAuthority = createAgentToolAuthority({ identity: root, ...fixtures });
    const rootEvents = await Array.fromAsync(
      runner(
        provider([callTool('agent_spawn'), callTool('missing_tool', 'missing'), [finish]]),
        registry,
        pipeline,
      ).run(input(root, rootAuthority)),
    );
    const childRequest = {
      ...input(child, childAuthority),
      ...describeAgentToolAuthority(childAuthority!).settings,
    };
    const childEvents = await Array.fromAsync(
      runner(
        provider([callTool('missing_tool'), [finish]]),
        registry,
        pipeline,
        await childStore(childRequest),
      ).run(childRequest),
    );

    expect(intercepted).toEqual(['agent_spawn']);
    expect(childEvents).toContainEqual(
      expect.objectContaining({ type: 'tool-result', errorCode: 'tool-not-permitted' }),
    );
    expect(rootEvents).toContainEqual(
      expect.objectContaining({ type: 'tool-result', errorCode: 'tool-not-found' }),
    );
  });

  it('rejects tool calls outside the bound active invocation before policy or execution', async () => {
    const fixtures = tools();
    let effects = 0;
    fixtures.register(tool('read_file', true, () => ++effects));
    fixtures.register(tool('run_command', false, () => ++effects));
    const unauthorized: unknown[] = [];
    const pipeline = createToolPipeline({
      registry: fixtures.registry,
      policy: () => {
        effects += 1;
        return 'abstain';
      },
    });
    const token = createAgentToolAuthority({ identity: root, ...fixtures });
    const wrapped: ToolPipeline = {
      async execute(request) {
        for (const changes of [
          { toolAuthority: {} as AgentToolAuthority },
          { sessionId: child.sessionId },
          { executionId: child.executionId },
          { turnId: child.turnId },
          { toolCallId: 'stolen' },
          { name: 'run_command' },
          { name: 'missing_tool' },
          { permissionMode: 'yolo' as const },
          { signal: new AbortController().signal },
        ]) {
          try {
            await pipeline.execute({ ...request, ...changes });
          } catch (error: unknown) {
            unauthorized.push(error);
          }
        }
        return pipeline.execute(request);
      },
    };
    await drain(
      runner(provider([callTool('read_file'), [finish]]), fixtures.registry, wrapped).run(
        input(root, token),
      ),
    );
    expect(unauthorized).toHaveLength(9);
    expect(effects).toBe(2);
  });

  it.each(['definition', 'owner', 'nested schema'] as const)(
    'rejects a changed registry %s before executing the matching name',
    async (changed) => {
      const fixtures = tools();
      let executes = 0;
      const original = fixtures.register(tool('read_file', true, () => ++executes));
      const token = createAgentToolAuthority({ identity: root, ...fixtures });
      const pipeline = createToolPipeline({ registry: fixtures.registry });
      let failure: unknown;
      const checked: ToolPipeline = {
        async execute(request) {
          if (changed === 'definition') {
            const foreign = tools();
            foreign.register(tool('read_file', true, () => ++executes));
            failure = await createToolPipeline({ registry: foreign.registry })
              .execute(request)
              .catch((error) => error);
          } else {
            if (changed === 'owner')
              fixtures.ownerIds.set(fixtures.registry.get('read_file')!, 'wrong');
            else original.parameters.properties.value.type = 'number';
            failure = await pipeline.execute(request).catch((error) => error);
          }
          throw failure;
        },
      };
      await drain(
        runner(provider([callTool('read_file'), [finish]]), fixtures.registry, checked).run(
          input(root, token),
        ),
      );
      expect(failure).toMatchObject({ code: 'tool-not-permitted' });
      expect(executes).toBe(0);
    },
  );

  it('keeps around retries within the bound invocation and gives each its own approval', async () => {
    const fixtures = tools();
    const values: string[] = [];
    const broker = createApprovalBroker();
    const approvals: unknown[] = [];
    broker.subscribe(({ type, request }) => {
      if (type !== 'approval.created') return;
      approvals.push(request);
      queueMicrotask(() => broker.approve(request.approvalId));
    });
    fixtures.register({
      ...tool('protected', false, ({ value }) => values.push(value)),
      approval: {
        operation: 'tests.protected',
        risk: 'medium' as const,
        summarize: ({ value }: { value: string }) => ({
          summary: value,
          inputSummary: { executionId: 'forged' },
        }),
      },
    });
    const token = createAgentToolAuthority({ identity: root, ...fixtures });
    const another = createAgentToolAuthority({ identity: root, ...fixtures });
    const pipeline = createToolPipeline({
      registry: fixtures.registry,
      approvalBroker: broker,
      around: async (request, next) => {
        const changes: Partial<ToolExecutionRequest>[] = [
          { toolAuthority: another },
          { toolAuthority: undefined },
          { sessionId: child.sessionId },
          { executionId: child.executionId },
          { turnId: child.turnId },
          { signal: new AbortController().signal },
          { permissionMode: 'yolo' },
          { toolCallId: 'different' },
          { name: 'different' },
        ];
        for (const changed of changes) {
          let observed: unknown;
          try {
            await next({ ...request, ...changed });
          } catch (error: unknown) {
            observed = error;
          }
          expect(observed).toMatchObject({ code: 'tool-invalid-input' });
        }
        await next(request);
        return next({ ...request, arguments: '{"value":"second"}' });
      },
    });
    await drain(
      runner(provider([callTool('protected'), [finish]]), fixtures.registry, pipeline).run(
        input(root, token),
      ),
    );
    expect(values).toEqual(['first', 'second']);
    expect(approvals).toMatchObject([
      {
        sessionId: 'parent',
        executionId: 'parent-execution',
        turnId: 'parent-turn',
        toolCallId: 'call',
        summary: 'first',
      },
      {
        sessionId: 'parent',
        executionId: 'parent-execution',
        turnId: 'parent-turn',
        toolCallId: 'call',
        summary: 'second',
      },
    ]);

    const forged = {
      toolCallId: 'call',
      toolName: 'protected',
      operation: 'tests.protected',
      summary: 'direct',
      risk: 'medium' as const,
      inputSummary: {},
      sessionId: root.sessionId,
      turnId: root.turnId,
      executionId: root.executionId,
    };
    await broker.request(forged);
    expect(approvals[2]).not.toHaveProperty('executionId');
    expect(approvals[2]).not.toHaveProperty('turnId');
  });

  it.each(['before-policy', 'after-summary', 'after-approval', 'expired-run'] as const)(
    'fails closed at the %s checkpoint',
    async (boundary) => {
      const fixtures = tools();
      const broker = createApprovalBroker();
      const stages: string[] = [];
      let fence = boundary !== 'before-policy';
      let live = true;
      fixtures.register({
        ...tool('protected', false, () => stages.push('execute')),
        approval: {
          operation: 'tests.protected',
          risk: 'medium' as const,
          summarize: async () => {
            stages.push('summary');
            if (boundary === 'after-summary') fence = false;
            return { summary: 'test', inputSummary: {} };
          },
        },
      });
      const authority = createAgentToolAuthority({
        identity: root,
        ...fixtures,
        isLive: () => live,
        checkpoint: async () => {
          stages.push('checkpoint');
          if (!fence) throw new Error('Workspace authority changed');
        },
      });
      broker.subscribe(({ type, request }) => {
        if (type !== 'approval.created') return;
        stages.push('approval');
        if (boundary === 'after-approval') fence = false;
        if (boundary === 'expired-run') live = false;
        queueMicrotask(() => broker.approve(request.approvalId));
      });
      const pipeline = createToolPipeline({
        registry: fixtures.registry,
        approvalBroker: broker,
        policy: () => {
          stages.push('policy');
          return 'abstain';
        },
      });
      const scripts =
        boundary === 'expired-run' ? [callTool('protected')] : [callTool('protected'), [finish]];
      const events: AgentRuntimeEvent[] = [];
      const execution = (async () => {
        for await (const event of runner(provider(scripts), fixtures.registry, pipeline).run(
          input(root, authority),
        )) {
          events.push(event);
        }
      })();
      if (boundary === 'expired-run')
        await expect(execution).rejects.toMatchObject({ code: 'agent-stream-protocol' });
      else await execution;
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'tool-result',
          status: 'failed',
          errorCode: 'tool-not-permitted',
        }),
      );
      expect(stages).not.toContain('execute');
      if (boundary === 'before-policy') expect(stages).not.toContain('policy');
      if (boundary === 'after-summary') expect(stages).not.toContain('approval');
      if (boundary === 'after-approval' || boundary === 'expired-run')
        expect(stages).toContain('approval');
    },
  );
});
