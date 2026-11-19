import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createWorkspaceFileTools,
  createWorkspacePolicy,
  restoreFileSnapshot,
  type WorkspaceFileSnapshot,
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
  const root = await mkdtemp(join(tmpdir(), 'weave-file-undo-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'README.md'), 'Hello Weave', 'utf8');
  return root;
}

const context = { signal: new AbortController().signal, sessionId: 's1' };

describe('workspace file snapshot capture', () => {
  it('captures the original before overwriting, creating and editing', async () => {
    const root = await createWorkspace();
    const snapshots: WorkspaceFileSnapshot[] = [];
    const tools = createWorkspaceFileTools({
      workspace: createWorkspacePolicy({ root }),
      onFileSnapshot: (snapshot) => {
        snapshots.push(snapshot);
      },
    });

    await tools.writeFile.execute({ path: 'README.md', content: 'v2', overwrite: true }, context);
    await tools.writeFile.execute({ path: 'src/new.ts', content: 'created' }, context);
    await tools.editFile.execute({ path: 'README.md', oldText: 'v2', newText: 'v3' }, context);

    expect(snapshots).toEqual([
      { sessionId: 's1', path: 'README.md', existedBefore: true, previousContent: 'Hello Weave' },
      { sessionId: 's1', path: 'src/new.ts', existedBefore: false, previousContent: '' },
      { sessionId: 's1', path: 'README.md', existedBefore: true, previousContent: 'v2' },
    ]);
  });

  it('does not block the write when the hook throws', async () => {
    const root = await createWorkspace();
    const tools = createWorkspaceFileTools({
      workspace: createWorkspacePolicy({ root }),
      onFileSnapshot: () => {
        throw new Error('snapshot sink failed');
      },
    });

    await tools.writeFile.execute({ path: 'src/new.ts', content: 'still written' }, context);
    expect(await readFile(join(root, 'src/new.ts'), 'utf8')).toBe('still written');
  });
});

describe('restoreFileSnapshot', () => {
  it('rewrites the original, deletes created files and skips missing ones', async () => {
    const root = await createWorkspace();
    const workspace = createWorkspacePolicy({ root });

    await writeFile(join(root, 'README.md'), 'changed', 'utf8');
    const restored = await restoreFileSnapshot(
      { path: 'README.md', existedBefore: true, previousContent: 'Hello Weave' },
      workspace,
    );
    expect(restored).toBe('restored');
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('Hello Weave');

    await writeFile(join(root, 'src/created.ts'), 'x', 'utf8');
    const deleted = await restoreFileSnapshot(
      { path: 'src/created.ts', existedBefore: false, previousContent: '' },
      workspace,
    );
    expect(deleted).toBe('deleted');
    await expect(stat(join(root, 'src/created.ts'))).rejects.toBeDefined();

    const skipped = await restoreFileSnapshot(
      { path: 'src/never.ts', existedBefore: false, previousContent: '' },
      workspace,
    );
    expect(skipped).toBe('skipped');
  });

  it('refuses a path outside the workspace root', async () => {
    const root = await createWorkspace();
    const workspace = createWorkspacePolicy({ root });
    await expect(
      restoreFileSnapshot(
        { path: '../escape.ts', existedBefore: true, previousContent: 'x' },
        workspace,
      ),
    ).rejects.toBeDefined();
  });
});
