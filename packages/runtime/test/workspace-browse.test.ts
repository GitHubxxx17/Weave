import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listWorkspaceFiles, readWorkspaceFileContent } from '../src/workspace-browse.js';
import { WorkspaceFileError } from '../src/workspace-file-types.js';

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('workspace-browse', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-browse-'));
    await writeFile(path.join(root, 'a.txt'), 'hello\nworld\n');
    await mkdir(path.join(root, 'sub'));
    await writeFile(path.join(root, 'sub', 'b.ts'), 'export const b = 1;\n');
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'x.js'), 'ignored');
    await writeFile(path.join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00]));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists files and filters ignored directories', async () => {
    const listing = await listWorkspaceFiles(root, { signal: signal() });
    expect(listing.files).toContain('a.txt');
    expect(listing.files).toContain('sub/b.ts');
    expect(listing.files).not.toContain('node_modules/x.js');
    expect(listing.truncated).toBe(false);
  });

  it('reads a text file whole', async () => {
    const file = await readWorkspaceFileContent(root, 'a.txt', { signal: signal() });
    expect(file.content).toBe('hello\nworld\n');
    expect(file.path).toBe('a.txt');
    expect(file.bytes).toBe(12);
    expect(file.truncated).toBe(false);
  });

  it('returns a truncated prefix for a file larger than maxBytes', async () => {
    const file = await readWorkspaceFileContent(root, 'a.txt', { signal: signal(), maxBytes: 5 });
    expect(file.content).toBe('hello');
    expect(file.truncated).toBe(true);
    expect(file.bytes).toBe(12);
  });

  it('rejects a binary file', async () => {
    await expect(readWorkspaceFileContent(root, 'bin.dat', { signal: signal() })).rejects.toThrow(
      WorkspaceFileError,
    );
  });

  it('rejects a path outside the root', async () => {
    await expect(
      readWorkspaceFileContent(root, '../escape.txt', { signal: signal() }),
    ).rejects.toThrow(WorkspaceFileError);
  });

  it('rejects a directory', async () => {
    await expect(readWorkspaceFileContent(root, 'sub', { signal: signal() })).rejects.toThrow(
      WorkspaceFileError,
    );
  });
});
