import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { SessionEvent } from '@weave/session';
import { startServer } from '../src/main.js';
import { approvalBrokerService, getServerSessionStore } from '../src/runtime.js';

interface ProviderRequest {
  readonly messages: readonly {
    readonly role: string;
    readonly content: string | readonly { readonly type: string; readonly text?: string }[];
  }[];
  readonly tools?: readonly { readonly function: { readonly name: string } }[];
}
function userText(request: ProviderRequest): string {
  const message = request.messages.find((item) => item.role === 'user');
  return typeof message?.content === 'string'
    ? message.content
    : (message?.content.map((part) => part.text ?? '').join('') ?? '');
}
function modelReply(
  value: string | { readonly name: string; readonly arguments: object },
): Response {
  const call = typeof value !== 'string';
  const chunk = {
    id: randomUUID(),
    object: 'chat.completion.chunk',
    created: 1,
    model: 'tasks',
    choices: [
      {
        index: 0,
        delta: call
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: randomUUID(),
                  type: 'function',
                  function: { name: value.name, arguments: JSON.stringify(value.arguments) },
                },
              ],
            }
          : { content: value },
        finish_reason: null,
      },
    ],
  };
  const final = {
    ...chunk,
    choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
const accepted = (events: readonly SessionEvent[]) =>
  events.filter((event) => event.type === 'agent.task.accepted');

it.each(['reject', 'folder-aba'] as const)(
  'runs native tasks with real SQLite, HTTP/SSE, exact approvals and %s fencing',
  async (decision) => {
    const directory = await mkdtemp(join(tmpdir(), 'weave-task-integration-'));
    const workspace = join(directory, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(workspace);
    const calls = new Map<string, number>();
    const requests: ProviderRequest[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as ProviderRequest;
      requests.push(request);
      const prompt = userText(request);
      const step = calls.get(prompt) ?? 0;
      calls.set(prompt, step + 1);
      if (prompt === 'Delegate two reviews.') {
        if (step === 0)
          return modelReply({
            name: 'agent_spawn',
            arguments: { title: 'Read only review', prompt: 'Readonly child.' },
          });
        if (step === 1)
          return modelReply({
            name: 'agent_spawn',
            arguments: {
              title: 'Workspace review',
              prompt: 'Workspace child.',
              access: 'workspace',
            },
          });
        return modelReply('Parent continues after delegating.');
      }
      if (step === 0)
        return modelReply({
          name: 'write_file',
          arguments: {
            path: prompt === 'Readonly child.' ? 'readonly.txt' : 'workspace.txt',
            content: 'must not be written',
          },
        });
      return modelReply('Review complete after the protected attempt.');
    };
    const server = await startServer(0, {
      databaseFile: join(directory, 'state.db'),
      pluginsDirectory: false,
      skillsDirectory: false,
      fetch: fakeFetch,
      environment: {
        WEAVE_LLM_PROVIDERS: JSON.stringify([
          {
            id: 'tasks',
            label: 'Tasks',
            type: 'openai-compatible',
            baseUrl: 'https://fixture.invalid/v1',
            apiKey: 'fixture-only',
            defaultModel: 'tasks',
          },
        ]),
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const store = getServerSessionStore(server.runtime);
    try {
      const project = (await (
        await post('/projects', { name: 'Tasks', folderName: 'tasks', folderPath: workspace })
      ).json()) as { id: string };
      const session = (await (await post(`/projects/${project.id}/sessions`, {})).json()) as {
        id: string;
      };
      const launched = await post(`/sessions/${session.id}/executions`, {
        requestId: 'parent',
        input: {
          provider: 'tasks',
          model: 'tasks',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Delegate two reviews.' }] },
        },
      });
      expect(launched.status).toBe(202);
      await expect.poll(async () => accepted(await store.read(session.id)).length).toBe(2);
      const tasks = accepted(await store.read(session.id));
      const broker = server.runtime.get(approvalBrokerService);
      await expect
        .poll(() => broker.list().filter((item) => item.status === 'pending').length)
        .toBe(1);
      const approval = broker.list().find((item) => item.status === 'pending')!;
      const protectedTask = tasks.find((task) => task.payload.access === 'workspace')!;
      expect(approval).toMatchObject({
        sessionId: protectedTask.payload.childSessionId,
        executionId: protectedTask.payload.childExecutionId,
        turnId: protectedTask.payload.childTurnId,
        toolName: 'write_file',
      });
      await expect
        .poll(async () =>
          (await store.read(session.id)).some((event) => event.type === 'execution.finished'),
        )
        .toBe(true);
      const approvals = (await (await fetch(`${base}/approvals`)).json()) as {
        approvals: { approvalId: string }[];
      };
      expect(approvals.approvals.some((item) => item.approvalId === approval.approvalId)).toBe(
        true,
      );
      const treeResponse = await fetch(`${base}/sessions/${session.id}/tasks`);
      expect(treeResponse.status).toBe(200);
      const tree = (await treeResponse.json()) as {
        cursor: string;
        tasks: { taskId: string; pendingApprovalIds: string[]; pendingApprovalCount: number }[];
      };
      expect(tree.tasks).toHaveLength(2);
      expect(tree.tasks.find((task) => task.taskId === protectedTask.payload.taskId)).toMatchObject(
        {
          pendingApprovalIds: [approval.approvalId],
          pendingApprovalCount: 1,
        },
      );
      const detail = await fetch(
        `${base}/sessions/${protectedTask.payload.childSessionId}/tasks/${protectedTask.payload.taskId}`,
      );
      expect(detail.status).toBe(200);
      expect(await detail.json()).not.toHaveProperty('prompt');
      const stream = await fetch(
        `${base}/sessions/${session.id}/tasks/events?after=${encodeURIComponent(tree.cursor)}`,
      );
      expect(stream.status).toBe(200);
      const reader = stream.body!.getReader();
      try {
        const initial = new TextDecoder().decode((await reader.read()).value);
        expect(initial).toContain('event: tasks');
        expect(initial).toContain(approval.approvalId);
        if (decision === 'reject') {
          expect((await post(`/approvals/${approval.approvalId}/reject`, {})).status).toBe(200);
        } else {
          const update = (folderPath: string | null) =>
            fetch(`${base}/projects/${project.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ folderPath }),
            });
          expect((await update(null)).status).toBe(200);
          expect((await update(workspace)).status).toBe(200);
          expect((await post(`/approvals/${approval.approvalId}/approve`, {})).status).toBe(409);
        }
        const next = new TextDecoder().decode((await reader.read()).value);
        expect(next).toContain('event: tasks');
      } finally {
        await reader.cancel();
      }
      await expect
        .poll(
          async () =>
            (await store.read(session.id)).filter((event) => event.type === 'agent.task.settled')
              .length,
        )
        .toBe(2);
      expect(await readdir(workspace)).toEqual([]);
      for (const task of tasks) {
        const events = await store.read(task.payload.childSessionId);
        expect(events.slice(0, 2).map((event) => event.type)).toEqual([
          'session.created',
          'agent.task.origin',
        ]);
        expect(events.filter((event) => event.type === 'execution.accepted')).toHaveLength(1);
        expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
      }
      const readOnly = requests.find((request) => userText(request) === 'Readonly child.')!;
      expect(
        readOnly.tools?.some((tool) =>
          ['write_file', 'edit_file', 'run_command'].includes(tool.function.name),
        ),
      ).toBe(false);
      expect(
        requests
          .filter((request) => userText(request) !== 'Delegate two reviews.')
          .every((request) =>
            request.tools?.every((tool) => !tool.function.name.startsWith('agent_')),
          ),
      ).toBe(true);
      expect(calls.get('Delegate two reviews.')).toBe(3);
      expect(calls.get('Readonly child.')).toBe(2);
      expect(calls.get('Workspace child.')).toBe(decision === 'folder-aba' ? 1 : 2);
      if (decision === 'folder-aba') {
        expect(calls.get('Workspace child.')).toBe(1);
        const settled = (await store.read(session.id)).find(
          (event) =>
            event.type === 'agent.task.settled' &&
            event.payload.taskId === protectedTask.payload.taskId,
        );
        expect(settled?.payload).toMatchObject({
          settlement: { status: 'cancelled', reason: 'workspace-changed' },
        });
      }
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
