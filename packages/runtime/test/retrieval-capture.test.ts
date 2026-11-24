import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rename, rm, writeFile, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureWorkspaceFiles } from '../src/workspace-file-capture.js';
import { workspaceRootIdentity } from '../src/workspace-mutation.js';
import type { RetrievalProjectEvidence } from '../src/retrieval-types.js';

const roots: string[] = [];
const run = promisify(execFile);
const signal = new AbortController().signal;

async function fixture(files: Record<string, string | Buffer>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'weave-retrieval-capture-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const target = join(root, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

async function evidence(root: string, projectSignal = signal): Promise<RetrievalProjectEvidence> {
  return {
    project: {
      projectId: '00000000-0000-4000-8000-000000000001',
      folderRevision: 1,
      rootDigest: await workspaceRootIdentity(root),
    },
    signal: projectSignal,
    workspaceRoot: root,
    async checkpoint() {},
    assertCurrentSync() {},
    async withAdmission(operation) {
      return operation();
    },
    release() {},
  };
}

const selection = { enabled: true, paths: { include: [], exclude: [] } };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('workspace retrieval capture', () => {
  it('applies Git ignore rules to tracked and untracked files before explicit selection', async () => {
    const root = await fixture({
      'src/keep.ts': 'keep',
      'src/ignored.ts': 'ignored',
      'src/allowed.ts': 'allowed',
      'src2/keep.ts': 'elsewhere',
      'src/private.pem': 'secret',
      'src/.env.local': 'secret',
      'src/node_modules/dependency.ts': 'generated',
    });
    await run('git', ['init', '-q'], { cwd: root });
    await run('git', ['add', '--', 'src/ignored.ts', 'src/keep.ts'], { cwd: root });
    await writeFile(
      join(root, '.gitignore'),
      'src/ignored.ts\nsrc/only-ignore*\n!src/only-ignore-allow.ts\n',
    );
    await writeFile(join(root, 'src/only-ignore-deny.ts'), 'denied');
    await writeFile(join(root, 'src/only-ignore-allow.ts'), 'allowed again');
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const handle = await capture.capture({
      project: await evidence(root),
      selection: {
        enabled: true,
        paths: { include: ['src'], exclude: ['src/allowed.ts'] },
        selectedPaths: [
          'src/keep.ts',
          'src/allowed.ts',
          'src/ignored.ts',
          'src2/keep.ts',
          'src/private.pem',
          'src/.env.local',
          'src/node_modules/dependency.ts',
          'src/only-ignore-allow.ts',
          'src/only-ignore-deny.ts',
        ],
      },
      signal,
    });
    const described = capture.describe(handle);
    expect(described.coverage.discovery).toBe('git');
    expect(described.documents.map(({ source }) => source.sourceKey)).toEqual([
      'workspace:src/keep.ts',
      'workspace:src/only-ignore-allow.ts',
    ]);
    expect(described.counts.selectedFiles).toBe(2);
    expect(described.counts.discoveredFiles).toBe(2 + described.counts.skippedFiles);
  });

  it('walks a plain directory and declares explicit empty selection', async () => {
    const root = await fixture({ 'b.ts': 'b', 'a.ts': 'a', 'node_modules/a.ts': 'skip' });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const project = await evidence(root);
    const handle = await capture.capture({ project, selection, signal });
    expect(capture.describe(handle)).toMatchObject({
      coverage: { discovery: 'walk', truncated: false },
      documents: [{ body: 'a' }, { body: 'b' }],
    });
    const empty = await capture.capture({
      project,
      selection: { ...selection, selectedPaths: [] },
      signal,
    });
    expect(capture.describe(empty)).toMatchObject({ documents: [], counts: { selectedFiles: 0 } });
  });

  it('refuses a plain directory with nested rules and skips discovery in memory-only mode', async () => {
    const root = await fixture({ 'src/.gitignore': '*\n', 'src/hidden.ts': 'private' });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const project = await evidence(root);
    await expect(capture.capture({ project, selection, signal })).rejects.toMatchObject({
      code: 'retrieval-unavailable',
    });
    const disabled = await capture.capture({
      project,
      selection: { ...selection, enabled: false },
      signal,
    });
    expect(capture.describe(disabled)).toMatchObject({
      coverage: { discovery: 'memory-only' },
      documents: [],
    });
  });

  it('does not walk a nested Git worktree without applying its local exclusions', async () => {
    const root = await fixture({ 'nested/ignore-me.ts': 'private' });
    const nested = join(root, 'nested');
    await run('git', ['init', '-q'], { cwd: nested });
    await writeFile(join(nested, '.git', 'info', 'exclude'), '*.ts\n');
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    await expect(
      capture.capture({ project: await evidence(root), selection, signal }),
    ).rejects.toMatchObject({ code: 'retrieval-unavailable' });
  });

  it.skipIf(process.platform === 'win32')(
    'counts filenames rejected by the path contract without disclosing them',
    async () => {
      const root = await fixture({ 'safe.ts': 'legitimate', 'invalid:name.ts': 'unsafe' });
      const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
      const capture = createRetrievalWorkspaceCapture();
      const handle = await capture.capture({ project: await evidence(root), selection, signal });
      expect(capture.describe(handle)).toMatchObject({
        documents: [{ body: 'legitimate' }],
        counts: { discoveredFiles: 2, selectedFiles: 1, skippedFiles: 1 },
        coverage: {
          skippedDetailsTruncated: true,
          skipCounts: [{ reason: 'unsafe-file', count: 1 }],
        },
        skipped: [],
      });
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'counts unsafe filenames without opening a replacement-decoded path',
    async () => {
      const root = await fixture({
        'literal-\ufffd.ts': 'legitimate',
        'invalid:name.ts': 'unsafe',
      });
      await writeFile(
        Buffer.concat([Buffer.from(`${root}/literal-`), Buffer.from([0xff]), Buffer.from('.ts')]),
        'unsafe',
      );
      const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
      const capture = createRetrievalWorkspaceCapture();
      const handle = await capture.capture({ project: await evidence(root), selection, signal });
      expect(capture.describe(handle)).toMatchObject({
        documents: [{ body: 'legitimate' }],
        counts: { discoveredFiles: 3, selectedFiles: 1, skippedFiles: 2 },
        coverage: {
          truncated: false,
          skippedDetailsTruncated: true,
          skipCounts: [{ reason: 'unsafe-file', count: 2 }],
        },
        skipped: [],
      });
    },
  );

  it('rechecks the authority root even when identical text exists at the replacement root', async () => {
    const root = await fixture({ 'a.ts': 'old' });
    const parent = await fixture({});
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const project = await evidence(root);
    const handle = await capture.capture({ project, selection, signal });
    const source = capture.describe(handle).documents[0]!.source;
    expect(source.kind).toBe('workspace');
    if (source.kind !== 'workspace') throw new Error('Expected a workspace source');
    await rename(root, join(parent, 'original'));
    await mkdir(root);
    await writeFile(join(root, 'a.ts'), 'old');
    await writeFile(join(root, '.gitignore'), '*\n');
    await expect(capture.capture({ project, selection, signal })).rejects.toMatchObject({
      code: 'retrieval-root-changed',
    });
    await expect(capture.verify(handle, signal)).rejects.toMatchObject({
      code: 'retrieval-stale-preview',
    });
    await expect(capture.readCurrent({ project, source, signal })).rejects.toMatchObject({
      code: 'retrieval-stale-source',
    });
  });

  it('keeps the @file single-file limit and skips text beyond the retrieval limit', async () => {
    const root = await fixture({
      'a.txt': Buffer.alloc(65_537, 0x61),
      'b.txt': Buffer.alloc(262_144, 0x62),
      'c.txt': Buffer.alloc(262_145, 0x63),
      'd.txt': '',
      'e.txt': Buffer.from([0xff]),
      'f.txt': Buffer.from('x\0y'),
    });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const handle = await capture.capture({ project: await evidence(root), selection, signal });
    expect(capture.describe(handle)).toMatchObject({
      counts: { discoveredFiles: 6, selectedFiles: 6, skippedFiles: 4 },
      documents: [{ source: { sourceBytes: 65_537 } }, { source: { sourceBytes: 262_144 } }],
      skipped: [
        { path: 'c.txt', reason: 'too-large' },
        { path: 'd.txt', reason: 'empty' },
        { path: 'e.txt', reason: 'invalid-utf8' },
        { path: 'f.txt', reason: 'binary' },
      ],
    });
    await expect(
      captureWorkspaceFiles(root, [{ path: 'a.txt' }], { signal }),
    ).rejects.toMatchObject({ code: 'execution-file-too-large' });
  });

  it('revalidates exact bytes and file identity and releases only its own capture', async () => {
    const root = await fixture({ 'a.ts': 'same' });
    const outside = await fixture({ 'a.ts': 'same' });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const project = await evidence(root);
    const handle = await capture.capture({ project, selection, signal });
    const source = capture.describe(handle).documents[0]!.source;
    if (source.kind !== 'workspace') throw new Error('Expected a workspace source');
    await expect(capture.verify(handle, signal)).resolves.toBeUndefined();
    await expect(capture.readCurrent({ project, source, signal })).resolves.toMatchObject({
      body: 'same',
    });
    await rename(join(outside, 'a.ts'), join(root, 'a.ts'));
    await expect(capture.verify(handle, signal)).rejects.toMatchObject({
      code: 'retrieval-stale-preview',
    });
    await expect(capture.readCurrent({ project, source, signal })).rejects.toMatchObject({
      code: 'retrieval-stale-source',
    });
    expect(() => createRetrievalWorkspaceCapture().describe(handle)).toThrow();
    expect(() => capture.describe({ ...handle })).toThrow();
    capture.release(handle);
    expect(() => capture.describe(handle)).toThrow();
  });

  it('keeps a Git listing failure from recovering through an unfiltered walk', async () => {
    const root = await fixture({ '.gitignore': '*.ts\n', 'ignored.ts': 'private' });
    await run('git', ['init', '-q'], { cwd: root });
    await writeFile(join(root, '.git', 'index'), 'corrupt');
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    await expect(
      capture.capture({ project: await evidence(root), selection, signal }),
    ).rejects.toMatchObject({ code: 'retrieval-unavailable' });
  });

  it('reports the 16 MiB aggregate workspace ceiling without dropping its omission count', async () => {
    const body = Buffer.alloc(262_144, 0x61);
    const files = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`${String(index).padStart(2, '0')}.txt`, body]),
    );
    const root = await fixture({ ...files, '64.txt': 'one extra byte is sufficient' });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const handle = await capture.capture({ project: await evidence(root), selection, signal });
    const described = capture.describe(handle);
    expect(described.documents.reduce((total, next) => total + next.source.sourceBytes, 0)).toBe(
      16_777_216,
    );
    expect(described.counts).toEqual({ discoveredFiles: 65, selectedFiles: 65, skippedFiles: 1 });
    expect(described.skipped).toEqual([{ path: '64.txt', reason: 'capture-limit' }]);
    await expect(capture.verify(handle, signal)).resolves.toBeUndefined();
  });

  // Creating 4,002 real files and safely capturing 2,000 needs extra filesystem time on shared CI.
  it('collects all file and omission counts when source and detail limits apply', async () => {
    const root = await fixture({});
    for (let index = 0; index < 4_002; index += 48) {
      await Promise.all(
        Array.from({ length: Math.min(48, 4_002 - index) }, (_, offset) => {
          const name = String(index + offset).padStart(4, '0');
          return writeFile(join(root, `${name}.ts`), 'text');
        }),
      );
    }
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const handle = await capture.capture({ project: await evidence(root), selection, signal });
    const described = capture.describe(handle);
    expect(described.counts).toEqual({
      discoveredFiles: 4_002,
      selectedFiles: 2_000,
      skippedFiles: 2_002,
    });
    expect(described.documents).toHaveLength(2_000);
    expect(described.skipped).toHaveLength(2_000);
    expect(described.coverage).toEqual({
      discovery: 'walk',
      truncated: false,
      skippedDetailsTruncated: true,
      skipCounts: [{ reason: 'source-limit', count: 2_002 }],
    });
  }, 15_000);

  it('cancels while queued without changing the error to stale source or exposing the abort reason', async () => {
    const root = await fixture({ 'a.ts': 'text' });
    const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
    const capture = createRetrievalWorkspaceCapture();
    const project = await evidence(root);
    const controller = new AbortController();
    const handle = await capture.capture({ project, selection, signal });
    const source = capture.describe(handle).documents[0]!.source;
    if (source.kind !== 'workspace') throw new Error('Expected a workspace source');
    const { withWorkspaceMutation } = await import('../src/workspace-mutation.js');
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocker = withWorkspaceMutation(root, async () => {
      enter();
      await hold;
    });
    await entered;
    try {
      let started!: () => void;
      const submitted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const activeProject = { ...project, assertCurrentSync: started };
      const read = capture.readCurrent({
        project: activeProject,
        source,
        signal: controller.signal,
      });
      const rejection = expect(read).rejects.toMatchObject({
        code: 'retrieval-cancelled',
        message: 'Retrieval operation was cancelled',
      });
      await submitted;
      controller.abort(new Error(root));
      release();
      await rejection;
    } finally {
      release();
      await blocker;
    }
  });

  it.skipIf(process.platform === 'win32')(
    'skips unsafe tracked symlink parents and leaves and multiply linked regular files',
    async () => {
      const root = await fixture({ 'plain.ts': 'ok', 'parent/file.ts': 'original' });
      const outside = await fixture({ 'file.ts': 'private' });
      await run('git', ['init', '-q'], { cwd: root });
      await symlink(join(outside, 'file.ts'), join(root, 'leaf.ts'));
      await run('git', ['add', '--', 'parent/file.ts', 'leaf.ts'], { cwd: root });
      await rm(join(root, 'parent'), { recursive: true });
      await symlink(outside, join(root, 'parent'));
      await link(join(outside, 'file.ts'), join(root, 'hard.ts'));
      const { createRetrievalWorkspaceCapture } = await import('../src/retrieval-capture.js');
      const capture = createRetrievalWorkspaceCapture();
      const handle = await capture.capture({ project: await evidence(root), selection, signal });
      expect(capture.describe(handle)).toMatchObject({
        documents: [{ body: 'ok' }],
        skipped: [
          { path: 'hard.ts', reason: 'unsafe-file' },
          { path: 'leaf.ts', reason: 'unsafe-file' },
          { path: 'parent', reason: 'unsafe-file' },
          { path: 'parent/file.ts', reason: 'unsafe-file' },
        ],
      });
    },
  );
});
