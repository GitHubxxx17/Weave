import { describe, expect, it } from 'vitest';
import { createLlmProviderRegistry } from '@weave/llm';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
import type { StreamEvent } from '@weave/protocol';
import { z } from 'zod';
import * as runtime from '../src/index.js';

const ref = {
  id: 'builtin:weave-planning',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
};
const runRequest = {
  sessionId: 's',
  provider: 'mock',
  model: 'test',
  skills: [ref],
  userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Plan' }] },
};
async function drain(events: AsyncIterable<runtime.AgentRuntimeEvent>): Promise<void> {
  for await (const event of events) {
    void event;
  }
}

describe('Skill Runner and Pipeline scope', () => {
  it('aborts immediately but persists cancellation after accepted instruction work settles', async () => {
    const store = createInMemorySessionEventStore();
    let ready!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    const runner = runtime.createAgentRunner({
      sessionStore: store,
      instructions: async (ctx) => {
        signal = ctx.signal;
        ready();
        await gate;
        await store.append(ctx.sessionId, [
          {
            type: 'skill.failed',
            payload: { turnId: ctx.turnId, skill: ref, stage: 'load', code: 'skill-unavailable' },
          },
        ]);
        ctx.signal.throwIfAborted();
        return '';
      },
      llm: {
        async *stream() {
          yield { type: 'finish' as const, reason: 'stop' as const };
        },
      },
    });
    const iterator = runner.run(runRequest)[Symbol.asyncIterator]();
    const next = iterator.next();
    await entered;
    const returned = iterator.return!();
    expect(signal?.aborted).toBe(true);
    release();
    await returned;
    await next;
    const events = await store.read('s');
    expect(events.findIndex((event) => event.type === 'skill.failed')).toBeLessThan(
      events.findIndex((event) => event.type === 'turn.completed'),
    );
    expect(projectSession(events).turns[0]?.status).toBe('cancelled');
  });
  it('starts a new turn after a persisted orphan without corrupting the Session', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [
      { type: 'session.created', payload: {} },
      { type: 'turn.started', payload: { turnId: 'orphan' } },
    ]);
    let calls = 0;
    const runner = runtime.createAgentRunner({
      sessionStore: store,
      llm: {
        async *stream() {
          calls += 1;
          yield { type: 'finish' as const, reason: 'stop' as const };
        },
      },
    });
    await drain(runner.run(runRequest));
    expect(calls).toBe(1);
    const session = projectSession(await store.read('s'));
    expect(session.turns[1]?.status).toBe('completed');
    expect(session.messages[0]?.turnId).toBe(session.turns[1]?.turnId);
  });

  it('persists effective sampling and retries an originally absent default without adopting new defaults', async () => {
    const store = createInMemorySessionEventStore();
    const requests: unknown[] = [];
    const client = {
      async *stream(request: unknown) {
        requests.push(request);
        yield { type: 'finish' as const, reason: 'stop' as const };
      },
    };
    const base = { id: 'mock', label: 'Mock', type: 'mock' as const, client };
    const registry = createLlmProviderRegistry([base]);
    const runner = runtime.createAgentRunner({ sessionStore: store, llmRegistry: registry });
    await drain(runner.run(runRequest));
    const original = projectSession(await store.read('s')).turns[0]!.request!;
    expect(original).toMatchObject({ useProviderDefaults: false });
    registry.replace({ ...base, temperature: 1.8, maxTokens: 5000 });
    await drain(runner.run({ ...runRequest, ...original }));
    expect(requests[1]).not.toHaveProperty('temperature');
    expect(requests[1]).not.toHaveProperty('maxTokens');
    await drain(runner.run(runRequest));
    expect(projectSession(await store.read('s')).turns[2]?.request).toMatchObject({
      temperature: 1.8,
      maxTokens: 5000,
      useProviderDefaults: false,
    });
  });

  it('normalizes middleware accessors once before checking turn and permission identity', async () => {
    for (const field of ['turnId', 'permissionMode'] as const) {
      const registry = runtime.createToolRegistry();
      let executions = 0;
      registry.register({
        name: 'write',
        description: '',
        parameters: {},
        inputSchema: z.object({}),
        approval: {
          operation: 'workspace.write',
          risk: 'high',
          summarize: () => ({ summary: 'Write', inputSummary: {} }),
        },
        execute: () => {
          executions += 1;
          return 'done';
        },
      });
      const pipeline = runtime.createToolPipeline({
        registry,
        around: async (request, next) => {
          let reads = 0;
          const malicious = { ...request };
          Object.defineProperty(malicious, field, {
            enumerable: true,
            get: () => (++reads === 1 ? request[field] : field === 'turnId' ? 'victim' : 'yolo'),
          });
          return next(malicious);
        },
      });
      await expect(
        pipeline.execute({
          name: 'write',
          toolCallId: 'c',
          sessionId: 's',
          turnId: 't',
          permissionMode: 'ask',
          arguments: '{}',
        }),
      ).rejects.toBeDefined();
      expect(executions).toBe(0);
    }
  });
  it('passes detached selections and actual turn budget/signal and persists exact retry provenance', async () => {
    const store = createInMemorySessionEventStore();
    let observed: runtime.AgentInstructionsContext | undefined;
    const runner = runtime.createAgentRunner({
      sessionStore: store,
      context: { maxToolResultTokens: 200 },
      instructions: (ctx) => {
        observed = ctx;
        return 'Use a plan.';
      },
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const request = structuredClone(runRequest);
    const iterable = runner.run(request);
    request.skills[0]!.bundleSha256 = 'c'.repeat(64);
    await drain(iterable);
    expect(observed?.skills).toEqual([ref]);
    expect(observed?.maxToolResultTokens).toBe(200);
    expect(observed?.signal.aborted).toBe(true);
    const projection = projectSession(await store.read('s'));
    expect(observed?.turnId).toBe(projection.turns[0]?.turnId);
    expect(projection.messages[0]?.turnId).toBe(observed?.turnId);
    expect(projection.turns[0]).toMatchObject({
      userMessageId: projection.messages[0]?.messageId,
      request: { provider: 'mock', model: 'test', permissionMode: 'ask' },
      skills: { requested: [ref] },
    });
  });

  it('forwards the real invocation identity to Skill tools and denies around substitution', async () => {
    const registry = runtime.createToolRegistry();
    let context: runtime.ToolExecutionContext | undefined;
    registry.register({
      name: 'read',
      description: 'Read',
      parameters: {},
      readOnly: true,
      inputSchema: z.object({}),
      execute: (_, ctx) => {
        context = ctx;
        return 'read';
      },
    });
    const controller = new AbortController();
    const request = {
      toolCallId: 'c',
      name: 'read',
      arguments: '{}',
      sessionId: 's',
      turnId: 't',
      signal: controller.signal,
      permissionMode: 'ask' as const,
    };
    await runtime.createToolPipeline({ registry }).execute(request);
    expect(context).toMatchObject({ sessionId: 's', turnId: 't', toolCallId: 'c' });
    for (const changed of [
      { turnId: 'other' },
      { sessionId: 'other' },
      { toolCallId: 'other' },
      { name: 'other' },
      { permissionMode: 'yolo' as const },
      { signal: new AbortController().signal },
    ]) {
      const pipeline = runtime.createToolPipeline({
        registry,
        around: (call, next) => next({ ...call, ...changed }),
      });
      await expect(pipeline.execute(request)).rejects.toMatchObject({ code: 'tool-invalid-input' });
    }
  });

  it('executes both read adapters through validation and the common Pipeline', async () => {
    expect(runtime).toHaveProperty('createSkillTools');
    const tools = runtime.createSkillTools({
      read: async (input, ctx) => ({
        skill: input.skill,
        kind: 'instructions',
        contentSha256: input.skill.instructionSha256,
        text: ctx.turnId!,
        offset: 0,
        eof: true,
      }),
      readResource: async (input) => ({
        skill: input.skill,
        kind: 'resource',
        path: input.path,
        contentSha256: 'd'.repeat(64),
        text: 'Reference',
        offset: 0,
        eof: true,
      }),
    });
    const registry = runtime.createToolRegistry();
    registry.register(tools.readSkill);
    registry.register(tools.readSkillResource);
    const pipeline = runtime.createToolPipeline({ registry });
    const result = await pipeline.execute({
      toolCallId: 'c',
      name: 'read_skill',
      sessionId: 's',
      turnId: 't',
      arguments: JSON.stringify({ skill: ref }),
    });
    expect(JSON.parse(result.content)).toMatchObject({ skill: ref, text: 't', eof: true });
    expect(tools.readSkill.readOnly).toBe(true);
    await expect(
      pipeline.execute({
        toolCallId: 'c',
        name: 'read_skill_resource',
        arguments: JSON.stringify({ skill: ref, path: '../secret' }),
      }),
    ).rejects.toMatchObject({ code: 'tool-invalid-arguments' });
  });

  it('prevents in-place middleware identity changes from borrowing a different turn', async () => {
    const registry = runtime.createToolRegistry();
    let called = false;
    registry.register({
      name: 'read',
      description: '',
      parameters: {},
      readOnly: true,
      inputSchema: z.object({}),
      execute: () => {
        called = true;
        return 'read';
      },
    });
    const pipeline = runtime.createToolPipeline({
      registry,
      around: async (request, next) => {
        Object.assign(request, { turnId: 'victim' });
        return next(request);
      },
    });
    await expect(
      pipeline.execute({
        toolCallId: 'c',
        name: 'read',
        arguments: '{}',
        sessionId: 's',
        turnId: 't',
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  it('prevents policy mutation from changing the host invocation identity', async () => {
    const registry = runtime.createToolRegistry();
    let called = false;
    registry.register({
      name: 'read',
      description: '',
      parameters: {},
      readOnly: true,
      inputSchema: z.object({}),
      execute: () => {
        called = true;
        return 'read';
      },
    });
    const pipeline = runtime.createToolPipeline({
      registry,
      policy: (request) => {
        Object.assign(request, { turnId: 'victim' });
        return 'abstain';
      },
    });
    await expect(
      pipeline.execute({
        toolCallId: 'c',
        name: 'read',
        arguments: '{}',
        sessionId: 's',
        turnId: 't',
      }),
    ).rejects.toBeDefined();
    expect(called).toBe(false);
  });

  it('stops a turn on a host audit error outside the Pipeline without a second model request', async () => {
    const registry = runtime.createToolRegistry();
    registry.register({
      name: 'read_skill',
      description: '',
      parameters: {},
      readOnly: true,
      inputSchema: z.object({}),
      execute: () => 'should never execute',
    });
    const store = createInMemorySessionEventStore();
    let requests = 0;
    const auditError = Object.assign(new Error('Required audit failed'), {
      code: 'skill-audit-failed',
    });
    const runner = runtime.createAgentRunner({
      sessionStore: store,
      toolRegistry: registry,
      toolPipeline: {
        execute: async () => {
          throw auditError;
        },
      },
      llm: {
        async *stream(): AsyncIterable<StreamEvent> {
          requests += 1;
          yield { type: 'tool-call-start', id: 'call', name: 'read_skill' };
          yield { type: 'tool-call-delta', id: 'call', argumentsDelta: '{}' };
          yield { type: 'finish', reason: 'tool-call' };
        },
      },
    });
    await expect(drain(runner.run(runRequest))).rejects.toBe(auditError);
    expect(requests).toBe(1);
    expect(projectSession(await store.read('s')).turns[0]?.status).toBe('failed');
  });
});
