import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createWorkspacePolicy,
  restoreFileSnapshot,
  workspaceFileIdentity,
  workspaceRootIdentity,
} from '../src/index.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'safe-undo-'));
  roots.push(root);
  await writeFile(join(root, 'a'), 'after');
  return {
    root,
    workspace: createWorkspacePolicy({ root }),
    snapshot: {
      path: 'a',
      existedBefore: true,
      previousContent: 'before',
      beforeDigest: digest('before'),
      afterContent: 'after',
      afterDigest: digest('after'),
      rootIdentity: await workspaceRootIdentity(root),
      fileIdentity: await workspaceFileIdentity(join(root, 'a')),
    },
  };
}
it('refuses modified current content instead of overwriting it', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'a'), 'human edit');
  expect(await restoreFileSnapshot(f.snapshot, f.workspace)).toMatchObject({ status: 'conflict' });
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('human edit');
});
it('restores once and recognizes already restored content', async () => {
  const f = await fixture();
  expect(await restoreFileSnapshot(f.snapshot, f.workspace)).toMatchObject({ status: 'restored' });
  expect(await restoreFileSnapshot(f.snapshot, f.workspace)).toMatchObject({
    status: 'already-restored',
  });
});
it('rejects old snapshots and corrupt content proofs', async () => {
  const f = await fixture();
  expect(
    await restoreFileSnapshot(
      { path: 'a', existedBefore: true, previousContent: 'before' },
      f.workspace,
    ),
  ).toMatchObject({ status: 'unavailable' });
  expect(
    await restoreFileSnapshot({ ...f.snapshot, previousContent: 'corrupt' }, f.workspace),
  ).toMatchObject({ status: 'unavailable' });
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
});
it('rejects symlinks and changed root identity', async () => {
  const f = await fixture();
  await symlink(join(f.root, 'a'), join(f.root, 'link'));
  expect(await restoreFileSnapshot({ ...f.snapshot, path: 'link' }, f.workspace)).toMatchObject({
    status: 'conflict',
  });
  expect(
    await restoreFileSnapshot({ ...f.snapshot, rootIdentity: 'other' }, f.workspace),
  ).toMatchObject({ status: 'unavailable' });
});
it('deletes a created file only with complete matching proof', async () => {
  const f = await fixture();
  const snapshot = {
    ...f.snapshot,
    existedBefore: false,
    previousContent: '',
    beforeDigest: digest(''),
  };
  expect(await restoreFileSnapshot(snapshot, f.workspace)).toMatchObject({ status: 'restored' });
  expect(await restoreFileSnapshot(snapshot, f.workspace)).toMatchObject({
    status: 'already-restored',
  });
});
it('requires durable intent before a write and records before plus success evidence', async () => {
  const f = await fixture();
  const { createWorkspaceFileTools } = await import('../src/index.js');
  const facts: unknown[] = [];
  const context = {
    signal: new AbortController().signal,
    sessionId: 's',
    turnId: 't',
    toolCallId: 'call',
  };
  const tools = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: () => {
      throw Error('store offline');
    },
  });
  await expect(
    tools.writeFile.execute({ path: 'a', content: 'new', overwrite: true }, context),
  ).rejects.toThrow('store offline');
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
  const good = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: (value) => {
      facts.push({ type: 'intent', ...value });
    },
    onFileSnapshot: (value) => {
      facts.push({ type: 'before', ...value });
    },
    onFileWriteOutcome: (value) => {
      facts.push({ type: 'outcome', ...value });
    },
  });
  await good.writeFile.execute({ path: 'a', content: 'new', overwrite: true }, context);
  expect(facts).toMatchObject([
    { type: 'intent', turnId: 't', toolCallId: 'call' },
    { type: 'before', previousContent: 'after', beforeDigest: digest('after') },
    { type: 'outcome', status: 'succeeded', captureStatus: 'captured', afterDigest: digest('new') },
  ]);
});
it('explains an audit failure while retaining its durable intent', async () => {
  const f = await fixture();
  const { createWorkspaceFileTools } = await import('../src/index.js');
  const outcomes: unknown[] = [];
  const tools = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: () => {},
    onFileSnapshot: () => {
      throw Error('snapshot unavailable');
    },
    onFileWriteOutcome: (value) => {
      outcomes.push(value);
    },
  });
  const result = await tools.writeFile.execute(
    { path: 'a', content: 'new', overwrite: true },
    { signal: new AbortController().signal, sessionId: 's', turnId: 't', toolCallId: 'call' },
  );
  expect(result).toMatchObject({ undoUnavailableReason: 'snapshot-capture-failed' });
  expect(outcomes).toMatchObject([
    { captureStatus: 'unavailable', reason: 'snapshot-capture-failed' },
  ]);
});
it('cannot capture invalid UTF-8 as restorable original text', async () => {
  const f = await fixture();
  const { createWorkspaceFileTools } = await import('../src/index.js');
  await writeFile(join(f.root, 'a'), Buffer.from([0x61, 0xff]));
  const outcomes: unknown[] = [];
  const tools = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: () => {},
    onFileSnapshot: () => {},
    onFileWriteOutcome: (value) => {
      outcomes.push(value);
    },
  });
  const result = await tools.editFile.execute(
    { path: 'a', oldText: 'a', newText: 'b' },
    { sessionId: 's', turnId: 't', toolCallId: 'c', signal: new AbortController().signal },
  );
  expect(result).toMatchObject({ undoUnavailableReason: 'snapshot-capture-failed' });
  expect(outcomes).toMatchObject([{ captureStatus: 'unavailable' }]);
});
it('reports a per-file permission failure without changing the original bytes', async () => {
  const f = await fixture();
  const { chmod } = await import('node:fs/promises');
  await chmod(join(f.root, 'a'), 0o400);
  try {
    expect(await restoreFileSnapshot(f.snapshot, f.workspace)).toMatchObject({
      status: 'failed',
      reason: 'filesystem-error',
    });
    expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
  } finally {
    await chmod(join(f.root, 'a'), 0o600);
  }
});
it('refuses missing successful file identity and a same-byte replacement inode', async () => {
  const f = await fixture();
  expect(
    await restoreFileSnapshot({ ...f.snapshot, fileIdentity: undefined }, f.workspace),
  ).toMatchObject({ status: 'unavailable' });
  await rm(join(f.root, 'a'));
  await writeFile(join(f.root, 'a'), 'after');
  expect(await restoreFileSnapshot(f.snapshot, f.workspace)).toMatchObject({
    status: 'conflict',
    reason: 'file-identity-changed',
  });
});
