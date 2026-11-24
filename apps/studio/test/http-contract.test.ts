import { afterEach, describe, expect, it, vi } from 'vitest';
import approvalsFixture from '../../../test/fixtures/http-contract/approvals.json';
import executionFixture from '../../../test/fixtures/http-contract/execution.json';
import queueFixture from '../../../test/fixtures/http-contract/queue.json';
import tasksFixture from '../../../test/fixtures/http-contract/tasks.json';
import workspaceFixture from '../../../test/fixtures/http-contract/workspace.json';
import {
  getAgentExecution,
  listAgentExecutions,
  observeAgentExecution,
} from '../src/features/agent/agent-execution-client.js';
import {
  getExecutionQueue,
  observeExecutionQueue,
} from '../src/features/agent/agent-queue-client.js';
import {
  subscribeApprovals,
  type ApprovalRequest,
} from '../src/features/approvals/approval-api.js';
import { getAgentTask, getAgentTaskTree } from '../src/features/tasks/task-api.js';
import { createWorkspaceApi } from '../src/features/workspace/workspace-api.js';

/**
 * Studio mirrors the Server HTTP contract by hand (it imports no `@weave/*`
 * package). The JSON files under test/fixtures/http-contract are
 * neutralized captures of the real Server, kept current by a Server test. The
 * real Studio clients below parse them, so a field renamed, added or removed on
 * either side fails here instead of at runtime.
 */
interface Frame {
  readonly id?: string;
  readonly event: string;
  readonly data: unknown;
}
const frameText = (frames: readonly Frame[]): string =>
  frames
    .map(
      (frame) =>
        `${frame.id === undefined ? '' : `id: ${frame.id}\n`}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`,
    )
    .join('');
const sse = (frames: readonly Frame[]): Response =>
  new Response(frameText(frames), { headers: { 'Content-Type': 'text/event-stream' } });

const snapshot = executionFixture.snapshot;
const sessionId = snapshot.sessionId;
const parentId = workspaceFixture.sessionDetail.id;
const queueSessionId = queueFixture.snapshot.sessionId;
const task = tasksFixture.task;

type Routes = Record<string, () => Response>;
function serve(extra: Routes = {}): void {
  const routes: Routes = {
    '/projects?includeArchived=false': () => Response.json(workspaceFixture.projects),
    [`/sessions/${parentId}`]: () => Response.json(workspaceFixture.sessionDetail),
    [`/sessions/${parentId}/executions`]: () => Response.json(executionFixture.list),
    [`/sessions/${sessionId}/executions/${snapshot.executionId}`]: () => Response.json(snapshot),
    [`/sessions/${sessionId}/executions/${snapshot.executionId}/events?after=${encodeURIComponent(
      executionFixture.frames[0]!.id!,
    )}`]: () => sse(executionFixture.frames as Frame[]),
    [`/sessions/${queueSessionId}/executions/queue`]: () => Response.json(queueFixture.snapshot),
    [`/sessions/${queueSessionId}/executions/queue/events`]: () =>
      sse(queueFixture.frames as Frame[]),
    '/approvals/stream': () => sse(approvalsFixture.frames as Frame[]),
    [`/sessions/${parentId}/tasks`]: () => Response.json(tasksFixture.tree),
    [`/sessions/${parentId}/tasks/${task.taskId}`]: () => Response.json(task),
    ...extra,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const route = routes[String(input)];
      if (route === undefined) throw new Error(`Unexpected Studio request: ${String(input)}`);
      return route();
    }),
  );
}
afterEach(() => vi.unstubAllGlobals());

describe('Studio schemas parse the real Server responses', () => {
  it('projects, session lists and session detail', async () => {
    serve();
    const api = createWorkspaceApi();
    const projects = await api.listProjects();
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]!.sessions.length).toBeGreaterThan(1);
    const detail = await api.getSession(parentId);
    expect(detail.id).toBe(parentId);
    expect(detail.messages.length).toBeGreaterThan(0);
  });

  it('execution list, snapshot and event/status frames', async () => {
    serve();
    expect((await listAgentExecutions(parentId)).map((entry) => entry.status)).toEqual([
      'completed',
    ]);
    const loaded = await getAgentExecution(sessionId, snapshot.executionId);
    expect(loaded.status).toBe('completed');
    const first = executionFixture.frames[0]!;
    expect(first.event).toBe('snapshot');
    const running = (first.data as { snapshot: unknown }).snapshot as typeof snapshot;
    const events: string[] = [];
    const statuses: string[] = [];
    await observeAgentExecution(running, {
      onEvent: (event) => events.push(event.type),
      onStatus: (frame) => statuses.push(frame.status),
    });
    expect(events).toEqual(['text-delta', 'completed']);
    expect(statuses).toEqual(['completed']);
  });

  it('queue snapshot and queue frames', async () => {
    serve();
    const queue = await getExecutionQueue(queueSessionId);
    expect(queue.active?.status).toBe('running');
    expect(queue.queued.map((entry) => entry.preview)).toEqual(['block-two', 'block-three']);
    const controller = new AbortController();
    const seen: number[] = [];
    await observeExecutionQueue(
      queueSessionId,
      (state) => {
        seen.push(state.queued.length);
        controller.abort();
      },
      { signal: controller.signal },
    ).catch(() => undefined);
    expect(seen).toEqual([2]);
  });

  it('approval list entries and the approval SSE snapshot frame', async () => {
    serve();
    const received: (readonly ApprovalRequest[])[] = [];
    const controller = new AbortController();
    await subscribeApprovals(
      {
        onSnapshot: (approvals) => {
          received.push(approvals);
          controller.abort();
        },
        onUpdate: () => undefined,
      },
      { signal: controller.signal },
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toHaveLength(1);
    expect(received[0]![0]).toMatchObject({ toolName: 'write_file', status: 'pending' });
    expect(approvalsFixture.list.approvals).toHaveLength(1);
  });

  it('task tree and task view', async () => {
    serve();
    const tree = await getAgentTaskTree(parentId);
    expect(tree.tasks.map((entry) => entry.taskId)).toEqual([task.taskId]);
    expect(tree.tasks[0]!.pendingApprovalCount).toBe(1);
    expect((await getAgentTask(parentId, task.taskId)).taskId).toBe(task.taskId);
  });
});

describe('contract drift is rejected', () => {
  it('rejects an execution snapshot with an unknown field', async () => {
    serve({
      [`/sessions/${sessionId}/executions/${snapshot.executionId}`]: () =>
        Response.json({ ...snapshot, renamedField: true }),
    });
    await expect(getAgentExecution(sessionId, snapshot.executionId)).rejects.toThrow();
  });

  it('rejects a queue snapshot missing a required field', async () => {
    const { scheduler: _scheduler, ...broken } = queueFixture.snapshot;
    void _scheduler;
    serve({ [`/sessions/${queueSessionId}/executions/queue`]: () => Response.json(broken) });
    await expect(getExecutionQueue(queueSessionId)).rejects.toThrow();
  });

  it('rejects a task view with a renamed field', async () => {
    const { status: _status, ...rest } = task;
    void _status;
    serve({
      [`/sessions/${parentId}/tasks/${task.taskId}`]: () =>
        Response.json({ ...rest, state: 'running' }),
    });
    await expect(getAgentTask(parentId, task.taskId)).rejects.toThrow();
  });

  it('rejects a project list whose session lost a required field', async () => {
    const projects = structuredClone(workspaceFixture.projects) as {
      projects: { sessions: Record<string, unknown>[] }[];
    };
    delete projects.projects[0]!.sessions[0]!.title;
    serve({ '/projects?includeArchived=false': () => Response.json(projects) });
    await expect(createWorkspaceApi().listProjects()).rejects.toThrow();
  });
});
