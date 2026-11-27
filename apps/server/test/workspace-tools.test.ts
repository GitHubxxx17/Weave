import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLlmProviderRegistry } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { createRuntime } from '@weave/runtime';
import { createInMemorySessionEventStore } from '@weave/session';
import { createInMemoryProjectStore, type ProjectStore } from '@weave/workspace';
import { createApp } from '../src/app.js';
import { runAgentTurn } from './agent-run-helper.js';
import { createSessionService } from '../src/session-service.js';
import {
  approvalBrokerService,
  createServerAgentRunner,
  createServerRuntime,
  getServerSessionStore,
  type ServerAgentRunnerOptions,
} from '../src/runtime.js';
import { parseAgentMaxSteps } from '../src/main.js';
import { createWorkspaceRootResolver } from '../src/workspace-root.js';
import { createAgentInstructions, readProjectInstructions } from '../src/agent-instructions.js';

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
  runnerOptions: Omit<ServerAgentRunnerOptions, 'resolveWorkspaceRoot'> = {},
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

  const runner = await createServerAgentRunner(runtime, {
    resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
    ...runnerOptions,
  });
  const app = createApp(runtime, {
    sessionService,
    projectStore,
  });
  const broker = runtime.get(approvalBrokerService);

  async function run(text: string): Promise<string> {
    return runAgentTurn(runner, {
      sessionId: session.id,
      userMessage: { role: 'user', content: [{ type: 'text', text }] },
      provider: 'mock',
      model: 'test-model',
    });
  }

  return { run, broker, app, project, session, sessionStore };
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

  it('edits a file after an Approval that shows the diff', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'app.ts'), 'const a = 1;\nconst b = 2;\n', 'utf8');
    const { run, broker } = await createAgentApp(
      [
        toolCallScript('call-edit', 'edit_file', {
          path: 'app.ts',
          oldText: 'const a = 1;',
          newText: 'const a = 10;',
        }),
        finalText,
      ],
      folder,
    );
    const diffs: string[] = [];
    const unsubscribe = broker.subscribe((event) => {
      if (event.type === 'approval.created') {
        diffs.push((event.request.inputSummary as { diff: string }).diff);
        broker.approve(event.request.approvalId);
      }
    });
    cleanups.push(async () => unsubscribe());

    const body = await run('把 a 改成 10');

    expect(diffs[0]).toContain('-const a = 1;\n+const a = 10;');
    expect(body).toContain('"name":"edit_file"');
    await expect(readFile(join(folder, 'app.ts'), 'utf8')).resolves.toBe(
      'const a = 10;\nconst b = 2;\n',
    );
  });

  it.skipIf(process.platform === 'win32')(
    'runs a command in the Project folder after Approval',
    async () => {
      const folder = await createTemporaryFolder();
      const { run, broker } = await createAgentApp(
        [
          toolCallScript('call-cmd', 'run_command', {
            risk: 'low',
            riskReason: 'test',
            command: 'echo hello-from-command',
          }),
          finalText,
        ],
        folder,
        { commandEnvironment: () => ({ ...process.env }) },
      );
      const unsubscribe = broker.subscribe((event) => {
        if (event.type === 'approval.created') {
          expect(event.request).toMatchObject({
            toolName: 'run_command',
            risk: 'high',
            inputSummary: { command: 'echo hello-from-command', cwd: '.' },
          });
          broker.approve(event.request.approvalId);
        }
      });
      cleanups.push(async () => unsubscribe());

      const body = await run('运行一个命令');

      expect(body).toContain('exit code: 0');
      expect(body).toContain('hello-from-command');
      expect(body).toMatch(/event: completed\n/);
    },
  );

  it('completes the turn with a reason at the configured step limit', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'README.md'), '项目说明', 'utf8');
    const { run } = await createAgentApp(
      [toolCallScript('call-read', 'read_file', { path: 'README.md' })],
      folder,
      { maxSteps: 1 },
    );

    const body = await run('读一下 README');

    expect(body).toMatch(
      /event: completed\ndata: \{"type":"completed","turnId":"[^"]+","reason":"agent-step-limit"\}/,
    );
  });
});

describe('Agent step limit setting', () => {
  it('reads WEAVE_AGENT_MAX_STEPS and rejects invalid values', () => {
    expect(parseAgentMaxSteps(undefined)).toBeUndefined();
    expect(parseAgentMaxSteps(' ')).toBeUndefined();
    expect(parseAgentMaxSteps('20')).toBe(20);
    expect(() => parseAgentMaxSteps('0')).toThrow(/WEAVE_AGENT_MAX_STEPS/);
    expect(() => parseAgentMaxSteps('2.5')).toThrow(/WEAVE_AGENT_MAX_STEPS/);
    expect(() => parseAgentMaxSteps('many')).toThrow(/WEAVE_AGENT_MAX_STEPS/);
  });
});

describe('Built-in mock /tool commands', () => {
  it('calls the requested tools through Approval and summarizes the results', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'README.md'), '项目说明', 'utf8');
    // The default Providers include the built-in `mock` that understands /tool.
    const runtime = createServerRuntime();
    await runtime.start();
    cleanups.push(() => runtime.stop());
    const projectStore = createInMemoryProjectStore();
    cleanups.push(() => projectStore.close());
    const project = await projectStore.createProject({
      name: 'Mock',
      folderName: 'mock',
      folderPath: folder,
    });
    const sessionService = createSessionService({
      projectStore,
      sessionStore: getServerSessionStore(runtime),
    });
    const session = await sessionService.create(project.id);
    const runner = await createServerAgentRunner(runtime, {
      resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
    });
    const broker = runtime.get(approvalBrokerService);
    const approved: string[] = [];
    const unsubscribe = broker.subscribe((event) => {
      if (event.type === 'approval.created') {
        approved.push(event.request.toolName);
        broker.approve(event.request.approvalId);
      }
    });
    cleanups.push(async () => unsubscribe());

    const body = await runAgentTurn(runner, {
      sessionId: session.id,
      userMessage: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '/tool read_file {"path":"README.md"}',
              '/tool write_file {"path":"notes/mock.md","content":"mock 测试"}',
            ].join('\n'),
          },
        ],
      },
      provider: 'mock',
      model: 'weave-local-demo',
    });

    expect(body).toContain('"name":"read_file","content":"项目说明"');
    expect(approved).toEqual(['write_file']);
    expect(body).toContain(
      '（本地演示）收到 2 个工具结果：\\n- read_file：项目说明\\n- write_file：',
    );
    expect(body).toMatch(/event: completed\n/);
    await expect(readFile(join(folder, 'notes', 'mock.md'), 'utf8')).resolves.toBe('mock 测试');
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
  const allTools = [
    { name: 'list_dir', readOnly: true },
    { name: 'glob', readOnly: true },
    { name: 'grep', readOnly: true },
    { name: 'read_file', readOnly: true },
    { name: 'edit_file' },
    { name: 'write_file' },
    { name: 'run_command' },
    { name: 'recall', readOnly: true },
  ];
  const fixedEnvironment = {
    platform: 'darwin' as const,
    shell: '/bin/zsh',
    now: () => new Date(2026, 10, 18, 9, 30),
    gitBranch: async () => 'main',
    projectInstructions: async () => undefined,
  };

  it('tells the model its tools, how to use them and the Project folder', async () => {
    const instructions = createAgentInstructions({
      tools: () => allTools,
      resolveWorkspaceRoot: async () => '/Users/me/demo',
      environment: fixedEnvironment,
    });

    const text = await instructions({ sessionId: 'session-1' });

    expect(text).toContain('Weave Agent');
    expect(text).toContain(
      '本轮可用的工具：list_dir、glob、grep、read_file、edit_file、write_file、run_command、recall。',
    );
    expect(text).toContain('先用 list_dir、glob、grep 找到相关文件，再用 read_file 读需要的部分');
    expect(text).toContain('修改已有文件用 edit_file');
    expect(text).toContain('用 run_command 运行相关的测试');
    expect(text).toContain(
      '权限：当前是"常规"模式。edit_file、write_file、run_command 每次都要用户在界面上确认；命令不在沙箱中运行。',
    );
    expect(text).toContain('- 系统 macOS，Shell /bin/zsh，今天是 2026-11-18');
    expect(text).toContain('- 当前项目文件夹：/Users/me/demo，Git 分支 main');
    expect(text).toContain('相对这个文件夹的路径');
    expect(text).toContain('recall');
  });

  it('lists every tool and explains the mode in trust and yolo runs', async () => {
    const instructions = createAgentInstructions({
      tools: () => allTools,
      resolveWorkspaceRoot: async () => '/Users/me/demo',
      environment: fixedEnvironment,
    });

    const trust = await instructions({ sessionId: 'session-1', permissionMode: 'trust' });
    expect(trust).toContain(
      '本轮可用的工具：list_dir、glob、grep、read_file、edit_file、write_file、run_command、recall。',
    );
    expect(trust).toContain('当前是"信任"模式');
    expect(trust).toContain('写入敏感文件');

    const yolo = await instructions({ sessionId: 'session-1', permissionMode: 'yolo' });
    expect(yolo).toContain('当前是"完全访问"模式');
    expect(yolo).toContain('edit_file、write_file、run_command');
  });

  it('includes the AGENTS.md of the Project folder', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(
      join(folder, 'AGENTS.md'),
      '# Rules\n\nRun pnpm check before committing.\n',
      'utf8',
    );
    const instructions = createAgentInstructions({
      tools: () => allTools,
      resolveWorkspaceRoot: async () => folder,
      environment: { ...fixedEnvironment, projectInstructions: readProjectInstructions },
    });

    const text = await instructions({ sessionId: 'session-1' });

    expect(text).toContain('项目说明（来自项目根目录的 AGENTS.md，请遵守其中的约定）：\n# Rules');
    expect(text).toContain('Run pnpm check before committing.');
  });

  it('reads at most 32 KB of AGENTS.md and ignores a symlink that leaves the folder', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'AGENTS.md'), `${'rule line\n'.repeat(5000)}`, 'utf8');
    const long = await readProjectInstructions(folder);
    expect(long?.truncated).toBe(true);
    expect(Buffer.byteLength(long?.text ?? '', 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(long?.text.endsWith('rule line')).toBe(true);

    const outside = await createTemporaryFolder();
    const linked = await createTemporaryFolder();
    await writeFile(join(outside, 'AGENTS.md'), 'outside rules', 'utf8');
    await symlink(join(outside, 'AGENTS.md'), join(linked, 'AGENTS.md'));
    await expect(readProjectInstructions(linked)).resolves.toBeUndefined();
    await expect(readProjectInstructions(await createTemporaryFolder())).resolves.toBeUndefined();
  });

  it('tells the model when the Project has no folder', async () => {
    const instructions = createAgentInstructions({
      tools: () => allTools,
      resolveWorkspaceRoot: async () => undefined,
      environment: fixedEnvironment,
    });

    await expect(instructions({ sessionId: 'session-1' })).resolves.toContain(
      '当前项目还没有设置文件夹',
    );
  });

  it('states that no tools are available when the registry is empty', async () => {
    const instructions = createAgentInstructions({
      tools: () => [],
      environment: fixedEnvironment,
    });

    const text = await instructions({ sessionId: 'session-1' });
    expect(text).toContain('本轮没有可用的工具');
    expect(text).not.toContain('文件夹');
    expect(text).not.toContain('权限');
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
    const runner = await createServerAgentRunner(runtime, {
      resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
    });

    await runAgentTurn(runner, {
      sessionId: session.id,
      userMessage: { role: 'user', content: [{ type: 'text', text: '能读文件吗' }] },
      provider: 'mock',
      model: 'test-model',
    });

    expect(requests[0]?.messages[0]?.role).toBe('system');
    expect(JSON.stringify(requests[0]?.messages[0])).toContain(`当前项目文件夹：${folder}`);
    expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
      'list_dir',
      'glob',
      'grep',
      'read_file',
      'edit_file',
      'write_file',
      'run_command',
      'recall',
      'update_plan',
      'read_skill',
      'read_skill_resource',
    ]);
  });

  it('sends every tool and the mode text when a run sets a permission mode', async () => {
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
    const runner = await createServerAgentRunner(runtime, {
      resolveWorkspaceRoot: createWorkspaceRootResolver(projectStore),
    });

    await runAgentTurn(runner, {
      sessionId: session.id,
      userMessage: { role: 'user', content: [{ type: 'text', text: '看看项目' }] },
      provider: 'mock',
      model: 'test-model',
      permissionMode: 'trust',
    });
    const toolNames = requests[0]?.tools?.map((tool) => tool.name) ?? [];
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('edit_file');
    expect(toolNames).toContain('run_command');
    expect(JSON.stringify(requests[0]?.messages[0])).toContain('信任');
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

describe('File undo API', () => {
  it('reviews and safely restores captured writes produced by the real Tool Pipeline', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'notes.md'), 'before');
    const fixture = await createAgentApp(
      [
        toolCallScript('call-edit', 'edit_file', {
          path: 'notes.md',
          oldText: 'before',
          newText: 'after',
        }),
        finalText,
      ],
      folder,
    );
    const unsubscribe = fixture.broker.subscribe((event) => {
      if (event.type === 'approval.created') fixture.broker.approve(event.request.approvalId);
    });
    cleanups.push(async () => unsubscribe());
    await fixture.run('edit notes');
    const events = await fixture.sessionStore.read(fixture.session.id);
    const started = events.find((event) => event.type === 'turn.started');
    if (started?.type !== 'turn.started') throw Error('Missing turn');
    expect(events.map((event) => event.type)).toContain('workspace.file-write-intent');
    expect(events.map((event) => event.type)).toContain('workspace.file-write');
    const base = `/projects/${fixture.project.id}/sessions/${fixture.session.id}`;
    const review = await fixture.app.request(`${base}/file-undo?turnId=${started.payload.turnId}`, {
      headers: { Host: 'localhost' },
    });
    expect(review.status).toBe(200);
    expect(await review.json()).toMatchObject({
      files: [{ path: 'notes.md', previousContent: 'before', afterContent: 'after' }],
    });
    const undo = await fixture.app.request(`${base}/undo`, {
      method: 'POST',
      headers: { Host: 'localhost', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        turnId: started.payload.turnId,
        operationId: 'actual-pipeline',
        requestId: 'restore',
      }),
    });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toMatchObject({
      results: [{ path: 'notes.md', status: 'restored' }],
    });
    expect(await readFile(join(folder, 'notes.md'), 'utf8')).toBe('before');
  });
  it('keeps legacy snapshots unavailable for safe undo', async () => {
    const folder = await createTemporaryFolder();
    await writeFile(join(folder, 'notes.md'), 'edited by agent', 'utf8');

    const runtime = createServerRuntime();
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

    await getServerSessionStore(runtime).append(session.id, [
      { type: 'turn.started', payload: { turnId: 'turn-1' } },
      {
        type: 'workspace.file-snapshot',
        payload: { path: 'notes.md', existedBefore: true, previousContent: 'original' },
      },
      { type: 'turn.completed', payload: { turnId: 'turn-1', status: 'completed' } },
    ]);

    const app = createApp(runtime, { projectStore, sessionService });
    const response = await app.request(`/projects/${project.id}/sessions/${session.id}/undo`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Host: 'localhost' },
      body: JSON.stringify({ turnId: 'turn-1', operationId: 'legacy-op', requestId: 'legacy-req' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ path: 'notes.md', status: 'unavailable', reason: 'legacy-snapshot' }],
    });
    expect(await readFile(join(folder, 'notes.md'), 'utf8')).toBe('edited by agent');
  });
});
