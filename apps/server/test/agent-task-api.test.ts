import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentTaskError,
  createAgentExecutionService,
  createAgentTaskObserver,
  createAgentTaskService,
  createApprovalBroker,
  createRuntime,
  getBoundTaskExecutionPort,
  type AgentExecutionService,
  type AgentTaskObserver,
} from '@weave/runtime';
import type { AgentTaskView } from '@weave/protocol';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createApp, type AppOptions } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';

const root = 'root';
const other = 'other';
const taskId = '00000000-0000-4000-8000-000000000001';
const child = '00000000-0000-4000-8000-000000000002';
const execution = '00000000-0000-4000-8000-000000000003';
const turn = '00000000-0000-4000-8000-000000000004';
const base = `/sessions/${root}/tasks`;
const headers = { Host: 'localhost', 'Content-Type': 'application/json' };
const view: AgentTaskView = {
  taskId,
  rootSessionId: root,
  parentSessionId: root,
  parentTurnId: 'parent-turn',
  childSessionId: child,
  childExecutionId: execution,
  childTurnId: turn,
  title: 'Read source',
  access: 'read-only',
  acceptedAt: '2026-11-23T00:00:00.000Z',
  status: 'running',
  resultKind: 'none',
  preview: '',
  previewTruncated: false,
  pendingApprovalIds: [],
  pendingApprovalCount: 0,
};
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options?: { foreignChild?: boolean }) {
  const runtime = createRuntime();
  const sessionStore = createInMemorySessionEventStore();
  const projectStore = createInMemoryProjectStore();
  cleanup.push(
    () => sessionStore.close(),
    () => projectStore.close(),
  );
  const project = await projectStore.createProject({ name: 'Root', folderName: 'root' });
  const another = await projectStore.createProject({ name: 'Other', folderName: 'other' });
  await projectStore.attachSession(project.id, root);
  await projectStore.attachSession(another.id, other);
  await projectStore.attachSession(options?.foreignChild ? another.id : project.id, child);
  for (const id of [root, other, child])
    await sessionStore.append(id, [{ type: 'session.created', payload: {} }]);
  await sessionStore.append(child, [
    {
      type: 'agent.task.origin',
      payload: {
        version: 1,
        taskId,
        parentSessionId: root,
        rootSessionId: root,
        childSessionId: child,
        childExecutionId: execution,
        childTurnId: turn,
        childUserMessageId: crypto.randomUUID(),
        parentAcceptedSequence: 10,
        parentAcceptedDigest: 'a'.repeat(64),
        admissionClass: 'agent-task-once',
      },
    },
  ]);
  const listeners = new Set<(rootId: string) => void>();
  let tasks: readonly AgentTaskView[] = [view];
  const observer = createAgentTaskObserver({
    service: {
      snapshot: (id) => (id === root ? tasks : []),
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    approvalBroker: createApprovalBroker(),
  });
  cleanup.push(() => observer.close());
  const taskService = {
    requestCancel: vi.fn(async () => [{ ...view, status: 'cancelling' as const }]),
    stopAll: vi.fn(async () => [{ ...view, status: 'cancelling' as const }]),
    stopParentTurn: vi.fn(async () => []),
    snapshot: (id: string) => (id === root ? tasks : []),
  };
  const sessionService = createSessionService({ projectStore, sessionStore });
  const appOptions = {
    projectStore,
    sessionService,
    agentTaskObserver: observer,
    agentTaskService: taskService,
  };
  const create = (extra?: Partial<AppOptions>) => createApp(runtime, { ...appOptions, ...extra });
  return {
    app: create(),
    create,
    observer,
    taskService,
    sessionStore,
    projectStore,
    project,
    another,
    sessionService,
    publish(next: readonly AgentTaskView[]) {
      tasks = next;
      for (const listener of listeners) listener(root);
    },
  };
}

function control(app: ReturnType<typeof createApp>, url: string, body: unknown) {
  return app.request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('agent task HTTP', () => {
  it('resolves a child tree to its root and keeps details root-scoped', async () => {
    const { app } = await fixture();
    const response = await app.request(base, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tasks: [view] });
    const childTree = await app.request(`/sessions/${child}/tasks`, { headers });
    expect(await childTree.json()).toMatchObject({ tasks: [view] });
    const detail = await app.request(`${base}/${taskId}`, { headers });
    expect(await detail.json()).toEqual(view);
    expect((await app.request(`/sessions/${other}/tasks/${taskId}`, { headers })).status).toBe(404);
  });

  it('keeps the same tree cursor and revision on each bounded list page', async () => {
    const { app, publish } = await fixture();
    const additional = Array.from({ length: 16 }, (_, index): AgentTaskView => ({
      ...view,
      taskId: crypto.randomUUID(),
      childSessionId: crypto.randomUUID(),
      childExecutionId: crypto.randomUUID(),
      childTurnId: crypto.randomUUID(),
      title: `Newer task ${index}`,
      acceptedAt: '2026-11-24T00:00:00.000Z',
    }));
    publish([view, ...additional]);
    const first = await (await app.request(base, { headers })).json();
    expect(first).toMatchObject({ rootSessionId: root, totalCount: 17, tasks: expect.any(Array) });
    expect(first.tasks).toHaveLength(16);
    const next = await app.request(`${base}?cursor=${first.nextCursor}`, { headers });
    const page = await next.json();
    expect(page).toEqual({
      tasks: [view],
      epoch: first.epoch,
      rootSessionId: root,
      revision: first.revision,
      totalCount: 17,
      cursor: first.cursor,
      changed: true,
      truncated: false,
    });
    const detail = await app.request(`${base}/${taskId}`, { headers });
    expect(await detail.json()).toEqual(view);
    publish([view]);
    expect((await app.request(`${base}?cursor=${first.nextCursor}`, { headers })).status).toBe(400);
  });

  it('rejects an unrelated or ambiguously attached child before resolving a tree', async () => {
    const foreign = await fixture({ foreignChild: true });
    expect((await foreign.app.request(`/sessions/${child}/tasks`, { headers })).status).toBe(404);
    const valid = await fixture();
    const refs = valid.projectStore.listSessionRefs.bind(valid.projectStore);
    valid.projectStore.listSessionRefs = async (id) => {
      const original = await refs(id);
      if (id !== valid.another.id) return original;
      const childRef = (await refs(valid.project.id)).find((item) => item.sessionId === child)!;
      return [...original, { ...childRef, projectId: id }];
    };
    expect((await valid.app.request(`/sessions/${child}/tasks`, { headers })).status).toBe(404);
  });

  it('validates query cardinality, cursor scope, and controls before calling Runtime', async () => {
    const { app, observer, taskService } = await fixture();
    for (const suffix of [
      '?limit=1&limit=2',
      '?limit=17',
      '?limit=',
      '?bogus=1',
      '?cursor=invalid',
      `/${taskId}?a=1`,
      '/events?after=x&after=y',
    ]) {
      expect((await app.request(`${base}${suffix}`, { headers })).status).toBe(400);
    }
    const otherCursor = observer.snapshot(other).cursor;
    expect((await app.request(`${base}/events?after=${otherCursor}`, { headers })).status).toBe(
      400,
    );
    const current = observer.snapshot(root).cursor;
    expect(
      (
        await app.request(`${base}/events?after=${current}`, {
          headers: { ...headers, 'Last-Event-ID': otherCursor },
        })
      ).status,
    ).toBe(400);
    for (const body of [{}, { operationId: 'x', taskIds: [taskId] }, { operationId: 'invalid id' }])
      expect((await control(app, `${base}/stop-all`, body)).status).toBe(400);
    expect(taskService.stopAll).not.toHaveBeenCalled();
  });

  it('uses the pre-CORS local guard and dispatches exact cancellation operations', async () => {
    const { create, taskService } = await fixture();
    const studioOrigin = 'http://localhost:4321';
    const app = create({ studioOrigin });
    const denied = await app.request(`${base}/stop-all`, {
      method: 'OPTIONS',
      headers: { Host: 'far-host', Origin: studioOrigin },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const crossSite = await app.request(base, {
      headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
    const unsupported = await app.request(`${base}/stop-all`, {
      method: 'POST',
      headers: { Host: 'localhost' },
      body: '{}',
    });
    expect(unsupported.status).toBe(415);
    const cancellation = await control(app, `/sessions/${child}/tasks/${taskId}/cancel`, {
      operationId: 'cancel-child-1',
    });
    expect(cancellation.status).toBe(202);
    expect(await cancellation.json()).toMatchObject({ tasks: [{ taskId, status: 'cancelling' }] });
    expect(taskService.requestCancel).toHaveBeenCalledExactlyOnceWith(
      root,
      [taskId],
      'cancel-child-1',
      'task-cancelled',
    );
    expect((await control(app, `${base}/stop-all`, { operationId: 'stop-root-1' })).status).toBe(
      202,
    );
    expect(taskService.stopAll).toHaveBeenCalledExactlyOnceWith(root, 'stop-root-1');
  });

  it('subscribes before the initial snapshot, sends current frames, and detaches on reader cancel', async () => {
    const f = await fixture();
    const order: string[] = [];
    const detach = vi.fn();
    const observer: Pick<AgentTaskObserver, 'status' | 'snapshot' | 'subscribe'> = {
      status: f.observer.status,
      snapshot(...args) {
        order.push('snapshot');
        return f.observer.snapshot(...args);
      },
      subscribe(id, listener) {
        order.push('subscribe');
        const close = f.observer.subscribe(id, listener);
        return () => {
          close();
          detach();
        };
      },
    };
    const app = f.create({ agentTaskObserver: observer });
    const after = f.observer.snapshot(root).cursor;
    const response = await app.request(`${base}/events`, {
      headers: { ...headers, 'Last-Event-ID': after },
    });
    expect(response.status).toBe(200);
    expect(order).toEqual(['subscribe', 'snapshot']);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain(`id: ${after}\nevent: tasks\n`);
    expect(first).toContain('"changed":false');
    f.publish([{ ...view, status: 'cancelling' }]);
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('"status":"cancelling"');
    await reader.cancel();
    expect(detach).toHaveBeenCalledTimes(1);
    expect(f.taskService.requestCancel).not.toHaveBeenCalled();
  });

  it('closes an overflowing reader without stopping tasks', async () => {
    const f = await fixture();
    const response = await f.app.request(`${base}/events`, { headers });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    for (let i = 0; i < 65; i++) {
      f.publish([{ ...view, title: `Version ${i}` }]);
      await Promise.resolve();
    }
    expect((await reader.read()).done).toBe(true);
    expect(f.taskService.stopAll).not.toHaveBeenCalled();
  });

  it('counts encoded bytes toward the event queue cap before reaching 64 frames', async () => {
    const f = await fixture();
    const rows = Array.from({ length: 16 }, (): AgentTaskView => ({
      ...view,
      taskId: crypto.randomUUID(),
      childSessionId: crypto.randomUUID(),
      childExecutionId: crypto.randomUUID(),
      childTurnId: crypto.randomUUID(),
      title: '\\'.repeat(120),
    }));
    f.publish(rows);
    const response = await f.app.request(`${base}/events`, { headers });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    // Fewer than 64 snapshots at this measured size exhaust the byte budget.
    const count = Math.floor((256 * 1024) / (first.value!.byteLength - 64)) + 1;
    expect(count).toBeLessThan(64);
    for (let i = 0; i < count; i++) {
      f.publish(
        rows.map((row) => ({ ...row, title: `${'\\'.repeat(114)}${String(i).padStart(6, '0')}` })),
      );
      await Promise.resolve();
    }
    expect((await reader.read()).done).toBe(true);
    expect(f.taskService.stopAll).not.toHaveBeenCalled();
  });

  it('keeps native errors private and leaves durable child execution launch read-only', async () => {
    const f = await fixture();
    f.taskService.stopAll.mockRejectedValueOnce(
      new AgentTaskError('agent-task-persistence-error', '/private/location'),
    );
    const error = await control(f.app, `${base}/stop-all`, { operationId: 'stop-1' });
    expect(error.status).toBe(503);
    expect(await error.text()).not.toContain('/private/location');
    const service = createAgentExecutionService({
      sessionStore: f.sessionStore,
      admit: vi.fn(async () => undefined),
      runner: { run: vi.fn() },
    });
    const app = f.create({ agentExecutionService: service });
    const request = {
      requestId: 'new-execution',
      input: {
        provider: 'mock',
        model: 'test',
        permissionMode: 'ask',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Test' }] },
      },
    };
    const blocked = await control(app, `/sessions/${child}/executions`, request);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: { code: 'execution-task-session-read-only' },
    });
  });

  it('fences the exact parent Turn before stopping the root execution and delegates child Stop', async () => {
    const f = await fixture();
    const rootExecutionId = 'parent-execution';
    const calls: string[] = [];
    const service = {
      get: vi.fn(async (sessionId, executionId) => ({
        sessionId,
        executionId,
        turnId: sessionId === root ? view.parentTurnId : turn,
        status: 'running',
      })),
      cancel: vi.fn(async (sessionId, executionId) => {
        calls.push('stop execution');
        return { sessionId, executionId, status: 'cancelling' };
      }),
    };
    f.taskService.stopParentTurn.mockImplementation(async () => {
      calls.push('fence turn');
      return [];
    });
    const app = f.create({ agentExecutionService: service as unknown as AgentExecutionService });
    const endpoint = (sessionId: string, executionId: string) =>
      `/sessions/${sessionId}/executions/${executionId}/cancel`;
    const rootResponse = await control(app, endpoint(root, rootExecutionId), {});
    expect(rootResponse.status).toBe(202);
    expect(calls).toEqual(['fence turn', 'stop execution']);
    expect(f.taskService.stopParentTurn).toHaveBeenCalledExactlyOnceWith(
      root,
      view.parentTurnId,
      expect.stringMatching(/^execution-stop:[a-f0-9]{64}$/),
    );
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith(root, rootExecutionId);
    expect((await control(app, endpoint(child, execution), {})).status).toBe(202);
    expect((await control(app, endpoint(child, execution), {})).status).toBe(202);
    expect(f.taskService.requestCancel).toHaveBeenCalledTimes(2);
    expect(f.taskService.requestCancel.mock.calls[0]).toEqual([
      root,
      [taskId],
      expect.stringMatching(/^execution-stop:[a-f0-9]{64}$/),
      'task-cancelled',
    ]);
    expect(f.taskService.requestCancel.mock.calls[1]).toEqual(
      f.taskService.requestCancel.mock.calls[0],
    );
    expect(service.cancel).toHaveBeenCalledTimes(1);
    expect((await control(app, endpoint(child, 'unrelated-execution'), {})).status).toBe(404);
    expect(f.taskService.requestCancel).toHaveBeenCalledTimes(2);
  });

  it('maps busy archive and delete to a safe conflict response', async () => {
    const f = await fixture();
    const busy = async (): Promise<never> => {
      throw new AgentTaskError('agent-task-busy', '/private/location');
    };
    const app = f.create({ sessionService: { ...f.sessionService, archive: busy, delete: busy } });
    for (const response of [
      await app.request(`/sessions/${root}/archive`, { method: 'POST' }),
      await app.request(`/sessions/${child}`, { method: 'DELETE' }),
    ]) {
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: {
          code: 'agent-task-busy',
          message: 'Stop active Agent tasks before changing this Session',
        },
      });
    }
  });

  it('rejects a new Stop All receipt queued behind root deletion', async () => {
    const f = await fixture();
    const executionService = createAgentExecutionService({
      runner: { async *run() {} },
      sessionStore: f.sessionStore,
      admit: async () => {},
    });
    const tasks = createAgentTaskService({
      sessionStore: f.sessionStore,
      execution: getBoundTaskExecutionPort(executionService),
      host: {
        async reserve() {
          throw new Error('No Agent task was requested');
        },
        async projectRelation() {
          return 'unattached';
        },
      },
    });
    const deleting = Promise.withResolvers<void>();
    const finishDelete = Promise.withResolvers<void>();
    const stopQueued = Promise.withResolvers<void>();
    const sessionService = createSessionService({
      projectStore: f.projectStore,
      sessionStore: f.sessionStore,
      withSessionIdle: (id, operation) =>
        tasks.withTaskSessionsIdle(id, async () => {
          deleting.resolve();
          await finishDelete.promise;
          return executionService.withSessionIdle(id, operation);
        }),
    });
    const app = f.create({
      sessionService,
      agentTaskService: {
        ...tasks,
        stopAll(id, operationId) {
          const result = tasks.stopAll(id, operationId);
          stopQueued.resolve();
          return result;
        },
      },
    });
    await expect(tasks.stopAll(root, 'known-empty-stop')).resolves.toEqual([]);
    const deletion = app.request(`/sessions/${root}`, { method: 'DELETE' });
    await deleting.promise;
    const stop = control(app, `${base}/stop-all`, { operationId: 'racing-stop' });
    await stopQueued.promise;
    finishDelete.resolve();
    expect((await deletion).status).toBe(200);
    expect((await stop).status).toBe(404);
    await expect(tasks.stopAll(root, 'known-empty-stop')).resolves.toEqual([]);
    const events = await f.sessionStore.read(root);
    expect(events.map(({ type }) => type)).toEqual([
      'session.created',
      'agent.tasks.stop-requested',
      'session.deleted',
    ]);
    expect(projectSession(events).deletedAt).toBeDefined();
  });

  it('keeps queued root execution Stop on the explicit queue control path', async () => {
    const f = await fixture();
    const service = {
      get: vi.fn(async () => ({
        sessionId: root,
        executionId: execution,
        turnId: turn,
        status: 'queued',
      })),
      cancel: vi.fn(),
    };
    const app = f.create({ agentExecutionService: service as unknown as AgentExecutionService });
    const result = await control(app, `/sessions/${root}/executions/${execution}/cancel`, {});
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: { code: 'execution-not-active' } });
    expect(service.cancel).not.toHaveBeenCalled();
    expect(f.taskService.stopParentTurn).not.toHaveBeenCalled();
  });

  it('requires task control to cancel a durable child execution', async () => {
    const f = await fixture();
    const service = { cancel: vi.fn() };
    const app = f.create({
      agentExecutionService: service as unknown as AgentExecutionService,
      agentTaskService: undefined,
    });
    const response = await control(app, `/sessions/${child}/executions/${execution}/cancel`, {});
    expect(response.status).toBe(503);
    expect(service.cancel).not.toHaveBeenCalled();
  });
});
