import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readGitBaseContent } from '../src/workspace-git.js';
import { WorkspaceFileError } from '../src/workspace-file-types.js';

/** Runs git in a fixed, isolated config so commits need no global identity. */
function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('readGitBaseContent', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'weave-git-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns the committed content at HEAD while the working tree differs', async () => {
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
    git(root, 'init', '-q');
    git(root, 'add', 'a.ts');
    git(root, 'commit', '-q', '-m', 'init');
    await writeFile(path.join(root, 'a.ts'), 'export const a = 2;\n');

    const base = await readGitBaseContent(root, 'a.ts');
    expect(base.tracked).toBe(true);
    expect(base.content).toBe('export const a = 1;\n');
  });

  it('reports a new/untracked file as not tracked', async () => {
    git(root, 'init', '-q');
    await writeFile(path.join(root, 'new.ts'), 'x');
    const base = await readGitBaseContent(root, 'new.ts');
    expect(base.tracked).toBe(false);
    expect(base.content).toBe('');
  });

  it('reports a non-git folder as not tracked', async () => {
    await writeFile(path.join(root, 'a.ts'), 'x');
    const base = await readGitBaseContent(root, 'a.ts');
    expect(base.tracked).toBe(false);
  });

  it('rejects a path outside the root', async () => {
    await expect(readGitBaseContent(root, '../escape.ts')).rejects.toThrow(WorkspaceFileError);
  });
});
