import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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
  editFileInputSchema,
  readFileInputSchema,
  writeFileInputSchema,
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
  registry.register(tools.editFile);

  return {
    approvalBroker,
    pipeline: createToolPipeline({ registry, approvalBroker }),
    tools,
  };
}

type TestPipeline = ReturnType<typeof createPipeline>['pipeline'];
type TestBroker = ReturnType<typeof createApprovalBroker>;

/**
 * Waits until the call either creates its pending Approval or settles first.
 * Protected file tools check their input asynchronously before asking.
 */
async function waitForApproval(
  approvalBroker: TestBroker,
  toolCallId: string,
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
    const pending = approvalBroker
      .list()
      .find((request) => request.toolCallId === toolCallId && request.status === 'pending');
    if (pending !== undefined) {
      return pending;
    }
    if (settled) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No pending approval for ${toolCallId}`);
}

async function approveWrite(
  pipeline: TestPipeline,
  approvalBroker: TestBroker,
  request: Parameters<TestPipeline['execute']>[0],
) {
  const execution = pipeline.execute(request);
  const pending = await waitForApproval(approvalBroker, request.toolCallId, execution);
  if (pending !== undefined) {
    approvalBroker.approve(pending.approvalId, '测试批准');
  }
  return execution;
}

describe('Workspace File contracts', () => {
  it('validates read, write and edit inputs', () => {
    expect(readFileInputSchema.parse({ path: 'README.md' })).toEqual({
      path: 'README.md',
    });
    expect(readFileInputSchema.parse({ path: 'README.md', offset: 3, limit: 10 })).toEqual({
      path: 'README.md',
      offset: 3,
      limit: 10,
    });
    expect(writeFileInputSchema.parse({ path: 'new.txt', content: '内容' })).toEqual({
      path: 'new.txt',
      content: '内容',
    });
    expect(() => readFileInputSchema.parse({ path: '' })).toThrow();
    expect(() => readFileInputSchema.parse({ path: 'a.txt', offset: 0 })).toThrow();
    expect(() => readFileInputSchema.parse({ path: 'a.txt', limit: 1.5 })).toThrow();
    expect(() => writeFileInputSchema.parse({ path: 'new.txt', content: 1 })).toThrow();
    // The old per-call byte limit is no longer part of the contract and is ignored.
    expect(writeFileInputSchema.parse({ path: 'new.txt', content: 'x', maxBytes: 1 })).toEqual({
      path: 'new.txt',
      content: 'x',
    });
    expect(() => editFileInputSchema.parse({ path: 'a.txt', oldText: '', newText: 'x' })).toThrow();
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
  it.each(['write_file', 'edit_file'] as const)(
    'checks the synchronous mutation permit after %s capture waits',
    async (name) => {
      const root = await createWorkspace();
      let permit = true;
      let reachedSnapshot!: () => void;
      let endSnapshot!: () => void;
      const reached = new Promise<void>((resolve) => {
        reachedSnapshot = resolve;
      });
      const end = new Promise<void>((resolve) => {
        endSnapshot = resolve;
      });
      const tools = createWorkspaceFileTools({
        workspace: createWorkspacePolicy({ root }),
        onFileSnapshot: async () => {
          reachedSnapshot();
          await end;
        },
        assertMutationCurrent: () => {
          if (!permit) throw new Error('Folder permit revoked');
        },
      });
      const context = { signal: new AbortController().signal };
      const mutation =
        name === 'write_file'
          ? tools.writeFile.execute({ path: 'new/sub/file', content: 'new' }, context)
          : tools.editFile.execute(
              { path: 'README.md', oldText: 'Hello', newText: 'Edited' },
              context,
            );
      await reached;
      permit = false;
      endSnapshot();
      await expect(mutation).rejects.toThrow('Folder permit revoked');
      await expect(stat(join(root, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('Hello Weave');
    },
  );

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
    const pending = (await waitForApproval(approvalBroker, 'write-1', execution))!;

    expect(pending).toMatchObject({
      toolCallId: 'write-1',
      toolName: 'write_file',
      operation: 'workspace.write_file',
      risk: 'high',
      summary: '写入 Workspace 文件 src/new.txt',
      inputSummary: {
        path: 'src/new.txt',
        bytes: 12,
        lines: 1,
        overwrite: false,
        createdDirectories: [],
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

  it('creates missing parent directories inside the Workspace', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'write-1',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'missing/deeper/new.txt', content: '内容' }),
    });
    const pending = (await waitForApproval(approvalBroker, 'write-1', execution))!;
    expect(pending.inputSummary).toMatchObject({
      createdDirectories: ['missing', 'missing/deeper'],
    });
    approvalBroker.approve(pending.approvalId);

    const result = await execution;
    expect(JSON.parse(result.content)).toEqual({
      path: 'missing/deeper/new.txt',
      bytesWritten: 6,
      overwritten: false,
      createdDirectories: ['missing', 'missing/deeper'],
    });
    await expect(readFile(join(root, 'missing', 'deeper', 'new.txt'), 'utf8')).resolves.toBe(
      '内容',
    );
  });

  it('rejects a write whose parent is a file before asking for Approval', async () => {
    const root = await createWorkspace();
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'write-1',
        name: 'write_file',
        arguments: JSON.stringify({ path: 'README.md/new.txt', content: '内容' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-not-directory' }),
    });
    expect(approvalBroker.list()).toEqual([]);
  });

  it('shows the size of the file an overwrite replaces', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'notes.md'), 'one\ntwo\nthree\n', 'utf8');
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'write-1',
      name: 'write_file',
      arguments: JSON.stringify({ path: 'notes.md', content: 'one\n', overwrite: true }),
    });
    const pending = (await waitForApproval(approvalBroker, 'write-1', execution))!;
    expect(pending.inputSummary).toMatchObject({
      bytes: 4,
      lines: 1,
      overwrite: true,
      previousBytes: 14,
      previousLines: 3,
    });
    approvalBroker.reject(pending.approvalId);
    await expect(execution).rejects.toMatchObject({ code: 'tool-approval-rejected' });
    await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('one\ntwo\nthree\n');
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
    // The read resolves its Workspace twice: once for the secret-file check, once to read.
    // The write resolves its Workspace three times: twice for the Approval summary (plan and
    // sensitive-path reason), once to write.
    expect(seenSessions).toEqual(['session-b', 'session-b', 'session-a', 'session-a', 'session-a']);
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

describe('read_file pages', () => {
  async function workspaceWithLines(count: number, lineText = (index: number) => `line ${index}`) {
    const root = await createWorkspace();
    const content = Array.from({ length: count }, (_, index) => lineText(index + 1)).join('\n');
    await writeFile(join(root, 'long.txt'), `${content}\n`, 'utf8');
    return root;
  }

  it('returns a page with the next offset instead of silently truncating', async () => {
    const root = await workspaceWithLines(
      1000,
      (index) => `line ${String(index).padStart(4, '0')}: ${'x'.repeat(30)}`,
    );
    const { pipeline } = createPipeline(root);

    const first = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'long.txt' }),
    });

    expect(first.truncated).toBe(false);
    expect(Buffer.byteLength(first.content, 'utf8')).toBeLessThanOrEqual(32_000);
    const note = /\[已显示第 1–(\d+) 行，共 1000 行。继续读取请传 offset: (\d+)\]$/.exec(
      first.content,
    );
    expect(note).not.toBeNull();
    const lastShown = Number(note?.[1]);
    expect(Number(note?.[2])).toBe(lastShown + 1);

    const second = await pipeline.execute({
      toolCallId: 'read-2',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'long.txt', offset: lastShown + 1, limit: 5 }),
    });
    expect(second.content.split('\n')[0]).toBe(
      `line ${String(lastShown + 1).padStart(4, '0')}: ${'x'.repeat(30)}`,
    );
    expect(second.content).toContain(`已显示第 ${lastShown + 1}–${lastShown + 5} 行，共 1000 行`);
  });

  it('marks the end of the file and rejects an offset past it', async () => {
    const root = await workspaceWithLines(10);
    const { pipeline } = createPipeline(root);

    const tail = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'long.txt', offset: 9 }),
    });
    expect(tail.content).toBe('line 9\nline 10\n\n[已显示第 9–10 行，共 10 行，已到文件末尾]');

    await expect(
      pipeline.execute({
        toolCallId: 'read-2',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'long.txt', offset: 11 }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-invalid-input' }),
    });
  });

  it('keeps pages of Chinese text under the context token cap', async () => {
    const root = await workspaceWithLines(400, () => '中文'.repeat(20));
    const { pipeline } = createPipeline(root);

    const page = await pipeline.execute({
      toolCallId: 'read-1',
      name: 'read_file',
      arguments: JSON.stringify({ path: 'long.txt' }),
    });

    // 400 lines × 40 CJK characters would be about 16,000 tokens.
    expect(page.content).toMatch(/继续读取请传 offset: \d+\]$/);
    expect(page.content.length).toBeLessThan(7000);
  });

  it('rejects binary files', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'read-1',
        name: 'read_file',
        arguments: JSON.stringify({ path: 'image.bin' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-file-binary' }),
    });
  });

  it('marks read_file read-only and the protected tools as not read-only', () => {
    const { tools } = createPipeline('/tmp/weave-placeholder');
    expect(tools.readFile.readOnly).toBe(true);
    expect(tools.writeFile.readOnly).not.toBe(true);
    expect(tools.editFile.readOnly).not.toBe(true);
  });
});

describe('edit_file', () => {
  it('shows a diff for Approval and writes only after approval', async () => {
    const root = await createWorkspace();
    await writeFile(
      join(root, 'src', 'app.ts'),
      'const a = 1;\nconst b = 2;\nconst c = 3;\n',
      'utf8',
    );
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'edit-1',
      name: 'edit_file',
      arguments: JSON.stringify({
        path: 'src/app.ts',
        oldText: 'const b = 2;',
        newText: 'const b = 20;',
      }),
    });
    const pending = (await waitForApproval(approvalBroker, 'edit-1', execution))!;
    expect(pending).toMatchObject({
      operation: 'workspace.edit_file',
      risk: 'medium',
      summary: '编辑 Workspace 文件 src/app.ts',
      inputSummary: {
        path: 'src/app.ts',
        replacements: 1,
        linesAdded: 1,
        linesRemoved: 1,
        diffTruncated: false,
      },
    });
    const diff = (pending.inputSummary as { diff: string }).diff;
    expect(diff).toContain('-const b = 2;');
    expect(diff).toContain('+const b = 20;');
    expect(diff).toContain(' const a = 1;');
    await expect(readFile(join(root, 'src', 'app.ts'), 'utf8')).resolves.toContain('const b = 2;');

    approvalBroker.approve(pending.approvalId);
    const result = JSON.parse((await execution).content) as Record<string, unknown>;
    expect(result).toMatchObject({
      path: 'src/app.ts',
      replacements: 1,
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(result.snippet).toContain('2: const b = 20;');
    await expect(readFile(join(root, 'src', 'app.ts'), 'utf8')).resolves.toBe(
      'const a = 1;\nconst b = 20;\nconst c = 3;\n',
    );
  });

  it('fails before Approval when the text is missing or ambiguous', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'dup.txt'), 'x = 1\ny = 2\nx = 1\n', 'utf8');
    const { approvalBroker, pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'edit-1',
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'dup.txt', oldText: 'z = 3', newText: 'z = 4' }),
      }),
    ).rejects.toMatchObject({
      code: 'tool-execution-failed',
      cause: expect.objectContaining({ code: 'workspace-edit-no-match' }),
    });

    const ambiguous = await pipeline
      .execute({
        toolCallId: 'edit-2',
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'dup.txt', oldText: 'x = 1', newText: 'x = 9' }),
      })
      .catch((error: unknown) => error);
    expect(ambiguous).toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-edit-ambiguous' }),
    });
    expect(((ambiguous as Error).cause as Error).message).toContain('lines 1, 3');

    await expect(
      pipeline.execute({
        toolCallId: 'edit-3',
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'missing.txt', oldText: 'a', newText: 'b' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-not-found' }),
    });
    expect(approvalBroker.list()).toEqual([]);
  });

  it('replaces every occurrence with replaceAll', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'dup.txt'), 'x = 1\ny = 2\nx = 1\n', 'utf8');
    const { approvalBroker, pipeline } = createPipeline(root);

    const result = await approveWrite(pipeline, approvalBroker, {
      toolCallId: 'edit-1',
      name: 'edit_file',
      arguments: JSON.stringify({
        path: 'dup.txt',
        oldText: 'x = 1',
        newText: 'x = 9',
        replaceAll: true,
      }),
    });

    expect(JSON.parse(result.content)).toMatchObject({ replacements: 2 });
    await expect(readFile(join(root, 'dup.txt'), 'utf8')).resolves.toBe('x = 9\ny = 2\nx = 9\n');
  });

  it('matches LF text against a CRLF file and keeps CRLF', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'win.txt'), 'first\r\nsecond\r\nthird\r\n', 'utf8');
    const { approvalBroker, pipeline } = createPipeline(root);

    await approveWrite(pipeline, approvalBroker, {
      toolCallId: 'edit-1',
      name: 'edit_file',
      arguments: JSON.stringify({ path: 'win.txt', oldText: 'first\nsecond', newText: 'one\ntwo' }),
    });

    await expect(readFile(join(root, 'win.txt'), 'utf8')).resolves.toBe('one\r\ntwo\r\nthird\r\n');
  });

  it('fails instead of guessing when the file changes while Approval is pending', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'notes.md'), 'draft\n', 'utf8');
    const { approvalBroker, pipeline } = createPipeline(root);

    const execution = pipeline.execute({
      toolCallId: 'edit-1',
      name: 'edit_file',
      arguments: JSON.stringify({ path: 'notes.md', oldText: 'draft', newText: 'final' }),
    });
    const pending = (await waitForApproval(approvalBroker, 'edit-1', execution))!;
    await writeFile(join(root, 'notes.md'), 'rewritten by the user\n', 'utf8');
    approvalBroker.approve(pending.approvalId);

    await expect(execution).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-edit-no-match' }),
    });
    await expect(readFile(join(root, 'notes.md'), 'utf8')).resolves.toBe('rewritten by the user\n');
  });

  it('refuses to edit through a symlink that leaves the Workspace', async () => {
    const root = await createWorkspace();
    const outside = await mkdtemp(join(tmpdir(), 'weave-workspace-outside-'));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const { pipeline } = createPipeline(root);

    await expect(
      pipeline.execute({
        toolCallId: 'edit-1',
        name: 'edit_file',
        arguments: JSON.stringify({ path: 'link.txt', oldText: 'secret', newText: 'leak' }),
      }),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'workspace-file-symlink-outside-root' }),
    });
    await expect(readFile(join(outside, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });
});
