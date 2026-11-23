import process from 'node:process';
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSqliteMemoryStore } from '../dist/index.js';

const scope = { kind: 'user' };
const guard = { assertAuthorized() {}, assertNewMutation() {}, beforeCommit() {} };
const script = fileURLToPath(import.meta.url);
if (process.argv[2] === 'try') {
  try {
    const store = createSqliteMemoryStore({ filename: process.argv[3] });
    await store.close();
    process.exit(2);
  } catch (error) {
    assert.equal(error.code, 'memory-busy');
    process.exit(0);
  }
} else if (process.argv[2] === 'hold') {
  const store = createSqliteMemoryStore({ filename: process.argv[3] });
  const key = { scope, requestId: randomUUID(), callerKey: 'local-user', digest: 'a'.repeat(64) };
  const receipt = store.commit(
    {
      kind: 'create',
      expectedRevision: 0,
      key,
      provenance: { actor: 'local-user' },
      content: { title: 'dist worker needle', content: 'Built entry search', tags: [] },
    },
    guard,
  );
  process.send({ key, receipt });
  process.on('message', async () => {
    await store.close();
    process.exit(0);
  });
} else {
  const directory = mkdtempSync(join(tmpdir(), 'weave-memory-dist-'));
  const filename = join(directory, 'memory.sqlite');
  try {
    const child = fork(script, ['hold', filename], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [message] = await once(child, 'message');
    assert.equal(spawnSync(process.execPath, [script, 'try', filename]).status, 0);
    child.kill('SIGKILL');
    await once(child, 'exit');
    const store = createSqliteMemoryStore({ filename });
    assert.deepEqual(store.lookupReceipt(message.key), message.receipt);
    const result = await store.search({ scopes: [scope], query: 'needle', limit: 2 });
    assert.equal(result.entries[0].title, 'dist worker needle');
    await store.close();
    const normal = fork(script, ['hold', filename], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const [next] = await once(normal, 'message');
    normal.send('close');
    await once(normal, 'exit');
    const reopened = createSqliteMemoryStore({ filename });
    assert.deepEqual(reopened.lookupReceipt(next.key), next.receipt);
    await reopened.close();
    process.stdout.write(
      'dist smoke passed: cross-process owner, kill recovery, normal close, read-only worker\n',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
