import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

describe('legacy restore compatibility', () => {
  it('keeps old snapshots readable but cannot use them as safe restore evidence', async () => {
    const root = await createWorkspace();
    await writeFile(join(root, 'README.md'), 'changed');
    const result = await restoreFileSnapshot(
      { path: 'README.md', existedBefore: true, previousContent: 'Hello Weave' },
      createWorkspacePolicy({ root }),
    );
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('changed');
  });
});
