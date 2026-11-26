import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createApprovalBroker,
  createToolPipeline,
  createToolRegistry,
  createWorkspaceFileTools,
  createWorkspacePolicy,
  type ToolPermissionMode,
} from '../src/index.js';
import { isSecretFile } from '../src/secret-files.js';

const secretContent = 'API_KEY=super-secret-value';
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'weave-read-secret-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'config'));
  for (const file of [
    '.env',
    'config/.env.local',
    'README.md',
    'env.ts',
    '.environment',
    'config/my.env',
  ]) {
    await writeFile(join(root, file), file.includes('env') ? secretContent : 'plain', 'utf8');
  }
  await symlink('.env', join(root, 'link-to-env'));
  await symlink('config/.env.local', join(root, 'config-link'));
  await symlink('README.md', join(root, 'link-to-readme'));
  await symlink('missing-file', join(root, 'dangling'));
  const approvalBroker = createApprovalBroker();
  const registry = createToolRegistry();
  registry.register(
    createWorkspaceFileTools({ workspace: createWorkspacePolicy({ root }) }).readFile,
  );
  return { approvalBroker, pipeline: createToolPipeline({ registry, approvalBroker }) };
}

function readRequest(path: string, mode: ToolPermissionMode, id = 'read-1') {
  return {
    toolCallId: id,
    name: 'read_file',
    arguments: JSON.stringify({ path }),
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

describe('read_file approval for secret files', () => {
  it('matches .env and .env.* names in any directory, case-sensitively', () => {
    expect(isSecretFile('.env')).toBe(true);
    expect(isSecretFile('config/.env.local')).toBe(true);
    expect(isSecretFile('a\\b\\.env.production')).toBe(true);
    for (const name of ['README.md', 'env.ts', '.environment', 'my.env', '.ENV', 'dir.env/x']) {
      expect(isSecretFile(name)).toBe(false);
    }
  });

  for (const mode of ['ask', 'trust'] as const) {
    for (const path of ['.env', 'config/.env.local']) {
      it(`asks before reading ${path} in ${mode} mode and returns content once approved`, async () => {
        const { approvalBroker, pipeline } = await setup();
        const execution = pipeline.execute(readRequest(path, mode));
        const pending = await pendingApproval(approvalBroker, 'read-1');

        expect(pending.operation).toBe('workspace.read_secret_file');
        expect(pending.summary).toBe(`读取可能包含密钥的文件 ${path}`);
        expect(pending.inputSummary).toEqual({ path });
        expect(JSON.stringify(pending)).not.toContain('super-secret-value');

        approvalBroker.approve(pending.approvalId, '测试批准');
        await expect(execution).resolves.toMatchObject({
          content: expect.stringContaining(secretContent),
        });
      });
    }

    it(`rejects reading .env in ${mode} mode when the user denies`, async () => {
      const { approvalBroker, pipeline } = await setup();
      const execution = pipeline.execute(readRequest('.env', mode));
      const assertion = expect(execution).rejects.toMatchObject({
        code: 'tool-approval-rejected',
      });
      const pending = await pendingApproval(approvalBroker, 'read-1');
      approvalBroker.reject(pending.approvalId, '测试拒绝');
      await assertion;
    });
  }

  it('reads .env directly in yolo mode', async () => {
    const { approvalBroker, pipeline } = await setup();
    await expect(pipeline.execute(readRequest('.env', 'yolo'))).resolves.toMatchObject({
      content: expect.stringContaining(secretContent),
    });
    expect(approvalBroker.list()).toEqual([]);
  });

  for (const mode of ['ask', 'trust'] as const) {
    for (const path of ['link-to-env', 'config-link']) {
      it(`asks before reading symlink ${path} to a secret file in ${mode} mode`, async () => {
        const { approvalBroker, pipeline } = await setup();
        const execution = pipeline.execute(readRequest(path, mode));
        const pending = await pendingApproval(approvalBroker, 'read-1');
        expect(pending.operation).toBe('workspace.read_secret_file');
        expect(JSON.stringify(pending)).not.toContain('super-secret-value');
        approvalBroker.approve(pending.approvalId, '测试批准');
        await expect(execution).resolves.toMatchObject({
          content: expect.stringContaining(secretContent),
        });
      });
    }
  }

  it('reads a symlink to a secret file directly in yolo mode', async () => {
    const { approvalBroker, pipeline } = await setup();
    await expect(pipeline.execute(readRequest('link-to-env', 'yolo'))).resolves.toMatchObject({
      content: expect.stringContaining(secretContent),
    });
    expect(approvalBroker.list()).toEqual([]);
  });

  for (const mode of ['ask', 'trust', 'yolo'] as const) {
    it(`never asks for a symlink to an ordinary file in ${mode} mode`, async () => {
      const { approvalBroker, pipeline } = await setup();
      await expect(
        pipeline.execute(readRequest('link-to-readme', mode, 'read-link')),
      ).resolves.toMatchObject({ content: expect.stringContaining('plain') });
      await expect(
        pipeline.execute(readRequest('dangling', mode, 'read-dangling')),
      ).rejects.toThrow();
      expect(approvalBroker.list()).toEqual([]);
    });

    it(`never asks for ordinary files in ${mode} mode`, async () => {
      const { approvalBroker, pipeline } = await setup();
      for (const path of ['README.md', 'env.ts', '.environment', 'config/my.env']) {
        await pipeline.execute(readRequest(path, mode, `read-${path}`));
      }
      expect(approvalBroker.list()).toEqual([]);
    });
  }
});
