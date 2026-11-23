import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLlmProviderRegistry } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { agentTaskFactDigest, type AgentToolAuthority } from '@weave/runtime';
import { createInMemoryProjectStore } from '@weave/workspace';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { createAgentTaskWorkspaceBindings } from '../src/agent-task-workspace.js';
import { createApp } from '../src/app.js';
import { createProjectFolderAuthority } from '../src/project-folder-authority.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';
import { createSessionService } from '../src/session-service.js';
import { createWorkspaceRootResolver } from '../src/workspace-root.js';

const parentSessionId = 'parent';
const taskId = '00000000-0000-4000-8000-000000000001';
const child = {
  sessionId: '00000000-0000-4000-8000-000000000002',
  executionId: '00000000-0000-4000-8000-000000000003',
  turnId: '00000000-0000-4000-8000-000000000004',
  userMessageId: '00000000-0000-4000-8000-000000000005',
};
const runInput = {
  provider: 'test',
  model: 'test',
  permissionMode: 'ask' as const,
  useProviderDefaults: false as const,
  userMessage: { role: 'user' as const, content: [{ type: 'text' as const, text: 'Run' }] },
};
const childExecutionIdentity = {
  executionId: child.executionId,
  turnId: child.turnId,
  userMessageId: child.userMessageId,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function toolCall(id: string, name: string, input: object): StreamEvent[] {
  return [
    { type: 'tool-call-start', id, name },
    { type: 'tool-call-delta', id, argumentsDelta: JSON.stringify(input) },
    { type: 'finish', reason: 'tool-call' },
  ];
}

async function fixture(withFolder = true, tryForeignBinding = false) {
  const temp = await mkdtemp(join(tmpdir(), 'weave-task-workspace-'));
  cleanup.push(() => rm(temp, { recursive: true, force: true }));
  const a = join(temp, 'a');
  const b = join(temp, 'b');
  await Promise.all([mkdir(a), mkdir(b)]);
  await Promise.all([
    writeFile(join(a, 'AGENTS.md'), 'Pinned instructions'),
    writeFile(join(b, 'AGENTS.md'), 'Other instructions'),
  ]);
  const projects = createInMemoryProjectStore();
  cleanup.push(() => projects.close());
  const project = await projects.createProject({
    name: 'Example',
    folderName: 'example',
    ...(withFolder ? { folderPath: a } : {}),
  });
  await projects.attachSession(project.id, parentSessionId);
  await projects.attachSession(project.id, child.sessionId);
  const projectFolderAuthority = createProjectFolderAuthority(projects);
  const resolveWorkspaceRoot = createWorkspaceRootResolver(projects);
  const agentTaskWorkspace = createAgentTaskWorkspaceBindings(
    projectFolderAuthority,
    resolveWorkspaceRoot,
  );
  const binding = await projectFolderAuthority.capture(parentSessionId);
  const foreignBinding = tryForeignBinding
    ? await projectFolderAuthority.capture(child.sessionId)
    : undefined;
  let foreignBindingError: unknown;
  const seenInstructions: string[] = [];
  let onChildModel: (() => Promise<void>) | undefined;
  let calls = 0;
  const registry = createLlmProviderRegistry([
    {
      id: 'test',
      label: 'Test',
      type: 'mock',
      client: {
        async *stream(request) {
          calls++;
          if (calls === 1) yield* toolCall('spawn', 'agent_spawn', {});
          else if (calls === 3) {
            seenInstructions.push(JSON.stringify(request.messages));
            await onChildModel?.();
            yield* toolCall('write', 'write_file', { path: 'new/file', content: 'written' });
          } else yield { type: 'finish', reason: 'stop' };
        },
      },
    },
  ]);
  const runtime = createServerRuntime({
    providerSettings: { registry, providers: registry.list(), defaultProvider: 'test' },
  });
  await runtime.start();
  cleanup.push(async () => {
    projectFolderAuthority.closeSync();
    await disposeServerPlugins(runtime);
    await runtime.stop();
  });
  const store = getServerSessionStore(runtime);
  let token: AgentToolAuthority | undefined;
  runtime.serverHost.hostTools().register({
    name: 'agent_spawn',
    description: 'Starts a task',
    parameters: {},
    inputSchema: z.object({}),
    execute(_input, context) {
      if (foreignBinding !== undefined) {
        try {
          agentTaskWorkspace.derive(context, {
            binding: foreignBinding,
            identity: child,
            access: 'workspace',
          });
        } catch (error) {
          foreignBindingError = error;
        }
      }
      token = agentTaskWorkspace.derive(context, {
        binding,
        identity: child,
        access: 'workspace',
      });
      return 'accepted';
    },
  });
  const runner = await createServerAgentRunner(runtime, {
    resolveWorkspaceRoot,
    agentTaskWorkspace,
  });
  const broker = runtime.get(approvalBrokerService);
  const sessionService = createSessionService({ projectStore: projects, sessionStore: store });
  const app = createApp(runtime, {
    projectStore: projects,
    sessionService,
    projectFolderAuthority,
  });
  for await (const event of runner.run({
    ...runInput,
    sessionId: parentSessionId,
    executionIdentity: {
      executionId: 'parent-execution',
      turnId: 'parent-turn',
      userMessageId: 'parent-message',
    },
  }))
    void event;
  expect(token).toBeDefined();
  const toolAuthority = token!;
  await store.append(child.sessionId, [
    { type: 'session.created', payload: {} },
    {
      type: 'agent.task.origin',
      payload: {
        version: 1,
        taskId,
        parentSessionId,
        rootSessionId: parentSessionId,
        childSessionId: child.sessionId,
        childExecutionId: child.executionId,
        childTurnId: child.turnId,
        childUserMessageId: child.userMessageId,
        parentAcceptedSequence: 8,
        parentAcceptedDigest: 'a'.repeat(64),
        admissionClass: 'agent-task-once',
      },
    },
    {
      type: 'execution.accepted',
      payload: {
        ...childExecutionIdentity,
        requestId: `agent-task:${taskId}`,
        requestDigest: agentTaskFactDigest(runInput),
        input: runInput,
        runInput,
        dispatch: 'queued',
      },
    },
    { type: 'execution.claimed', payload: { executionId: child.executionId } },
  ]);
  async function runChild(onModel?: () => Promise<void>) {
    onChildModel = onModel;
    for await (const event of runner.run({
      ...runInput,
      sessionId: child.sessionId,
      executionIdentity: childExecutionIdentity,
      toolAuthority,
    }))
      void event;
  }
  async function setFolder(folderPath: string) {
    const response = await app.request(`/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
    expect(response.status).toBe(200);
  }
  return {
    a,
    b,
    app,
    project,
    binding,
    projectFolderAuthority,
    agentTaskWorkspace,
    toolAuthority,
    broker,
    store,
    runChild,
    setFolder,
    seenInstructions,
    foreignBindingError,
  };
}

it.each(['different', 'same', 'aba'] as const)(
  'leaves both roots untouched when approval follows a %s folder update',
  async (mode) => {
    const f = await fixture();
    const pending = new Promise<string>((resolve) => {
      f.broker.subscribe(({ type, request }) => {
        if (type === 'approval.created' && request.toolCallId === 'write')
          resolve(request.approvalId);
      });
    });
    const execution = f.runChild();
    const approvalId = await Promise.race([
      pending,
      execution.then(() => {
        throw new Error('Child ended before asking for approval');
      }),
    ]);
    await f.setFolder(mode === 'same' ? f.a : f.b);
    if (mode === 'aba') await f.setFolder(f.a);
    expect(f.broker.approve(approvalId).status).toBe('approved');
    await execution;
    await expect(readFile(join(f.a, 'new/file'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.b, 'new/file'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.seenInstructions[0]).toContain('Pinned instructions');
    const events = await f.store.read(child.sessionId);
    expect(events.some(({ type }) => type === 'workspace.file-write-intent')).toBe(false);
  },
);

it.each(['folder-update', 'root-replacement'] as const)(
  'does not create directories when a %s occurs during a child write intent',
  async (change) => {
    const f = await fixture();
    const append = f.store.append.bind(f.store);
    let writing!: () => void;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    f.store.append = async (sessionId, writes) => {
      const events = await append(sessionId, writes);
      if (writes[0]?.type === 'workspace.file-write-intent') {
        writing();
        await gate;
      }
      return events;
    };
    f.broker.subscribe(({ type, request }) => {
      if (type === 'approval.created') queueMicrotask(() => f.broker.approve(request.approvalId));
    });
    const execution = f.runChild();
    await Promise.race([
      entered,
      execution.then(() => {
        throw new Error('Child ended before the file write intent');
      }),
    ]);
    try {
      if (change === 'folder-update') await f.setFolder(f.b);
      else {
        await rename(f.a, `${f.a}-replaced`);
        await mkdir(f.a);
      }
    } finally {
      resume();
    }
    await execution;
    await expect(readFile(join(f.a, 'new/file'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(f.b, 'new/file'))).rejects.toMatchObject({ code: 'ENOENT' });
    const events = await f.store.read(child.sessionId);
    expect(events.find(({ type }) => type === 'workspace.file-write')).toMatchObject({
      payload: { status: 'failed' },
    });
  },
);

it('rejects a root replacement during the child Session read before starting the Turn', async () => {
  const f = await fixture();
  const read = f.store.read.bind(f.store);
  f.store.read = async (sessionId, options) => {
    if (sessionId === child.sessionId) {
      f.store.read = read;
      await rename(f.a, `${f.a}-replaced`);
      await mkdir(f.a);
    }
    return read(sessionId, options);
  };
  await expect(f.runChild()).rejects.toMatchObject({ code: 'task-project-root-changed' });
  const events = await f.store.read(child.sessionId);
  expect(events.some(({ type }) => type === 'turn.started')).toBe(false);
  expect(f.seenInstructions).toEqual([]);
});

it('preserves a captured no-folder result even with a dynamic workspace fallback', async () => {
  const f = await fixture(false);
  await f.runChild(async () => {
    expect(
      await f.agentTaskWorkspace.resolveRoot(child.sessionId, f.toolAuthority),
    ).toBeUndefined();
    await f.setFolder(f.a);
    await expect(
      f.agentTaskWorkspace.resolveRoot(child.sessionId, f.toolAuthority),
    ).rejects.toMatchObject({
      code: 'task-project-folder-changed',
    });
    expect(await f.agentTaskWorkspace.resolveRoot(child.sessionId)).toBe(f.a);
  });
});

it('resolves the canonical root only while the exact child authority is active', async () => {
  const f = await fixture();
  f.broker.subscribe(({ type, request }) => {
    if (type === 'approval.created') queueMicrotask(() => f.broker.approve(request.approvalId));
  });
  await f.runChild(async () => {
    expect(await f.agentTaskWorkspace.resolveRoot(child.sessionId, f.toolAuthority)).toBe(
      await realpath(f.a),
    );
    await expect(
      f.agentTaskWorkspace.resolveRoot(child.sessionId, { ...f.toolAuthority }),
    ).rejects.toBeDefined();
    expect(() =>
      f.agentTaskWorkspace.assertMutationCurrent({
        sessionId: child.sessionId,
        signal: new AbortController().signal,
        toolAuthority: { ...f.toolAuthority },
      }),
    ).toThrow();
  });
  await expect(
    f.agentTaskWorkspace.resolveRoot(child.sessionId, f.toolAuthority),
  ).rejects.toMatchObject({
    code: 'tool-not-permitted',
  });
  expect(await readFile(join(f.a, 'new/file'), 'utf8')).toBe('written');
});

it('rejects a same-Project binding captured for a Session other than the spawning parent', async () => {
  const f = await fixture(true, true);
  expect(f.foreignBindingError).toMatchObject({ code: 'task-project-authority-invalid' });
});
