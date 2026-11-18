import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApprovalBroker,
  createCommandTool,
  createToolPipeline,
  createToolRegistry,
  createWorkspacePolicy,
  filterCommandEnvironment,
  resolveLoginShellEnvironment,
  type ApprovalRequest,
} from '../src/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weave-command-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'pkg'));
  await writeFile(join(root, 'file.txt'), 'x', 'utf8');
  return root;
}

function createPipeline(root: string, environment?: () => NodeJS.ProcessEnv) {
  const approvalBroker = createApprovalBroker();
  const registry = createToolRegistry();
  registry.register(
    createCommandTool({
      workspace: createWorkspacePolicy({ root }),
      shell: '/bin/sh',
      environment: environment ?? (() => ({ ...process.env })),
      killGraceMs: 200,
    }),
  );
  return { approvalBroker, pipeline: createToolPipeline({ registry, approvalBroker }) };
}

async function waitForApproval(
  approvalBroker: ReturnType<typeof createApprovalBroker>,
  execution: Promise<unknown>,
): Promise<ApprovalRequest | undefined> {
  let settled = false;
  execution.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = approvalBroker.list().find((request) => request.status === 'pending');
    if (pending !== undefined) {
      return pending;
    }
    if (settled) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('No pending approval');
}

async function runApproved(
  root: string,
  args: Record<string, unknown>,
  environment?: () => NodeJS.ProcessEnv,
): Promise<string> {
  const { approvalBroker, pipeline } = createPipeline(root, environment);
  const execution = pipeline.execute({
    toolCallId: 'command-1',
    name: 'run_command',
    arguments: JSON.stringify(args),
  });
  const pending = await waitForApproval(approvalBroker, execution);
  if (pending !== undefined) {
    approvalBroker.approve(pending.approvalId);
  }
  return (await execution).content;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')('run_command', () => {
  it('asks for Approval with the command, folder and timeout', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'command-1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'echo hi', cwd: 'pkg' }),
    });
    const pending = (await waitForApproval(approvalBroker, execution))!;

    expect(pending).toMatchObject({
      toolName: 'run_command',
      operation: 'shell.run_command',
      risk: 'high',
      summary: '运行命令：echo hi',
      inputSummary: { command: 'echo hi', cwd: 'pkg', timeoutMs: 120_000 },
    });
    approvalBroker.reject(pending.approvalId);
    await expect(execution).rejects.toMatchObject({ code: 'tool-approval-rejected' });
  });

  it('returns the exit code and merged output without failing on a non-zero exit', async () => {
    const root = await createWorkspace();

    const output = await runApproved(root, { command: 'echo out; echo err 1>&2; exit 3' });

    expect(output).toMatch(
      /^\$ echo out; echo err 1>&2; exit 3\nexit code: 3 · \d+\.\d s\n--- 输出 ---\n/,
    );
    expect(output).toContain('out');
    expect(output).toContain('err');
  });

  it('runs in the requested folder and strips terminal colours', async () => {
    const root = await createWorkspace();

    const output = await runApproved(root, {
      command: "pwd; printf '\\033[31mred\\033[0m\\n'",
      cwd: 'pkg',
    });

    expect(output).toContain('（工作目录：pkg）');
    expect(output).toMatch(/\/pkg\n/);
    expect(output).toContain('red');
    expect(output).not.toContain('\u001b');
  });

  it('rejects a folder outside the Workspace or a file before asking', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'outside',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'ls', cwd: '..' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-outside-root' }),
    });
    await expect(
      pipeline.execute({
        toolCallId: 'file',
        name: 'run_command',
        arguments: JSON.stringify({ command: 'ls', cwd: 'file.txt' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-not-directory' }),
    });
    expect(approvalBroker.list()).toEqual([]);
  });

  it('hides Weave settings and credential variables from the command', async () => {
    const root = await createWorkspace();

    const output = await runApproved(root, { command: 'env' }, () => ({
      PATH: process.env.PATH,
      WEAVE_LLM_PROVIDERS: '[{"apiKey":"provider-secret"}]',
      OPENAI_API_KEY: 'sk-test-secret',
      GITHUB_TOKEN: 'ghp-test-secret',
      DB_PASSWORD: 'db-test-secret',
      NORMAL_VAR: 'visible',
    }));

    expect(output).toContain('NORMAL_VAR=visible');
    expect(output).toContain('NO_COLOR=1');
    expect(output).toContain('GIT_TERMINAL_PROMPT=0');
    expect(output).not.toMatch(/provider-secret|sk-test-secret|ghp-test-secret|db-test-secret/);
  });

  it('keeps the beginning and end of long output', async () => {
    const root = await createWorkspace();

    const output = await runApproved(root, {
      command: 'i=0; while [ $i -lt 3000 ]; do echo "line $i of the long output"; i=$((i+1)); done',
    });

    expect(output).toContain('line 0 of the long output');
    expect(output).toContain('line 2999 of the long output');
    expect(output).toMatch(/…省略中间约 \d+ 行（[\d.]+ KB）…/);
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(32_000);
  });

  it('stops the whole process group when the command times out', async () => {
    const root = await createWorkspace();

    const started = Date.now();
    const output = await runApproved(root, {
      command: 'sleep 30 & echo "child $!"; wait',
      timeoutMs: 1000,
    });

    expect(Date.now() - started).toBeLessThan(10_000);
    expect(output).toMatch(/已超时：运行 [\d.]+ 秒后被终止/);
    const pid = Number(/child (\d+)/.exec(output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isRunning(pid)).toBe(false);
  });

  it('stops background processes that outlive the shell', async () => {
    const root = await createWorkspace();

    const output = await runApproved(root, { command: 'sleep 30 & echo "child $!"' });

    expect(output).toContain('exit code: 0');
    expect(output).toContain('已将其结束');
    const pid = Number(/child (\d+)/.exec(output)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isRunning(pid)).toBe(false);
  });

  it('maps cancellation to tool-cancelled and stops the command', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);
    const controller = new AbortController();

    const execution = pipeline.execute({
      toolCallId: 'command-1',
      name: 'run_command',
      arguments: JSON.stringify({ command: 'sleep 30' }),
      signal: controller.signal,
    });
    const pending = (await waitForApproval(approvalBroker, execution))!;
    approvalBroker.approve(pending.approvalId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    controller.abort();

    await expect(execution).rejects.toMatchObject({ code: 'tool-cancelled' });
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe('command environment', () => {
  it('drops Weave and credential variables and pins non-interactive output', () => {
    expect(
      filterCommandEnvironment({
        PATH: '/usr/bin',
        WEAVE_DATA_DIR: '/data',
        AWS_SECRET_ACCESS_KEY: 'secret',
        NPM_TOKEN: 'token',
        MY_PASSWORD: 'password',
        LANG: 'zh_CN.UTF-8',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      LANG: 'zh_CN.UTF-8',
      NO_COLOR: '1',
      TERM: 'dumb',
      PAGER: 'cat',
      GIT_PAGER: 'cat',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it.skipIf(process.platform === 'win32')(
    'reads the login shell environment between markers and falls back on timeout',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'weave-shell-'));
      temporaryDirectories.push(directory);
      const fakeShell = join(directory, 'fake-shell');
      await writeFile(
        fakeShell,
        [
          '#!/bin/sh',
          "printf 'noise printed by startup files\\n'",
          "printf '%s' '__WEAVE_ENV_START__'",
          "printf 'FOO=bar\\000MULTI=line1\\nline2\\000'",
          "printf '%s' '__WEAVE_ENV_END__'",
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(fakeShell, 0o755);
      const slowShell = join(directory, 'slow-shell');
      await writeFile(slowShell, '#!/bin/sh\nsleep 5\n', 'utf8');
      await chmod(slowShell, 0o755);

      await expect(
        resolveLoginShellEnvironment({ shell: fakeShell, baseEnvironment: { BASE: '1' } }),
      ).resolves.toEqual({ FOO: 'bar', MULTI: 'line1\nline2' });
      await expect(
        resolveLoginShellEnvironment({
          shell: slowShell,
          timeoutMs: 200,
          baseEnvironment: { BASE: '1' },
        }),
      ).resolves.toEqual({ BASE: '1' });
    },
  );
});
