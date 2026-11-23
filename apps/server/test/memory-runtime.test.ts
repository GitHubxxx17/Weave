import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSqliteMemoryStore } from '@weave/memory';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { createInMemorySessionEventStore } from '@weave/session';
import {
  createAgentRunner,
  createAgentToolAuthority,
  createApprovalBroker,
  createMemoryService,
  createMemoryTools,
  createToolPipeline,
  createToolRegistry,
  type AgentRuntimeEvent,
  type MemoryServiceOptions,
  type ToolPipelineOptions,
} from '@weave/runtime';
import type { MemoryRef, MemoryScope } from '@weave/protocol';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(
  budgets?: MemoryServiceOptions['budgets'],
  databaseFactory?: (filename: string) => DatabaseSync,
) {
  const directory = await mkdtemp(join(tmpdir(), 'weave-memory-runtime-'));
  const store = createSqliteMemoryStore({
    filename: join(directory, 'memory.sqlite'),
    ...(databaseFactory === undefined ? {} : { databaseFactory }),
  });
  const sessions = createInMemorySessionEventStore();
  const scope: MemoryScope = { kind: 'project', projectId: randomUUID() };
  let marker = 0;
  const service = createMemoryService({
    store,
    budgets,
    resolveLocalScope: async () => ({ assertCurrentSync() {} }),
    resolveAgentScope: async () => {
      const captured = marker;
      return {
        membership: { kind: 'unique', projectId: scope.projectId },
        assertCurrentSync() {
          if (marker !== captured) throw new Error('membership changed');
        },
      };
    },
  });
  const tools = createMemoryTools({ service });
  const registry = createToolRegistry();
  for (const definition of Object.values(tools)) registry.register(definition);
  const hostTools = new Set<object>(Object.values(tools));
  cleanup.push(async () => {
    service.closeSync();
    await service.drain();
    await service.close();
    await sessions.close();
    await rm(directory, { recursive: true, force: true });
  });
  await service.local.setAccess(scope, {
    requestId: randomUUID(),
    level: 'read-write',
    expectedSettingRevision: 0,
  });
  async function run(
    name: string,
    input: unknown,
    options: Partial<ToolPipelineOptions> = {},
    permissionMode: 'ask' | 'trust' | 'yolo' = 'yolo',
  ) {
    const identity = {
      sessionId: randomUUID(),
      executionId: randomUUID(),
      turnId: randomUUID(),
      userMessageId: randomUUID(),
    };
    const authority = createAgentToolAuthority({
      identity,
      registry,
      ownerOf: () => 'host',
      rootOnlyTool: (definition) =>
        definition === tools.saveMemory || definition === tools.deleteMemory,
    });
    const pipeline = createToolPipeline({
      registry,
      allowHostToolContext: (definition) => hostTools.has(definition),
      ...(budgets?.maxBytes === undefined ? {} : { maxResultBytes: budgets.maxBytes }),
      ...options,
    });
    let requests = 0;
    const providerTools: string[] = [];
    const runner = createAgentRunner({
      sessionStore: sessions,
      toolRegistry: registry,
      toolPipeline: pipeline,
      ...(budgets?.maxToolResultTokens === undefined
        ? {}
        : { context: { maxToolResultTokens: budgets.maxToolResultTokens } }),
      llm: {
        async *stream(request) {
          if (requests++ === 0) {
            yield { type: 'tool-call-start', id: 'call', name };
            yield { type: 'tool-call-delta', id: 'call', argumentsDelta: JSON.stringify(input) };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            for (const message of request.messages)
              if (message.role === 'tool')
                for (const part of message.content)
                  if (part.type === 'text') providerTools.push(part.text);
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    const events: AgentRuntimeEvent[] = [];
    for await (const event of runner.run({
      sessionId: identity.sessionId,
      executionIdentity: {
        executionId: identity.executionId,
        turnId: identity.turnId,
        userMessageId: identity.userMessageId,
      },
      toolAuthority: authority,
      userMessage: { role: 'user', content: [{ type: 'text', text: 'Memory task' }] },
      provider: 'test',
      model: 'test',
      permissionMode,
    }))
      events.push(event);
    const result = events.find((event) => event.type === 'tool-result');
    if (result?.type !== 'tool-result') throw new Error('Missing tool result');
    return { result, providerTools, identity };
  }
  return {
    service,
    store,
    scope,
    run,
    mutateMembership: () => {
      marker++;
    },
  };
}
const content = (title = 'Preference') => ({
  operation: 'create',
  expectedRevision: 0,
  title,
  content: 'Use strict TypeScript',
  tags: ['code'],
});

function commitFault() {
  let armed = false;
  let unreadable = false;
  let commits = 0;
  class FaultDatabase extends DatabaseSync {
    override exec(sql: string) {
      super.exec(sql);
      if (armed && sql.trim() === 'COMMIT') {
        armed = false;
        unreadable = true;
        commits++;
        throw new Error('COMMIT acknowledged too late');
      }
    }
    override prepare(sql: string): StatementSync {
      if (unreadable && sql.startsWith('SELECT * FROM memory_requests'))
        throw new Error('Temporary readback outage');
      return super.prepare(sql);
    }
  }
  return {
    databaseFactory: (filename: string) => new FaultDatabase(filename),
    arm() {
      armed = true;
    },
    recover() {
      unreadable = false;
    },
    commits: () => commits,
  };
}

describe('real Memory service through Pipeline and Runner', () => {
  it.each(['ask', 'trust', 'yolo'] as const)(
    'stores Agent provenance without turning %s permission into human review',
    async (mode) => {
      const f = await fixture();
      const broker = createApprovalBroker();
      let approvals = 0;
      broker.subscribe(({ type, request }) => {
        if (type === 'approval.created') {
          approvals++;
          broker.approve(request.approvalId);
        }
      });
      const result = await f.run('save_memory', content(), { approvalBroker: broker }, mode);
      expect(result.result.status).not.toBe('failed');
      const receipt = JSON.parse(result.result.result.content) as { result: MemoryRef };
      const saved = f.store.read(f.scope, receipt.result.memoryId)!;
      expect(saved.review).toBe('agent-authored');
      expect(saved.provenance).toMatchObject({
        actor: 'agent',
        sessionId: result.identity.sessionId,
        executionId: result.identity.executionId,
        turnId: result.identity.turnId,
        toolCallId: 'call',
      });
      expect(approvals).toBe(mode === 'yolo' ? 0 : 1);
      await f.service.local.review(f.scope, { requestId: randomUUID(), targetRef: saved.ref });
      expect(f.store.read(f.scope, saved.ref.memoryId)?.review).toBe('user-reviewed');
      const revised = await f.run('save_memory', {
        operation: 'revise',
        memoryId: saved.ref.memoryId,
        expectedRevision: 2,
        title: 'Revised',
        content: 'Agent edit',
        tags: [],
      });
      expect(revised.result.status).not.toBe('failed');
      expect(f.store.read(f.scope, saved.ref.memoryId)?.review).toBe('agent-authored');
    },
  );
  it('binds concurrent A/B approvals and commits at most one logical invocation', async () => {
    const f = await fixture();
    const broker = createApprovalBroker();
    const requests: { approvalId: string; inputSummary: unknown }[] = [];
    const ready = Promise.withResolvers<void>();
    broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') {
        requests.push(request);
        if (requests.length === 2) ready.resolve();
      }
    });
    let conflict: unknown;
    const result = await f.run(
      'save_memory',
      content(),
      {
        approvalBroker: broker,
        around: async (request, next) => {
          const a = next({ ...request, arguments: JSON.stringify(content('A')) });
          void a.catch(() => undefined);
          const b = next({ ...request, arguments: JSON.stringify(content('B')) });
          await ready.promise;
          const bRequest = requests.find((request) =>
            JSON.stringify(request.inputSummary).includes('"B"'),
          )!;
          broker.approve(bRequest.approvalId);
          const winning = await b;
          broker.approve(requests.find((request) => request !== bRequest)!.approvalId);
          try {
            await a;
          } catch (error) {
            conflict = error;
          }
          return winning;
        },
      },
      'ask',
    );
    expect(result.result.status).not.toBe('failed');
    expect(conflict).toMatchObject({ code: 'memory-request-conflict' });
    expect(
      f.store
        .list({ scopes: [f.scope], limit: 50, includeAgentAuthored: true })
        .entries.map((entry) => entry.title),
    ).toEqual(['B']);
  });
  it('rejects changed access and membership after preview without appending any record', async () => {
    for (const change of ['access', 'membership'] as const) {
      const f = await fixture();
      const broker = createApprovalBroker();
      broker.subscribe(({ type, request }) => {
        if (type !== 'approval.created') return;
        void (async () => {
          if (change === 'access') {
            await f.service.local.setAccess(f.scope, {
              requestId: randomUUID(),
              level: 'disabled',
              expectedSettingRevision: 1,
            });
            await f.service.local.setAccess(f.scope, {
              requestId: randomUUID(),
              level: 'read-write',
              expectedSettingRevision: 2,
            });
          } else f.mutateMembership();
          broker.approve(request.approvalId);
        })();
      });
      const result = await f.run('save_memory', content(), { approvalBroker: broker }, 'ask');
      expect(result.result.status).toBe('failed');
      expect(
        f.store.list({ scopes: [f.scope], limit: 50, includeAgentAuthored: true }).entries,
      ).toEqual([]);
    }
  });
  it('pages escaped Unicode within both actual Pipeline bytes and Runner tokens', async () => {
    const f = await fixture({ maxBytes: 1900, maxToolResultTokens: 600 });
    const original = '\\"汉🙂\n'.repeat(400);
    const created = await f.service.local.create(f.scope, {
      ...content(),
      operation: 'create',
      expectedRevision: 0,
      requestId: randomUUID(),
      content: original,
    });
    expect('sha256' in created.result).toBe(true);
    const ref = created.result as MemoryRef;
    let cursor: string | undefined;
    let reconstructed = '';
    let pages = 0;
    do {
      const result = await f.run('read_memory', {
        memoryId: ref.memoryId,
        ref,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(result.result.status).not.toBe('failed');
      expect(result.result.result.truncated).toBe(false);
      expect(Buffer.byteLength(result.result.result.content)).toBeLessThanOrEqual(1900);
      const page = JSON.parse(result.result.result.content) as {
        text: string;
        nextCursor?: string;
        eof: boolean;
      };
      expect(page.text.length).toBeGreaterThan(0);
      reconstructed += page.text;
      cursor = page.nextCursor;
      for (const text of result.providerTools) expect(() => JSON.parse(text)).not.toThrow();
      pages++;
      expect(pages).toBeLessThan(100);
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(reconstructed).toBe(original);
  });
  it('refuses writes before effect when even a stable receipt cannot fit', async () => {
    const f = await fixture({ maxBytes: 100, maxToolResultTokens: 10 });
    const result = await f.run('save_memory', content());
    expect(result.result.status).toBe('failed');
    expect(result.result.errorCode).toBe('memory-limit');
    expect(
      f.store.list({ scopes: [f.scope], limit: 50, includeAgentAuthored: true }).entries,
    ).toEqual([]);
  });
  it('reconciles an exact local retry after a temporary uncertain readback without shutdown', async () => {
    const fault = commitFault();
    const f = await fixture(undefined, fault.databaseFactory);
    const input = {
      ...content(),
      operation: 'create' as const,
      expectedRevision: 0 as const,
      requestId: randomUUID(),
    };
    fault.arm();
    await expect(f.service.local.create(f.scope, input)).rejects.toMatchObject({
      code: 'memory-persistence-uncertain',
    });
    fault.recover();
    const receipt = await f.service.local.create(f.scope, input);
    expect('revision' in receipt.result && receipt.result.revision).toBe(1);
    expect(fault.commits()).toBe(1);
    expect(f.store.list({ scopes: [f.scope], limit: 50 }).entries).toHaveLength(1);
  });
  it('reconciles an exact Agent attempt retry by readback, then checks live authority', async () => {
    const fault = commitFault();
    const f = await fixture(undefined, fault.databaseFactory);
    fault.arm();
    const result = await f.run('save_memory', content(), {
      around: async (request, next) => {
        await expect(next(request)).rejects.toMatchObject({ code: 'memory-persistence-uncertain' });
        fault.recover();
        return next(request);
      },
    });
    expect(result.result.status).not.toBe('failed');
    expect(fault.commits()).toBe(1);
    expect(
      f.store.list({ scopes: [f.scope], limit: 50, includeAgentAuthored: true }).entries,
    ).toHaveLength(1);
  });
  it('keeps a recovered Agent receipt private when current access is disabled', async () => {
    const fault = commitFault();
    const f = await fixture(undefined, fault.databaseFactory);
    fault.arm();
    const result = await f.run('save_memory', content(), {
      around: async (request, next) => {
        await expect(next(request)).rejects.toMatchObject({ code: 'memory-persistence-uncertain' });
        fault.recover();
        const realAccess = f.store.getAccess.bind(f.store);
        const override = vi
          .spyOn(f.store, 'getAccess')
          .mockImplementation((scope) => ({ ...realAccess(scope), level: 'disabled' }));
        try {
          return await next(request);
        } finally {
          override.mockRestore();
        }
      },
    });
    expect(result.result.status).toBe('failed');
    expect(result.result.errorCode).toBe('memory-disabled');
    expect(fault.commits()).toBe(1);
  });
  it('fences cross-scope attempts until the original Agent key is reconciled', async () => {
    const fault = commitFault();
    const f = await fixture(undefined, fault.databaseFactory);
    await f.service.local.setAccess(
      { kind: 'user' },
      { requestId: randomUUID(), level: 'read-write', expectedSettingRevision: 0 },
    );
    fault.arm();
    const result = await f.run('save_memory', content(), {
      around: async (request, next) => {
        await expect(next(request)).rejects.toMatchObject({ code: 'memory-persistence-uncertain' });
        fault.recover();
        await expect(
          next({ ...request, arguments: JSON.stringify({ ...content(), scope: 'user' }) }),
        ).rejects.toMatchObject({ code: 'memory-persistence-uncertain' });
        return next(request);
      },
    });
    expect(result.result.status).not.toBe('failed');
    expect(fault.commits()).toBe(1);
    expect(
      f.store.list({ scopes: [{ kind: 'user' }], limit: 50, includeAgentAuthored: true }).entries,
    ).toEqual([]);
  });
});
