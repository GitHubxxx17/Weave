import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { executionContextLimits } from '@weave/protocol';
import { capturedWorkspaceContextSchema, type CapturedContextSnapshot } from '@weave/session';
import {
  captureWorkspaceContexts,
  checkGitChangesAvailable,
} from '../src/workspace-context-capture.js';

const roots: string[] = [];
const fixedNow = () => new Date('2026-11-24T10:00:00.000Z');

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'weave-context-capture-'));
  roots.push(root);
  return root;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { cwd, stdio: 'ignore' },
  );
}

async function repository(files: Readonly<Record<string, string>> = { 'a.txt': 'one\n' }) {
  const root = await temporaryRoot();
  git(root, 'init', '-q');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  return root;
}

async function capture(
  root: string,
  kinds: readonly ('git-changes' | 'project-tree')[],
  signal = new AbortController().signal,
): Promise<CapturedContextSnapshot[]> {
  const result = await captureWorkspaceContexts(
    root,
    kinds.map((kind) => ({ kind })),
    { signal, now: fixedNow },
  );
  const parsed = capturedWorkspaceContextSchema.parse({ ...result, projectId: 'p' });
  return [...parsed.snapshots];
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Git changes capture', () => {
  it('records status and the diff against HEAD with a verifiable digest', async () => {
    const root = await repository({ 'a.txt': 'one\n', 'b.txt': 'keep\n' });
    await writeFile(path.join(root, 'a.txt'), 'one\nchanged-line\n');
    await writeFile(path.join(root, 'new.txt'), 'untracked\n');
    const [snapshot] = await capture(root, ['git-changes']);
    expect(snapshot).toMatchObject({
      kind: 'git-changes',
      capturedAt: '2026-11-24T10:00:00.000Z',
      truncated: false,
    });
    expect(snapshot!.content).toContain('## git status --porcelain=v1');
    expect(snapshot!.content).toContain(' M a.txt');
    expect(snapshot!.content).toContain('?? new.txt');
    expect(snapshot!.content).toContain('+changed-line');
    // Untracked content is never part of `git diff HEAD`.
    expect(snapshot!.content).not.toContain('untracked\n');
    expect(snapshot!.byteLength).toBe(Buffer.byteLength(snapshot!.content));
    expect(snapshot!.sha256).toBe(createHash('sha256').update(snapshot!.content).digest('hex'));
  });

  it('reports a clean tree explicitly', async () => {
    const [snapshot] = await capture(await repository(), ['git-changes']);
    expect(snapshot!.content).toContain('(clean)');
    expect(snapshot!.content).toContain('(no changes)');
  });

  it('keeps the names of environment files but never their diff content', async () => {
    const root = await repository({
      '.env': 'TOKEN=old\n',
      'config/.env.local': 'TOKEN=old\n',
      'src/.environment.ts': 'export const old = 1;\n',
      'a.txt': 'one\n',
    });
    await writeFile(path.join(root, '.env'), 'TOKEN=super-secret-value\n');
    await writeFile(path.join(root, 'config/.env.local'), 'TOKEN=other-secret-value\n');
    await writeFile(path.join(root, 'src/.environment.ts'), 'export const visible = 2;\n');
    await writeFile(path.join(root, 'a.txt'), 'one\nplain-change\n');
    const [snapshot] = await capture(root, ['git-changes']);
    const content = snapshot!.content;
    expect(content).not.toContain('super-secret-value');
    expect(content).not.toContain('other-secret-value');
    expect(content).not.toContain('TOKEN=old');
    expect(content).toContain('.env (content omitted)');
    expect(content).toContain('config/.env.local (content omitted)');
    expect(content).toContain(' M .env');
    // Only `.env` and `.env.*` are secret files; other names keep their diff.
    expect(content).toContain('+export const visible = 2;');
    expect(content).toContain('+plain-change');
  });

  it('truncates at the byte limit on a character boundary and marks the result', async () => {
    const root = await repository({ 'big.txt': 'start\n' });
    await writeFile(path.join(root, 'big.txt'), '中文内容行\n'.repeat(40_000));
    const [snapshot] = await capture(root, ['git-changes']);
    expect(snapshot!.truncated).toBe(true);
    expect(snapshot!.byteLength).toBeLessThanOrEqual(executionContextLimits.gitChangesBytes);
    expect(snapshot!.content).toContain('[truncated');
    expect(snapshot!.content).not.toContain('\uFFFD');
    expect(snapshot!.content).toContain('## git status --porcelain=v1');
  });

  it('limits the diff to the project folder inside a larger repository', async () => {
    const root = await repository({ 'outside.txt': 'a\n', 'sub/inside.txt': 'a\n' });
    await writeFile(path.join(root, 'outside.txt'), 'a\nouter-change\n');
    await writeFile(path.join(root, 'sub/inside.txt'), 'a\ninner-change\n');
    const [snapshot] = await capture(path.join(root, 'sub'), ['git-changes']);
    expect(snapshot!.content).toContain('+inner-change');
    expect(snapshot!.content).not.toContain('outer-change');
  });

  it('never runs programs named by repository configuration', async () => {
    const root = await repository();
    const marker = path.join(await temporaryRoot(), 'ran');
    const script = path.join(await temporaryRoot(), 'hook.sh');
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(root, 'config', 'core.fsmonitor', script);
    git(root, 'config', 'diff.external', script);
    git(root, 'config', 'core.pager', script);
    await writeFile(path.join(root, 'a.txt'), 'one\nedited\n');
    const [snapshot] = await capture(root, ['git-changes']);
    expect(snapshot!.content).toContain('+edited');
    expect(existsSync(marker)).toBe(false);
  });

  it('fails with a stable code outside a repository and before the first commit', async () => {
    const plain = await temporaryRoot();
    await expect(capture(plain, ['git-changes'])).rejects.toMatchObject({
      code: 'execution-context-git-unavailable',
    });
    const empty = await temporaryRoot();
    git(empty, 'init', '-q');
    await expect(capture(empty, ['git-changes'])).rejects.toMatchObject({
      code: 'execution-context-git-unavailable',
    });
    expect(await checkGitChangesAvailable(plain, { signal: new AbortController().signal })).toBe(
      false,
    );
    expect(await checkGitChangesAvailable(empty, { signal: new AbortController().signal })).toBe(
      false,
    );
    expect(
      await checkGitChangesAvailable(await repository(), { signal: new AbortController().signal }),
    ).toBe(true);
  });

  it('rejects with the abort reason when the shared deadline has passed', async () => {
    const root = await repository();
    const controller = new AbortController();
    controller.abort(new DOMException('Deadline', 'TimeoutError'));
    await expect(capture(root, ['git-changes'], controller.signal)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });
});

describe('Project tree capture', () => {
  it('lists files with .gitignore applied in a Git repository', async () => {
    const root = await repository({
      '.gitignore': 'ignored.txt\nbuild-output/\n',
      'src/index.ts': 'x',
      'ignored.txt': 'x',
    });
    await mkdir(path.join(root, 'build-output'));
    await writeFile(path.join(root, 'build-output/out.js'), 'x');
    await writeFile(path.join(root, 'ignored.txt'), 'x');
    const [snapshot] = await capture(root, ['project-tree']);
    expect(snapshot).toMatchObject({ kind: 'project-tree', truncated: false });
    const entries = snapshot!.content.split('\n');
    expect(entries).toEqual(['.gitignore', 'src/index.ts']);
    expect(snapshot!.kind === 'project-tree' && snapshot!.entryCount).toBe(2);
  });

  it('skips default ignored names outside a repository', async () => {
    const root = await temporaryRoot();
    await mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'node_modules/pkg/index.js'), 'x');
    await writeFile(path.join(root, 'src/app.ts'), 'x');
    const [snapshot] = await capture(root, ['project-tree']);
    expect(snapshot!.content).toBe('src/app.ts');
  });

  it('caps the entry count and marks the listing truncated', async () => {
    const root = await temporaryRoot();
    for (let index = 0; index < executionContextLimits.projectTreeEntries + 5; index++)
      await writeFile(path.join(root, `f${String(index).padStart(5, '0')}.txt`), '');
    const [snapshot] = await capture(root, ['project-tree']);
    expect(snapshot!.truncated).toBe(true);
    expect(snapshot!.kind === 'project-tree' && snapshot!.entryCount).toBeLessThanOrEqual(
      executionContextLimits.projectTreeEntries,
    );
    expect(snapshot!.content).toContain('[truncated');
  });

  it('caps the byte size on whole entries and marks the listing truncated', async () => {
    const root = await temporaryRoot();
    const longName = 'n'.repeat(200);
    for (let index = 0; index < 400; index++)
      await writeFile(path.join(root, `${longName}${String(index).padStart(4, '0')}`), '');
    const [snapshot] = await capture(root, ['project-tree']);
    expect(snapshot!.truncated).toBe(true);
    expect(snapshot!.byteLength).toBeLessThanOrEqual(executionContextLimits.projectTreeBytes);
    const listed = snapshot!.content.split('\n').filter((line) => !line.startsWith('['));
    expect(listed.every((line) => line.length === 204)).toBe(true);
  });

  it('skips paths with control characters so entries stay unambiguous', async () => {
    const root = await temporaryRoot();
    await writeFile(path.join(root, 'ok.txt'), '');
    await writeFile(path.join(root, 'bad\nname.txt'), '');
    const [snapshot] = await capture(root, ['project-tree']);
    expect(snapshot!.content).toBe('ok.txt');
  });
});

describe('combined capture', () => {
  it('returns the requested kinds in request order', async () => {
    const root = await repository();
    const snapshots = await capture(root, ['project-tree', 'git-changes']);
    expect(snapshots.map(({ kind }) => kind)).toEqual(['project-tree', 'git-changes']);
  });
});
