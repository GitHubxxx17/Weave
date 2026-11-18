import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLlmProviderRegistry } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createRuntime } from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { createSessionService } from '../src/session-service.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  getServerSessionStore,
} from '../src/runtime.js';
import { createWorkspaceRootResolver } from '../src/workspace-root.js';
import { createAgentInstructions } from '../src/agent-instructions.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function createTemporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'weave-server-workspace-'));
  cleanups.push(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

function createSequenceClient(scripts: readonly (readonly StreamEvent[])[]) {
  let index = 0;
  return {
    async *stream() {
      const script = scripts[index];
      index += 1;
      if (script === undefined) {
        throw new Error('Unexpected mock Provider request');
      }
      yield* script;
    },
  };
}

function toolCallScript(id: string, name: string, args: unknown): readonly StreamEvent[] {
  return [
    { type: 'tool-call-start', id, name },
    { type: 'tool-call-delta', id, argumentsDelta: JSON.stringify(args) },
    { type: 'finish', reason: 'tool-call' },
  ];
}

const finalText: readonly StreamEvent[] = [
  { type: 'text-delta', text: '完成' },
  { type: 'finish', reason: 'stop' },
];

async function createAgentApp(
  scripts: readonly (readonly StreamEvent[])[],
  folderPath: string | undefined,
) {
  const registry = createLlmProviderRegistry([
    {
      id: 'mock',
      label: '本地演示',
      type: 'mock',
      client: createSequenceClient(scripts),
      defaultModel: 'test-model',
    },
  ]);
  const runtime = createServerRuntime({
    providerSettings: { registry, providers: registry.list(), defaultProvider: 'mock' },
  });
  await runtime.start();
  cleanups.push(() => runtime.stop());

  const projectStore = createInMemoryProjectStore();
  cleanups.push(() => projectStore.close());
  const project = await projectStore.createProject({
    name: 'Files',
    folderName: 'files',
    ...(folderPath === undefined ? {} : { folderPath }),
  });
  const sessionStore = getServerSessionStore(runtime);
  const sessionService = createSessionService({ projectStore, sessionStore });
  const session = await sessionService.create(project.id);

  const app = createApp(runtime, {
    agentRunner: createServerAgentRunner(runtime, {
      resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
    }),
    sessionService,
  });
  const broker = runtime.get(approvalBrokerService);

  async function run(text: string): Promise<string> {
    const response = await app.request('/agent/runs/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: { role: 'user', content: [{ type: 'text', text }] },
        provider: 'mock',
        model: 'test-model',
      }),
    });
    expect(response.status).toBe(200);
    return response.text();
  }

  return { run, broker };
}

describe('Workspace root resolver', () => {
  it('returns the folder of the Project that owns the Session', async () => {
    const projectStore: ProjectStore = createInMemoryProjectStore();
    cleanups.push(() => projectStore.close());
    const withFolder = await projectStore.createProject({
      name: 'A',
      folderName: 'a',
      folderPath: '/tmp/a',
    });
    const withoutFolder = await projectStore.createProject({ name: 'B', folderName: 'b' });
    await projectStore.attachSession(withFolder.id, 'session-a');
    await projectStore.attachSession(withoutFolder.id, 'session-b');
    const resolve = createWorkspaceRootResolver(projectStore);

    await expect(resolve('session-a')).resolves.toBe('/tmp/a');
    await expect(resolve('session-b')).resolves.toBeUndefined();
    await expect(resolve('missing')).resolves.toBeUndefined();
  });
});

describe('Default Agent Workspace file tools', () => {
  it('reads a file from the Project folder of the Session', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'README.md'), '项目说明', 'utf8');
    const { run } = await createAgentApp(
      [toolCallScript('call-read', 'read_file', { path: 'README.md' }), finalText],
      folder,
    );

    const body = await run('读一下 README');

    expect(body).toContain('"name":"read_file","content":"项目说明"');
    expect(body).toMatch(/event: completed\n/);
  });

  it('writes a file only after the pending Approval is approved', async () => {
    const folder = await createTemporaryFolder();
    const { run, broker } = await createAgentApp(
      [
        toolCallScript('call-write', 'write_file', { path: 'notes.md', content: '新内容' }),
        finalText,
      ],
      folder,
    );

    const unsubscribe = broker.subscribe((event) => {
      if (event.type === 'approval.created') {
        expect(event.request).toMatchObject({
          toolName: 'write_file',
          risk: 'high',
          inputSummary: { path: 'notes.md', bytes: 9, overwrite: false },
        });
        broker.approve(event.request.approvalId, '测试同意');
      }
    });
    cleanups.push(async () => unsubscribe());

    const body = await run('写一个文件');

    expect(body).toContain('"name":"write_file"');
    expect(body).toMatch(/event: completed\n/);
    await expect(readFile(join(folder, 'notes.md'), 'utf8')).resolves.toBe('新内容');
  });

  it('returns a rejected write to the model without touching the folder', async () => {
    const folder = await createTemporaryFolder();
    const { run, broker } = await createAgentApp(
      [toolCallScript('call-write', 'write_file', { path: 'notes.md', content: 'x' }), finalText],
      folder,
    );
    const unsubscribe = broker.subscribe((event) => {
      if (event.type === 'approval.created') {
        broker.reject(event.request.approvalId, '不需要');
      }
    });
    cleanups.push(async () => unsubscribe());

    const body = await run('写一个文件');

    expect(body).toContain('"status":"failed","errorCode":"tool-approval-rejected"');
    expect(body).toMatch(/event: completed\n/);
    await expect(readFile(join(folder, 'notes.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reports a missing Project folder to the model and still completes the turn', async () => {
    const { run } = await createAgentApp(
      [toolCallScript('call-read', 'read_file', { path: 'README.md' }), finalText],
      undefined,
    );

    const body = await run('读一下 README');

    expect(body).toContain('workspace-file-unavailable');
    expect(body).toContain('"status":"failed","errorCode":"tool-execution-failed"');
    expect(body).toMatch(/event: completed\n/);
  });
});

describe('Project folder validation', () => {
  async function createProjectApp() {
    const runtime = createRuntime();
    await runtime.start();
    const projectStore = createInMemoryProjectStore();
    const sessionStore = createInMemorySessionEventStore();
    cleanups.push(
      () => runtime.stop(),
      () => projectStore.close(),
      () => sessionStore.close(),
    );
    const sessionService = createSessionService({ projectStore, sessionStore });
    return createApp(runtime, { projectStore, sessionService });
  }

  function postProject(app: Awaited<ReturnType<typeof createProjectApp>>, folderPath: string) {
    return app.request('/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'P', folderName: 'p', folderPath }),
    });
  }

  it('accepts an existing absolute directory', async () => {
    const folder = await createTemporaryFolder();
    const response = await postProject(await createProjectApp(), folder);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ folderPath: folder });
  });

  it('rejects relative, missing, and file paths', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'file.txt'), 'x', 'utf8');
    const app = await createProjectApp();

    for (const folderPath of ['relative/path', join(folder, 'missing'), join(folder, 'file.txt')]) {
      const response = await postProject(app, folderPath);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'project-folder-invalid' } });
    }
  });
});

describe('Default Agent instructions', () => {
  it('tells the model its tools and the Project folder', async () => {
    const instructions = createAgentInstructions({
      toolNames: () => ['read_file', 'write_file'],
      resolveWorkspaceRoot: async () => '/Users/me/demo',
    });

    const text = await instructions({ sessionId: 'session-1' });

    expect(text).toContain('Weave Agent');
    expect(text).toContain('read_file、write_file');
    expect(text).toContain('当前项目文件夹：/Users/me/demo');
    expect(text).toContain('相对这个文件夹的路径');
  });

  it('tells the model when the Project has no folder', async () => {
    const instructions = createAgentInstructions({
      toolNames: () => ['read_file', 'write_file'],
      resolveWorkspaceRoot: async () => undefined,
    });

    await expect(instructions({ sessionId: 'session-1' })).resolves.toContain(
      '当前项目还没有设置文件夹',
    );
  });

  it('states that no tools are available when the registry is empty', async () => {
    const instructions = createAgentInstructions({ toolNames: () => [] });

    const text = await instructions({ sessionId: 'session-1' });
    expect(text).toContain('本轮没有可用的工具');
    expect(text).not.toContain('文件夹');
  });

  it('is sent as the first message of every model request', async () => {
    const folder = await createTemporaryFolder();
    const requests: LlmRequest[] = [];
    const registry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: {
          async *stream(request) {
            requests.push(structuredClone(request));
            yield { type: 'text-delta', text: '好的' } as const;
            yield { type: 'finish', reason: 'stop' } as const;
          },
        },
        defaultModel: 'test-model',
      },
    ]);
    const runtime = createServerRuntime({
      providerSettings: { registry, providers: registry.list(), defaultProvider: 'mock' },
    });
    await runtime.start();
    cleanups.push(() => runtime.stop());
    const projectStore = createInMemoryProjectStore();
    cleanups.push(() => projectStore.close());
    const project = await projectStore.createProject({
      name: 'Files',
      folderName: 'files',
      folderPath: folder,
    });
    const sessionService = createSessionService({
      projectStore,
      sessionStore: getServerSessionStore(runtime),
    });
    const session = await sessionService.create(project.id);
    const app = createApp(runtime, {
      agentRunner: createServerAgentRunner(runtime, {
        resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
      }),
      sessionService,
    });

    const response = await app.request('/agent/runs/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.id,
        userMessage: { role: 'user', content: [{ type: 'text', text: '能读文件吗' }] },
        provider: 'mock',
        model: 'test-model',
      }),
    });
    await response.text();

    expect(requests[0]?.messages[0]?.role).toBe('system');
    expect(JSON.stringify(requests[0]?.messages[0])).toContain(`当前项目文件夹：${folder}`);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(['read_file', 'write_file']);
  });
});

describe('Project folder update API', () => {
  async function createApiApp() {
    const runtime = createRuntime();
    await runtime.start();
    const projectStore = createInMemoryProjectStore();
    const sessionStore = createInMemorySessionEventStore();
    cleanups.push(
      () => runtime.stop(),
      () => projectStore.close(),
      () => sessionStore.close(),
    );
    const sessionService = createSessionService({ projectStore, sessionStore });
    const project = await projectStore.createProject({ name: 'Old', folderName: 'old' });
    return { app: createApp(runtime, { projectStore, sessionService }), project, projectStore };
  }

  function patchFolder(
    app: Awaited<ReturnType<typeof createApiApp>>['app'],
    projectId: string,
    folderPath: string | null,
  ) {
    return app.request(`/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ folderPath }),
    });
  }

  it('sets and clears the folder of an existing Project', async () => {
    const folder = await createTemporaryFolder();
    const { app, project, projectStore } = await createApiApp();

    const setResponse = await patchFolder(app, project.id, folder);
    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toMatchObject({ id: project.id, folderPath: folder });
    expect((await projectStore.getProject(project.id))?.folderPath).toBe(folder);

    const clearResponse = await patchFolder(app, project.id, null);
    expect(clearResponse.status).toBe(200);
    expect((await projectStore.getProject(project.id))?.folderPath).toBeUndefined();
  });

  it('rejects a missing folder and an unknown Project', async () => {
    const folder = await createTemporaryFolder();
    const { app, project } = await createApiApp();

    const invalid = await patchFolder(app, project.id, join(folder, 'missing'));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: { code: 'project-folder-invalid' } });

    const unknown = await patchFolder(app, 'missing-project', folder);
    expect(unknown.status).toBe(404);
  });

  function patchProject(
    app: Awaited<ReturnType<typeof createApiApp>>['app'],
    projectId: string,
    body: unknown,
  ) {
    return app.request(`/projects/${projectId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('renames a Project, alone or together with its folder', async () => {
    const folder = await createTemporaryFolder();
    const { app, project, projectStore } = await createApiApp();

    const renamed = await patchProject(app, project.id, { name: 'New' });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: project.id, name: 'New', folderName: 'old' });

    const both = await patchProject(app, project.id, { name: 'Both', folderPath: folder });
    expect(both.status).toBe(200);
    expect(await projectStore.getProject(project.id)).toMatchObject({
      name: 'Both',
      folderPath: folder,
    });
  });

  it('rejects an empty update and keeps the name when the folder is invalid', async () => {
    const folder = await createTemporaryFolder();
    const { app, project, projectStore } = await createApiApp();

    const empty = await patchProject(app, project.id, {});
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: { code: 'workspace-store-invalid-input' } });

    const blankName = await patchProject(app, project.id, { name: '' });
    expect(blankName.status).toBe(400);

    const badFolder = await patchProject(app, project.id, {
      name: 'Renamed',
      folderPath: join(folder, 'missing'),
    });
    expect(badFolder.status).toBe(400);
    expect((await projectStore.getProject(project.id))?.name).toBe('Old');
  });
});
