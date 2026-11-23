import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  createInMemorySessionEventStore,
  createSqliteSessionEventStore,
  type SessionEventStore,
} from '@weave/session';
import {
  createFileUndoService,
  createWorkspaceFileTools,
  createWorkspacePolicy,
} from '../src/index.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(store: SessionEventStore = createInMemorySessionEventStore()) {
  const root = await mkdtemp(join(tmpdir(), 'undo-service-'));
  roots.push(root);
  await writeFile(join(root, 'a'), 'before');
  const workspace = createWorkspacePolicy({ root });
  await store.append('s', [
    { type: 'session.created', payload: {} },
    { type: 'turn.started', payload: { turnId: 't' } },
  ]);
  const tools = createWorkspaceFileTools({
    workspace,
    onFileWriteIntent: async ({ sessionId, ...payload }) => {
      await store.append(sessionId ?? 's', [{ type: 'workspace.file-write-intent', payload }]);
    },
    onFileSnapshot: async ({ sessionId, ...payload }) => {
      await store.append(sessionId ?? 's', [{ type: 'workspace.file-snapshot', payload }]);
    },
    onFileWriteOutcome: async ({ sessionId, ...payload }) => {
      await store.append(sessionId ?? 's', [{ type: 'workspace.file-write', payload }]);
    },
  });
  const context = {
    sessionId: 's',
    turnId: 't',
    toolCallId: 'c',
    signal: new AbortController().signal,
  };
  await tools.writeFile.execute({ path: 'a', content: 'after', overwrite: true }, context);
  await tools.writeFile.execute(
    { path: 'b', content: 'created' },
    { ...context, toolCallId: 'c2' },
  );
  await store.append('s', [
    { type: 'turn.completed', payload: { turnId: 't', status: 'completed' } },
  ]);
  return {
    root,
    store,
    workspace,
    input: {
      sessionId: 's',
      projectId: 'p',
      turnId: 't',
      operationId: 'op',
      requestId: 'req',
      workspace,
    },
  };
}
it('replays an exact completed request without modifying subsequent user edits', async () => {
  const f = await fixture();
  const service = createFileUndoService({ store: f.store });
  const first = await service.undo(f.input);
  expect(first.results.map((result) => result.status)).toEqual(['restored', 'restored']);
  await writeFile(join(f.root, 'a'), 'human');
  expect(await createFileUndoService({ store: f.store }).undo(f.input)).toEqual(first);
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('human');
  await expect(service.undo({ ...f.input, turnId: 'other' })).rejects.toMatchObject({
    code: 'undo-id-conflict',
  });
});
it('keeps successful items on explicit retry while allowing a conflicted item to be retried', async () => {
  const f = await fixture();
  const service = createFileUndoService({ store: f.store });
  await writeFile(join(f.root, 'a'), 'human');
  const first = await service.undo(f.input);
  expect(first.results.map((result) => result.status)).toEqual(['conflict', 'restored']);
  await writeFile(join(f.root, 'a'), 'after');
  await writeFile(join(f.root, 'b'), 'new user file');
  const retry = await service.undo({ ...f.input, requestId: 'req2' });
  expect(retry.results.map((result) => result.status)).toEqual(['restored', 'restored']);
  expect(await readFile(join(f.root, 'b'), 'utf8')).toBe('new user file');
});
it('rejects nonterminal and deleted Sessions before filesystem mutation', async () => {
  const f = await fixture();
  const service = createFileUndoService({ store: f.store });
  await f.store.append('s', [{ type: 'turn.started', payload: { turnId: 'next' } }]);
  await expect(service.undo(f.input)).rejects.toMatchObject({ code: 'undo-session-busy' });
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
});
it('resumes after SQLite reopen without reapplying already successful items', async () => {
  const root = await mkdtemp(join(tmpdir(), 'undo-db-'));
  roots.push(root);
  const file = join(root, 'events.sqlite');
  const store = createSqliteSessionEventStore({ filename: file });
  const f = await fixture(store);
  const originalAppend = store.append.bind(store);
  let fail = true;
  store.append = async (session, events) => {
    if (fail && events[0]?.type === 'workspace.undo-completed') {
      fail = false;
      throw Error('power loss');
    }
    return originalAppend(session, events);
  };
  await expect(createFileUndoService({ store }).undo(f.input)).rejects.toThrow('power loss');
  await store.close();
  await writeFile(join(f.root, 'a'), 'human');
  const reopened = createSqliteSessionEventStore({ filename: file });
  const result = await createFileUndoService({ store: reopened }).undo(f.input);
  expect(result.results.map((result) => result.status)).toEqual(['restored', 'restored']);
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('human');
  await reopened.close();
});
it('exposes an interrupted request and partial results for restart review', async () => {
  const f = await fixture();
  const append = f.store.append.bind(f.store);
  let results = 0;
  f.store.append = async (session, events) => {
    if (events[0]?.type === 'workspace.undo-file' && ++results === 2) throw Error('interrupted');
    return append(session, events);
  };
  await expect(createFileUndoService({ store: f.store }).undo(f.input)).rejects.toThrow(
    'interrupted',
  );
  const review = await createFileUndoService({ store: f.store }).review(f.input);
  expect(review.operation).toMatchObject({
    operationId: 'op',
    requestId: 'req',
    status: 'pending',
    results: [{ path: 'a', status: 'restored' }],
  });
});
it('serializes cooperating writes after the whole restore operation', async () => {
  const f = await fixture();
  const append = f.store.append.bind(f.store);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.store.append = async (session, events) => {
    const saved = await append(session, events);
    if (events[0]?.type === 'workspace.undo-started') {
      entered();
      await gate;
    }
    return saved;
  };
  const undo = createFileUndoService({ store: f.store }).undo(f.input);
  await started;
  const writes = createWorkspaceFileTools({ workspace: f.workspace });
  const later = writes.writeFile.execute(
    { path: 'a', content: 'later write', overwrite: true },
    { signal: new AbortController().signal },
  );
  release();
  await undo;
  await later;
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('later write');
});
it('checks the synchronous undo permit again after the durable operation starts', async () => {
  const f = await fixture();
  const append = f.store.append.bind(f.store);
  let permit = true;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.store.append = async (session, events) => {
    const saved = await append(session, events);
    if (events[0]?.type === 'workspace.undo-started') {
      entered();
      await gate;
    }
    return saved;
  };
  const undo = createFileUndoService({ store: f.store }).undo({
    ...f.input,
    assertMutationCurrent: () => {
      if (!permit) throw new Error('Folder permit revoked');
    },
  });
  await started;
  permit = false;
  release();
  await expect(undo).rejects.toThrow('Folder permit revoked');
  expect(await readFile(join(f.root, 'a'), 'utf8')).toBe('after');
  expect(await readFile(join(f.root, 'b'), 'utf8')).toBe('created');
  const events = await f.store.read('s');
  expect(events.some((event) => event.type === 'workspace.undo-file')).toBe(false);
});
it('normalizes real path aliases before durable intent on the actual filesystem', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'Case'), 'A');
  let caseInsensitive = true;
  try {
    await readFile(join(f.root, 'case'));
  } catch {
    caseInsensitive = false;
  }
  if (!caseInsensitive) return;
  await f.store.append('s', [{ type: 'turn.started', payload: { turnId: 'alias' } }]);
  const tools = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: async ({ sessionId, ...payload }) => {
      await f.store.append(sessionId!, [{ type: 'workspace.file-write-intent', payload }]);
    },
    onFileSnapshot: async ({ sessionId, ...payload }) => {
      await f.store.append(sessionId!, [{ type: 'workspace.file-snapshot', payload }]);
    },
    onFileWriteOutcome: async ({ sessionId, ...payload }) => {
      await f.store.append(sessionId!, [{ type: 'workspace.file-write', payload }]);
    },
  });
  const context = {
    sessionId: 's',
    turnId: 'alias',
    toolCallId: 'first',
    signal: new AbortController().signal,
  };
  await tools.writeFile.execute({ path: 'Case', content: 'B', overwrite: true }, context);
  await tools.writeFile.execute(
    { path: 'case', content: 'C', overwrite: true },
    { ...context, toolCallId: 'second' },
  );
  await f.store.append('s', [
    { type: 'turn.completed', payload: { turnId: 'alias', status: 'completed' } },
  ]);
  const result = await createFileUndoService({ store: f.store }).undo({
    ...f.input,
    turnId: 'alias',
  });
  expect(result.results).toMatchObject([{ path: 'Case', status: 'restored' }]);
  expect(await readFile(join(f.root, 'Case'), 'utf8')).toBe('A');
});
it('does not restore a later alias when the first write lost its entire content audit', async () => {
  const f = await fixture();
  await writeFile(join(f.root, 'Case'), 'A');
  let caseInsensitive = true;
  try {
    await readFile(join(f.root, 'case'));
  } catch {
    caseInsensitive = false;
  }
  if (!caseInsensitive) return;
  await f.store.append('s', [{ type: 'turn.started', payload: { turnId: 'alias-lost' } }]);
  let first = true;
  const tools = createWorkspaceFileTools({
    workspace: f.workspace,
    onFileWriteIntent: async ({ sessionId, ...payload }) => {
      await f.store.append(sessionId!, [{ type: 'workspace.file-write-intent', payload }]);
    },
    onFileSnapshot: async ({ sessionId, ...payload }) => {
      if (first) throw Error('lost capture');
      await f.store.append(sessionId!, [{ type: 'workspace.file-snapshot', payload }]);
    },
    onFileWriteOutcome: async ({ sessionId, ...payload }) => {
      if (first) {
        first = false;
        throw Error('lost outcome');
      }
      await f.store.append(sessionId!, [{ type: 'workspace.file-write', payload }]);
    },
  });
  const context = {
    sessionId: 's',
    turnId: 'alias-lost',
    toolCallId: 'first',
    signal: new AbortController().signal,
  };
  await tools.writeFile.execute({ path: 'Case', content: 'B', overwrite: true }, context);
  await tools.writeFile.execute(
    { path: 'case', content: 'C', overwrite: true },
    { ...context, toolCallId: 'second' },
  );
  await f.store.append('s', [
    { type: 'turn.completed', payload: { turnId: 'alias-lost', status: 'completed' } },
  ]);
  const result = await createFileUndoService({ store: f.store }).undo({
    ...f.input,
    turnId: 'alias-lost',
  });
  expect(result.results.length).toBeGreaterThan(0);
  expect(result.results.every((file) => file.status === 'unavailable')).toBe(true);
  expect(await readFile(join(f.root, 'Case'), 'utf8')).toBe('C');
});
