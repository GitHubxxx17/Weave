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
  WorkspaceFileError,
  readFileInputSchema,
  writeFileInputSchema,
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
  const root = await mkdtemp(join(tmpdir(), 'weave-workspace-files-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), 'Hello Weave', 'utf8');
  await writeFile(join(root, 'large.txt'), '0123456789', 'utf8');
  return root;
}

function createPipeline(root: string, options?: { maxReadBytes?: number; maxWriteBytes?: number }) {
  const approvalBroker = createApprovalBroker();
  const registry = createToolRegistry();
  const tools = createWorkspaceFileTools({
    workspace: createWorkspacePolicy({ root }),
    ...options,
  });
  registry.register(tools.readFile);
  registry.register(tools.writeFile);

  return {
    approvalBroker,
    pipeline: createToolPipeline({ registry, approvalBroker }),
    tools,
  };
}

async function approveWrite(
  pipeline: ReturnType<typeof createPipeline>['pipeline'],
  approvalBroker: ReturnType<typeof createApprovalBroker>,
  request: Parameters<ReturnType<typeof createPipeline>['pipeline']['execute']>[0],
) {
  const execution = pipeline.execute(request);
  await Promise.resolve();
  const pending = approvalBroker.list().find(({ toolCallId }) => toolCallId === request.toolCallId);
  if (pending === undefined) {
    throw new Error(`No pending approval for ${request.toolCallId}`);
  }
  approvalBroker.approve(pending.approvalId, '测试批准');
  return execution;
}

describe('Workspace File contracts', () => {
  it('validates read and write inputs', () => {
    expect(readFileInputSchema.parse({ path: 'README.md' })).toEqual({
      path: 'README.md',
    });
    expect(writeFileInputSchema.parse({ path: 'new.txt', content: '内容' })).toEqual({
      path: 'new.txt',
      content: '内容',
    });
    expect(() => readFileInputSchema.parse({ path: '' })).toThrow();
    expect(() => writeFileInputSchema.parse({ path: 'new.txt', content: 1 })).toThrow();
    expect(() =>
      writeFileInputSchema.parse({ path: 'new.txt', content: 'x', maxBytes: -1 }),
    ).toThrow();
  });

  it('constructs a stable file error with a cause', () => {
    const cause = new Error('permission denied');
    const error = new WorkspaceFileError(
      'workspace-file-permission-denied',
      'Workspace file permission denied',
      { cause },
    );

    expect(error).toMatchObject({
      name: 'WorkspaceFileError',
      code: 'workspace-file-permission-denied',
      cause,
    });
  });
});

describe('Workspace File Tools', () => {
  it('reads UTF-8 text through the Tool Pipeline', async () => {
    const root = await createWorkspace();
    const { pipeline } = createPipeline(root);

    const result = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'README.md' }),
    });

    expect(result).toMatchObject({
      toolCallId: 'read-1',
      name: 'read_file',
      content: 'Hello Weave',
      truncated: false,
    });
  });

  it('allows filenames that start with two dots inside the Workspace', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, '..config'), 'inside', 'utf8');
    const { pipeline } = createPipeline(root);

    const result = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: '..config' }),
    });

    expect(result.content).toBe('inside');
  });

  it('writes a new UTF-8 file through the Tool Pipeline', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'write-1',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'src/new.txt', content: '你好 Weave' }),
    });
    await Promise.resolve();

    const pending = approvalBroker.list()[0]!;
    expect(pending).toMatchObject({
      toolCallId: 'write-1',
      toolName: 'write_file',
      operation: 'workspace.write_file',
      risk: 'high',
      summary: '写入 Workspace 文件 src/new.txt',
      inputSummary: {
        path: 'src/new.txt',
        bytes: 12,
        overwrite: false,
      },
    });
    expect(JSON.stringify(pending.inputSummary)).not.toContain('你好 Weave');

    approvalBroker.approve(pending.approvalId, '测试批准');
    const result = await execution;

    expect(JSON.parse(result.content)).toEqual({
      path: 'src/new.txt',
      bytesWritten: 12,
      overwritten: false,
    });
    await expect(readFile(join(root, 'src', 'new.txt'), 'utf8')).resolves.toBe('你好 Weave');
  });

  it('rejects writes when the parent directory does not exist', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'missing/new.txt', content: '内容' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-not-found' }),
    });
  });

  it('does not overwrite an existing file unless explicitly requested', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'README.md', content: 'Changed' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-already-exists' }),
    });
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('Hello Weave');

    const result = await approveWrite(pipeline, approvalBroker, {
      toolCallId: 'write-2',
      name: 'write_file',
      arguments: JSON.stringify({
        path: 'README.md',
        content: 'Changed',
        overwrite: true,
      }),
    });

    expect(JSON.parse(result.content)).toEqual({
      path: 'README.md',
      bytesWritten: 7,
      overwritten: true,
    });
    await expect(readFile(join(root, 'README.md'), 'utf8')).resolves.toBe('Changed');
  });

  it('rejects missing files and directories', async () => {
    const root = await createWorkspace();
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'missing.txt' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-not-found' }),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'read-2',
        name: 'read_file',
        arguments: JSON.stringify({ path: '.' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-is-directory' }),
    });
  });

  it('rejects Workspace traversal and absolute paths before file access', async () => {
    const root = await createWorkspace();
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: '../outside.txt' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-outside-root' }),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'read-2',
        name: 'read_file',
        arguments: JSON.stringify({ path: join(root, 'README.md') }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-outside-root' }),
    });
  });

  it('rejects a symlink whose target is outside the Workspace', async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'weave-workspace-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'secret-link.txt'));
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'secret-link.txt' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-symlink-outside-root' }),
    });
  });

  it('rejects writes through external and dangling symlinks', async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'weave-workspace-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'external-link.txt'));
    await symlink(join(outside, 'missing.txt'), join(root, 'dangling-link.txt'));
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'external-link.txt',
          content: 'changed',
          overwrite: true,
        }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-symlink-outside-root' }),
    });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-2',
        name: 'write_file',
        arguments: JSON.stringify({
          path: 'dangling-link.txt',
          content: 'changed',
          overwrite: true,
        }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-symlink-outside-root' }),
    });
    await expect(readFile(join(outside, 'missing.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects writing to a directory', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'src', content: 'not a directory' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-is-directory' }),
    });
  });

  it('allows a symlink whose target remains inside the Workspace', async () => {
    const root = await createWorkspace();
    await symlink(join(root, 'README.md'), join(root, 'readme-link.txt'));
    const { pipeline } = createPipeline(root);

    const result = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'readme-link.txt' }),
    });

    expect(result.content).toBe('Hello Weave');
  });

  it('enforces read and write byte limits', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root, {
      maxReadBytes: 5,
      maxWriteBytes: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'large.txt' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-too-large' }),
    });

    await expect(
      approveWrite(pipeline, approvalBroker, {
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'new.txt', content: '超过限制' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-too-large' }),
    });
  });

  it('maps a pre-aborted pipeline request to cancellation', async () => {
    const root = await createWorkspace();
    const { pipeline } = createPipeline(root);
    const controller = new AbortController();
    controller.abort();

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: 'tool-cancelled',
    });
  });
});

describe('Workspace File Tools with a per-Session resolver', () => {
  function createResolverPipeline(roots: ReadonlyMap<string, string>) {
    const approvalBroker = createApprovalBroker();
    const registry = createToolRegistry();
    const seenSessions: (string | undefined)[] = [];
    const tools = createWorkspaceFileTools({
      resolveWorkspace: async ({ sessionId }) => {
        seenSessions.push(sessionId);
        const root = sessionId === undefined ? undefined : roots.get(sessionId);
        return root === undefined ? undefined : createWorkspacePolicy({ root });
      },
    });
    registry.register(tools.readFile);
    registry.register(tools.writeFile);
    return {
      approvalBroker,
      pipeline: createToolPipeline({ registry, approvalBroker }),
      seenSessions,
    };
  }

  it('reads and writes inside the Workspace of the calling Session', async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    await writeFile(join(second, 'README.md'), 'Second workspace', 'utf8');
    const { approvalBroker, pipeline, seenSessions } = createResolverPipeline(
      new Map([
        ['session-a', first],
        ['session-b', second],
      ]),
    );

    await expect(
      pipeline.execute({
        toolCallId: 'read-b',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
        sessionId: 'session-b',
      }),
    ).resolves.toMatchObject({ content: 'Second workspace' });

    await approveWrite(pipeline, approvalBroker, {
      toolCallId: 'write-a',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'notes.md', content: 'A only' }),
      sessionId: 'session-a',
    });

    await expect(readFile(join(first, 'notes.md'), 'utf8')).resolves.toBe('A only');
    await expect(readFile(join(second, 'notes.md'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(seenSessions).toEqual(['session-b', 'session-a']);
  });

  it('fails with workspace-file-unavailable when the Session has no Workspace', async () => {
    const { pipeline } = createResolverPipeline(new Map());

    const error = await pipeline
      .execute({
        toolCallId: 'read-none',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'README.md' }),
        sessionId: 'session-without-folder',
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'tool-execution-failed' });
    expect((error as Error).cause).toBeInstanceOf(WorkspaceFileError);
    expect((error as Error).cause).toMatchObject({ code: 'workspace-file-unavailable' });
  });

  it('rejects options that provide both or neither Workspace source', () => {
    const root = '/tmp/weave-placeholder';
    expect(() =>
      createWorkspaceFileTools({
        workspace: createWorkspacePolicy({ root }),
        resolveWorkspace: () => undefined,
      } as never),
    ).toThrow(TypeError);
    expect(() => createWorkspaceFileTools({} as never)).toThrow(TypeError);
  });
});
