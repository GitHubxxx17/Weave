import { randomUUID } from 'node:crypto';
import type { AgentTaskView } from '@weave/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentTaskObserver } from '../src/agent-task-observer.js';
import type { ApprovalListener, ApprovalRequest } from '../src/approval-types.js';

function task(root = 'root'): AgentTaskView {
  return {
    taskId: randomUUID(),
    rootSessionId: root,
    parentSessionId: root,
    parentTurnId: 'parent-turn',
    childSessionId: randomUUID(),
    childExecutionId: randomUUID(),
    childTurnId: randomUUID(),
    title: 'Task',
    access: 'read-only',
    permissionMode: 'ask',
    acceptedAt: '2026-11-23T00:00:00.000Z',
    status: 'running',
    resultKind: 'none',
    preview: '',
    previewTruncated: false,
    pendingApprovalIds: [],
    pendingApprovalCount: 0,
  };
}

function terminal(view: AgentTaskView): AgentTaskView {
  return {
    ...view,
    status: 'completed',
    resultKind: 'final-answer',
    preview: 'answer',
    result: {
      sessionId: view.childSessionId,
      executionId: view.childExecutionId,
      turnId: view.childTurnId,
      messageId: 'answer',
      terminalSequence: 5,
    },
  };
}

function fixture(initial: AgentTaskView[] = []) {
  const tasks = new Map(initial.map((view) => [view.taskId, view]));
  const taskListeners = new Set<(root: string) => void>();
  const approvals = new Map<string, ApprovalRequest>();
  const approvalListeners = new Set<ApprovalListener>();
  const service = {
    snapshot: vi.fn((root: string) =>
      [...tasks.values()].filter((view) => view.rootSessionId === root),
    ),
    subscribe(listener: (root: string) => void) {
      taskListeners.add(listener);
      return () => taskListeners.delete(listener);
    },
  };
  const approvalBroker = {
    list: () => [...approvals.values()],
    subscribe(listener: ApprovalListener) {
      approvalListeners.add(listener);
      return () => approvalListeners.delete(listener);
    },
  };
  const observer = createAgentTaskObserver({ service, approvalBroker });
  return {
    observer,
    service,
    approvalBroker,
    taskListeners,
    approvalListeners,
    setTask(view: AgentTaskView, notify = true) {
      tasks.set(view.taskId, view);
      if (notify) for (const listener of taskListeners) listener(view.rootSessionId);
    },
    approve(view: AgentTaskView, overrides: Partial<ApprovalRequest> = {}) {
      const request: ApprovalRequest = {
        approvalId: randomUUID(),
        toolCallId: 'call',
        toolName: 'write_file',
        operation: 'write',
        summary: 'Private approval summary',
        risk: 'medium',
        inputSummary: { private: true },
        sessionId: view.childSessionId,
        executionId: view.childExecutionId,
        turnId: view.childTurnId,
        status: 'pending',
        createdAt: view.acceptedAt,
        ...overrides,
      };
      approvals.set(request.approvalId, request);
      for (const listener of approvalListeners) listener({ type: 'approval.created', request });
      return () => {
        const resolved = { ...request, status: 'approved' as const };
        approvals.set(request.approvalId, resolved);
        for (const listener of approvalListeners)
          listener({ type: 'approval.resolved', request: resolved });
      };
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('Agent task observation', () => {
  it('reads a newly materialized view before the task gate sends its notification', async () => {
    const f = fixture();
    const view = task();
    expect(f.observer.status('root', {}).tasks).toEqual([]);
    f.setTask(view, false);
    const taskIds = [view.taskId];
    expect(f.observer.status('root', { taskIds }).tasks).toEqual([view]);
    f.setTask(terminal(view), false);
    await expect(f.observer.wait('root', { taskIds, timeoutMs: 0 })).resolves.toMatchObject({
      tasks: [terminal(view)],
      changed: true,
      allSettled: true,
    });
    f.observer.close();
  });
  it('waits for a sibling after consuming a terminal and responds without the consumed body', async () => {
    const first = terminal(task());
    const second = task();
    const f = fixture([first, second]);
    const taskIds = [first.taskId, second.taskId];
    const firstResult = await f.observer.wait('root', { taskIds });
    expect(firstResult).toMatchObject({ tasks: [first], changed: true, allSettled: false });
    await expect(
      f.observer.wait('root', { taskIds, after: firstResult.cursor, timeoutMs: 0 }),
    ).resolves.toMatchObject({
      tasks: [{ ...first, preview: '', previewTruncated: true }, second],
      timedOut: true,
      changed: false,
      allSettled: false,
      truncated: true,
    });
    const waiting = f.observer.wait('root', {
      taskIds: taskIds.toReversed(),
      after: firstResult.cursor,
    });
    const observed = vi.fn();
    void waiting.then(observed);
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    f.setTask(terminal(second));
    const secondResult = await waiting;
    expect(secondResult).toMatchObject({
      tasks: [terminal(second)],
      changed: true,
      allSettled: true,
    });
    await expect(
      f.observer.wait('root', { taskIds, after: secondResult.cursor }),
    ).resolves.toMatchObject({
      tasks: [],
      changed: false,
      allSettled: true,
    });
    expect(f.observer.status('root', { taskIds }).tasks).toHaveLength(2);
    f.observer.close();
  });

  it('uses only current exact approvals, suppresses consumed approvals, and exposes a bounded count', async () => {
    const view = task();
    const f = fixture([view]);
    const taskIds = [view.taskId];
    f.approve(view, { turnId: 'another-turn' });
    f.approve(view, { executionId: 'another-execution' });
    f.approve(view, { sessionId: 'another-session' });
    f.approve(view)();
    const resolve = [
      f.approve(view),
      f.approve(view),
      f.approve(view),
      f.approve(view),
      f.approve(view),
    ];
    const pending = await f.observer.wait('root', { taskIds });
    expect(pending.tasks[0]?.pendingApprovalCount).toBe(5);
    expect(pending.tasks[0]?.pendingApprovalIds).toHaveLength(4);
    expect(JSON.stringify(pending)).not.toContain('Private approval summary');
    const waiting = f.observer.wait('root', { taskIds, after: pending.cursor });
    const observed = vi.fn();
    void waiting.then(observed);
    for (const finish of resolve) finish();
    await Promise.resolve();
    expect(observed).not.toHaveBeenCalled();
    f.approve(view);
    await expect(waiting).resolves.toMatchObject({
      tasks: [{ pendingApprovalCount: 1 }],
      changed: true,
    });
    f.setTask(terminal(view));
    expect(f.observer.status('root', { taskIds }).tasks[0]?.pendingApprovalCount).toBe(0);
    f.observer.close();
  });

  it('coalesces approval transitions and finds a terminal produced during subscription setup', async () => {
    const view = task();
    const f = fixture([view]);
    let changed = false;
    f.service.snapshot.mockImplementationOnce(() => {
      f.approve(view)();
      f.setTask(terminal(view));
      changed = true;
      return [view];
    });
    await expect(f.observer.wait('root', { taskIds: [view.taskId] })).resolves.toMatchObject({
      tasks: [terminal(view)],
      changed: true,
    });
    expect(changed).toBe(true);
    f.observer.close();
  });

  it('binds cursor kind, root and target set, rejects tampering, and resets after an old epoch', async () => {
    const root = 'r'.repeat(240);
    const first = terminal(task(root));
    const second = task(root);
    const foreign = task('other');
    const f = fixture([first, second, foreign]);
    const taskIds = [first.taskId];
    const { cursor } = f.observer.status(root, { taskIds });
    const tree = f.observer.snapshot(root);
    expect(tree).toMatchObject({ epoch: expect.any(String), rootSessionId: root });
    expect(cursor.length).toBeLessThanOrEqual(600);
    expect(() => f.observer.snapshot(root, cursor)).toThrow();
    expect(() => f.observer.snapshot('other', tree.cursor)).toThrow();
    await expect(f.observer.wait(root, { taskIds, after: tree.cursor })).rejects.toMatchObject({
      code: 'agent-task-invalid-input',
    });
    await expect(
      f.observer.wait(root, { taskIds: [second.taskId], after: cursor }),
    ).rejects.toMatchObject({ code: 'agent-task-invalid-input' });
    await expect(
      f.observer.wait(root, { taskIds: [first.taskId, foreign.taskId] }),
    ).rejects.toMatchObject({ code: 'agent-task-not-found' });
    await expect(f.observer.wait(root, { taskIds, after: `${cursor}x` })).rejects.toMatchObject({
      code: 'agent-task-invalid-input',
    });
    await expect(f.observer.wait(root, { taskIds, after: cursor })).resolves.toMatchObject({
      allSettled: true,
      tasks: [],
    });
    const restarted = createAgentTaskObserver({
      service: f.service,
      approvalBroker: f.approvalBroker,
    });
    await expect(restarted.wait(root, { taskIds, after: cursor })).resolves.toMatchObject({
      tasks: [first],
      changed: true,
    });
    const freshTree = restarted.snapshot(root, tree.cursor);
    expect(freshTree.rootSessionId).toBe(root);
    expect(freshTree.epoch).not.toBe(tree.epoch);
    expect(freshTree.changed).toBe(true);
    expect(restarted.snapshot(root, freshTree.cursor).changed).toBe(false);
    restarted.close();
    f.observer.close();
  });

  it('bounds tree and status pages, prioritizes live work, and rejects stale page cursors', () => {
    const root = 'r'.repeat(240);
    const entries = Array.from({ length: 16 }, () => ({
      ...terminal(task(root)),
      preview: '"'.repeat(4096),
    }));
    const live = task(root);
    const { observer, setTask } = fixture([live, ...entries]);
    const ordered = [live, ...entries.toReversed()];
    const page = observer.status(root, {});
    expect(page.tasks.map(({ taskId }) => taskId)).toEqual(
      ordered.slice(0, 16).map(({ taskId }) => taskId),
    );
    expect(page.tasks.every(({ preview }) => preview.length <= 256)).toBe(true);
    const tree = observer.snapshot(root);
    expect(tree).toMatchObject({
      tasks: page.tasks.map(({ taskId, status }) => expect.objectContaining({ taskId, status })),
      totalCount: 17,
      truncated: true,
    });
    expect(Buffer.byteLength(JSON.stringify(tree))).toBeLessThanOrEqual(24576);
    expect(observer.status(root, { cursor: tree.nextCursor }).tasks).toMatchObject([
      { taskId: entries[0]?.taskId },
    ]);
    expect(() => observer.status('other', { cursor: page.nextCursor })).toThrow();
    setTask({ ...live, status: 'queued' });
    expect(() => observer.status(root, { cursor: page.nextCursor })).toThrow();
    const detailed = observer.status(root, {
      taskIds: entries.slice(0, 4).map(({ taskId }) => taskId),
    });
    expect(Buffer.byteLength(JSON.stringify(detailed))).toBeLessThanOrEqual(24576);
    expect(detailed.tasks.map(({ result }) => result)).toEqual(
      entries.slice(0, 4).map(({ result }) => result),
    );
    observer.close();
  });

  it('resets evicted root cursors and preserves active and recently used observations', async () => {
    const evicted = terminal(task('evicted'));
    const active = terminal(task('active'));
    const waiting = task('waiting');
    const recent = terminal(task('recent'));
    const f = fixture([evicted, active, waiting, recent]);
    const evictedTree = f.observer.snapshot('evicted');
    const evictedPage = f.observer.status('evicted', {});
    const evictedWait = await f.observer.wait('evicted', { taskIds: [evicted.taskId] });
    const activeTree = f.observer.snapshot('active');
    const detach = f.observer.subscribe('active', vi.fn());
    const activeWait = await f.observer.wait('active', { taskIds: [active.taskId] });
    const waitingTree = f.observer.snapshot('waiting');
    const result = f.observer.wait('waiting', { taskIds: [waiting.taskId] });
    const recentTree = f.observer.snapshot('recent');

    try {
      for (let index = 0; index < 80; index++) {
        f.observer.status(`other-root-${index}`, {});
        if (index % 16 === 0) f.observer.snapshot('recent', recentTree.cursor);
      }
      expect(f.observer.snapshot('active', activeTree.cursor)).toMatchObject({
        epoch: activeTree.epoch,
        changed: false,
      });
      await expect(
        f.observer.wait('active', { taskIds: [active.taskId], after: activeWait.cursor }),
      ).resolves.toMatchObject({ tasks: [], allSettled: true, changed: false });
      expect(f.observer.snapshot('recent', recentTree.cursor)).toMatchObject({
        epoch: recentTree.epoch,
        changed: false,
      });
      expect(f.observer.snapshot('waiting', waitingTree.cursor)).toMatchObject({
        epoch: waitingTree.epoch,
        changed: false,
      });
      f.setTask(terminal(waiting));
      await expect(result).resolves.toMatchObject({ tasks: [terminal(waiting)] });

      expect(f.observer.snapshot('evicted', evictedTree.cursor)).toMatchObject({
        epoch: expect.not.stringMatching(evictedTree.epoch),
        changed: true,
        tasks: [evicted],
      });
      expect(() => f.observer.status('evicted', { cursor: evictedPage.cursor })).toThrow();
      await expect(
        f.observer.wait('evicted', { taskIds: [evicted.taskId], after: evictedWait.cursor }),
      ).resolves.toMatchObject({ tasks: [evicted], allSettled: true, changed: true });
    } finally {
      detach();
      f.observer.close();
      await result.catch(() => undefined);
    }
  });

  it('skips detached and terminal task identities on Broker notifications', async () => {
    const detached = task('detached');
    const settled = terminal(task('active'));
    const f = fixture([detached, settled]);
    const detach = f.observer.subscribe('detached', vi.fn());
    f.observer.snapshot('detached');
    detach();
    const listener = vi.fn();
    const unsubscribe = f.observer.subscribe('active', listener);
    f.observer.snapshot('active');
    let identityReads = 0;
    const request: ApprovalRequest = {
      approvalId: randomUUID(),
      toolCallId: 'call',
      toolName: 'write_file',
      operation: 'write',
      summary: 'Unrelated approval',
      risk: 'medium',
      inputSummary: {},
      get sessionId() {
        identityReads += 1;
        return 'unrelated';
      },
      executionId: 'unrelated',
      turnId: 'unrelated',
      status: 'pending',
      createdAt: detached.acceptedAt,
    };
    try {
      for (const notify of f.approvalListeners) notify({ type: 'approval.created', request });
      await Promise.resolve();
      expect(identityReads).toBeLessThanOrEqual(1);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      f.observer.close();
    }
  });

  it('returns timeout snapshots, releases aborted waits, and caps live waits and listeners', async () => {
    vi.useFakeTimers();
    const view = task();
    const f = fixture([view]);
    const taskIds = [view.taskId];
    await expect(f.observer.wait('root', { taskIds, timeoutMs: 0 })).resolves.toMatchObject({
      tasks: [view],
      timedOut: true,
      changed: false,
    });
    await expect(f.observer.wait('root', { taskIds, timeoutMs: 60001 })).rejects.toMatchObject({
      code: 'agent-task-invalid-input',
    });
    const timeout = f.observer.wait('root', { taskIds });
    await vi.advanceTimersByTimeAsync(30000);
    await expect(timeout).resolves.toMatchObject({ tasks: [view], timedOut: true });
    const signals = Array.from({ length: 64 }, () => new AbortController());
    const waits = signals.map(({ signal }) =>
      f.observer.wait('root', { taskIds }, signal).catch((cause: unknown) => cause),
    );
    await expect(f.observer.wait('root', { taskIds })).rejects.toMatchObject({
      code: 'agent-task-capacity',
    });
    signals[0]?.abort();
    await expect(waits[0]).resolves.toMatchObject({ name: 'AbortError' });
    const listener = vi.fn();
    const unsubscribe = f.observer.subscribe('root', listener);
    f.setTask({ ...view, status: 'queued' });
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    f.observer.close();
    await expect(Promise.all(waits.slice(1))).resolves.toHaveLength(63);
    expect(f.taskListeners.size).toBe(0);
    expect(f.approvalListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
