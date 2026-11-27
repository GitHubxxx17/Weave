import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  createWorkspaceFileTools,
  createWorkspacePolicy,
  isSensitiveWritePath,
  type ToolPermissionMode,
} from '../src/index.js';
import { approvalRequiredForMode, classifyApprovalRisk } from '../src/approval-risk.js';

const sensitivePaths = [
  '.git/config',
  '.git/hooks/pre-commit',
  '.husky/pre-commit',
  '.githooks/commit-msg',
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.github/workflows/ci.yml',
  '.github/actions/setup/action.yml',
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.buildkite/pipeline.yml',
  'package.json',
  'packages/app/package.json',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-workspace.yaml',
  'Makefile',
  'sub/Makefile',
  'justfile',
  '.envrc',
  '.vscode/tasks.json',
  '.vscode/launch.json',
  '.vscode/settings.json',
  '.devcontainer/devcontainer.json',
  '.env',
  '.env.local',
  'config/.env.production',
];

const ordinaryPaths = [
  'src/index.ts',
  'README.md',
  'docs/package-notes.md',
  'docs/.github/readme.md',
  'src/git/config.ts',
  '.vscode/extensions.json',
  'env.ts',
];

describe('isSensitiveWritePath', () => {
  it('matches every sensitive category', () => {
    for (const path of sensitivePaths) {
      expect(isSensitiveWritePath(path), path).toBe(true);
    }
  });

  it('leaves ordinary files alone', () => {
    for (const path of ordinaryPaths) {
      expect(isSensitiveWritePath(path), path).toBe(false);
    }
  });

  it('ignores case and normalizes ./ and .. segments', () => {
    for (const path of [
      '.GIT/config',
      'PACKAGE.JSON',
      './.git/config',
      'a/../.git/config',
      'src/../package.json',
      '.Github/Workflows/ci.yml',
      'makefile',
      '.ENV',
      'a\\..\\.git\\config',
    ]) {
      expect(isSensitiveWritePath(path), path).toBe(true);
    }
    expect(isSensitiveWritePath('.git/../src/index.ts')).toBe(false);
  });

  it('asks for paths that cannot be normalized inside the Workspace', () => {
    expect(isSensitiveWritePath('../outside.txt')).toBe(true);
    expect(isSensitiveWritePath('/etc/hosts')).toBe(true);
  });
});

describe('classifyApprovalRisk for file writes', () => {
  it('asks for sensitive paths and runs ordinary ones directly in trust mode', () => {
    for (const operation of ['workspace.write_file', 'workspace.edit_file']) {
      for (const path of sensitivePaths) {
        expect(approvalRequiredForMode('trust', operation, { path }), path).toBe(true);
        expect(classifyApprovalRisk(operation, { path })).toBe('ask');
      }
      for (const path of ordinaryPaths) {
        expect(approvalRequiredForMode('trust', operation, { path }), path).toBe(false);
      }
      expect(approvalRequiredForMode('ask', operation, { path: 'src/index.ts' })).toBe(true);
      expect(approvalRequiredForMode('yolo', operation, { path: '.git/config' })).toBe(false);
    }
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weave-sensitive-write-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, '.git', 'hooks'), { recursive: true });
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'package.json'), '{"name":"x"}\n', 'utf8');
  await writeFile(join(root, 'src', 'index.ts'), 'export const a = 1;\n', 'utf8');
  await symlink('package.json', join(root, 'innocent-link'));
  await symlink('.git/hooks', join(root, 'hooks-dir'));
  await symlink('.git/hooks/new-hook', join(root, 'dangling-link'));
  const approvalBroker = createApprovalBroker();
  const registry = createToolRegistry();
  const tools = createWorkspaceFileTools({ workspace: createWorkspacePolicy({ root }) });
  registry.register(tools.writeFile);
  registry.register(tools.editFile);
  return { root, approvalBroker, pipeline: createToolPipeline({ registry, approvalBroker }) };
}

function writeRequest(path: string, mode: ToolPermissionMode, id = 'write-1') {
  return {
    toolCallId: id,
    name: 'write_file',
    arguments: JSON.stringify({ path, content: 'changed\n', overwrite: true }),
    permissionMode: mode,
  };
}

function editRequest(path: string, mode: ToolPermissionMode, id = 'edit-1') {
  return {
    toolCallId: id,
    name: 'edit_file',
    arguments: JSON.stringify({ path, oldText: 'name', newText: 'label' }),
    permissionMode: mode,
  };
}

async function pendingApproval(broker: ReturnType<typeof createApprovalBroker>, id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pending = broker.list().find((r) => r.toolCallId === id && r.status === 'pending');
    if (pending !== undefined) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('No pending approval');
}

describe('write_file and edit_file in trust mode', () => {
  it('asks before writing a sensitive file and carries askReason', async () => {
    const { root, approvalBroker, pipeline } = await setup();
    const execution = pipeline.execute(writeRequest('.git/hooks/pre-commit', 'trust'));
    const pending = await pendingApproval(approvalBroker, 'write-1');

    expect(pending.operation).toBe('workspace.write_file');
    expect(pending.inputSummary).toMatchObject({
      path: '.git/hooks/pre-commit',
      askReason: 'sensitive-path',
    });
    approvalBroker.approve(pending.approvalId, '测试批准');
    await execution;
    expect(await readFile(join(root, '.git/hooks/pre-commit'), 'utf8')).toBe('changed\n');
  });

  it('asks before editing a sensitive file and carries askReason', async () => {
    const { approvalBroker, pipeline } = await setup();
    const execution = pipeline.execute(editRequest('./a/../package.json', 'trust'));
    const assertion = expect(execution).rejects.toMatchObject({ code: 'tool-approval-rejected' });
    const pending = await pendingApproval(approvalBroker, 'edit-1');

    expect(pending.inputSummary).toMatchObject({ askReason: 'sensitive-path' });
    approvalBroker.reject(pending.approvalId, '测试拒绝');
    await assertion;
  });

  it('writes ordinary files without asking and without askReason', async () => {
    const { root, approvalBroker, pipeline } = await setup();
    await pipeline.execute(writeRequest('src/index.ts', 'trust'));
    await pipeline.execute(writeRequest('docs/package-notes.md', 'trust', 'write-2'));
    expect(approvalBroker.list()).toEqual([]);
    expect(await readFile(join(root, 'src/index.ts'), 'utf8')).toBe('changed\n');
  });

  it('asks in trust mode for symbolic links that resolve to sensitive files', async () => {
    for (const path of ['innocent-link', 'hooks-dir/pre-commit']) {
      const { approvalBroker, pipeline } = await setup();
      const execution = pipeline.execute(writeRequest(path, 'trust'));
      const assertion = expect(execution).rejects.toMatchObject({ code: 'tool-approval-rejected' });
      const pending = await pendingApproval(approvalBroker, 'write-1');
      expect(pending.inputSummary, path).toMatchObject({ askReason: 'sensitive-path' });
      approvalBroker.reject(pending.approvalId, '测试拒绝');
      await assertion;
    }
  });

  it('fails a write through a dangling symbolic link without creating an approval', async () => {
    const { root, approvalBroker, pipeline } = await setup();
    await expect(pipeline.execute(writeRequest('dangling-link', 'trust'))).rejects.toMatchObject({
      code: 'tool-execution-failed',
    });
    expect(approvalBroker.list()).toEqual([]);
    await expect(readFile(join(root, '.git/hooks/new-hook'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps ask mode asking and yolo mode silent', async () => {
    const { approvalBroker, pipeline } = await setup();
    const asking = pipeline.execute(writeRequest('src/index.ts', 'ask'));
    const assertion = expect(asking).rejects.toMatchObject({ code: 'tool-approval-rejected' });
    const pending = await pendingApproval(approvalBroker, 'write-1');
    expect(pending.inputSummary).not.toHaveProperty('askReason');
    approvalBroker.reject(pending.approvalId, '测试拒绝');
    await assertion;

    const { approvalBroker: yoloBroker, pipeline: yoloPipeline } = await setup();
    await yoloPipeline.execute(writeRequest('.git/hooks/pre-commit', 'yolo'));
    expect(yoloBroker.list()).toEqual([]);
  });
});
