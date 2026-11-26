import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { agentExecutionSnapshotSchema } from '@weave/runtime';
import { startServer } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';
import { createTemporaryDatabaseFile } from './persistence-fixture.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd, stdio: 'ignore' },
  );
}

it('freezes Git changes and the project tree through the real Server and SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weave-context-api-'));
  const plainRoot = await mkdtemp(join(tmpdir(), 'weave-context-plain-'));
  const database = createTemporaryDatabaseFile();
  git(root, 'init', '-q');
  await writeFile(join(root, 'a.txt'), 'before\n');
  await writeFile(join(root, '.env'), 'TOKEN=old\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  await writeFile(join(root, 'a.txt'), 'before\nunique-working-tree-change\n');
  await writeFile(join(root, '.env'), 'TOKEN=unique-secret-value\n');
  await writeFile(join(plainRoot, 'a.txt'), 'plain\n');
  const requests: string[] = [];
  const fakeFetch: typeof fetch = async (_url, init) => {
    requests.push(String(init?.body));
    const chunk = {
      id: randomUUID(),
      object: 'chat.completion.chunk',
      created: 1,
      model: 'ctx-test',
      choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }],
    };
    return new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  const server = await startServer(0, {
    databaseFile: database.filename,
    pluginsDirectory: false,
    fetch: fakeFetch,
    environment: {
      WEAVE_LLM_PROVIDERS: JSON.stringify([
        {
          id: 'ctx-test',
          label: 'Context test',
          type: 'openai-compatible',
          baseUrl: 'https://fixture.invalid/v1',
          apiKey: 'fixture-only',
          defaultModel: 'ctx-test',
        },
      ]),
    },
  });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, value: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
  const session = async (folderPath: string) => {
    const project = (await (
      await post('/projects', { name: 'Context', folderName: 'context', folderPath })
    ).json()) as { id: string };
    return (await (await post(`/projects/${project.id}/sessions`, {})).json()) as { id: string };
  };
  const input = (contexts: unknown) => ({
    provider: 'ctx-test',
    model: 'ctx-test',
    permissionMode: 'ask',
    userMessage: { role: 'user', content: [{ type: 'text', text: 'review' }] },
    contexts,
  });
  try {
    const repo = await session(root);
    const path = `/sessions/${repo.id}/executions`;
    const response = await post(path, {
      requestId: 'ctx',
      input: input([{ kind: 'git-changes' }, { kind: 'project-tree' }]),
    });
    expect(response.status).toBe(202);
    const receipt = agentExecutionSnapshotSchema.parse(await response.json());
    expect(receipt.contextAttachments?.map(({ kind }) => kind)).toEqual([
      'git-changes',
      'project-tree',
    ]);
    expect(JSON.stringify(receipt)).not.toContain('unique-working-tree-change');
    await expect.poll(() => requests.length).toBe(1);
    expect(requests[0]).toContain('unique-working-tree-change');
    expect(requests[0]).toContain('.env (content omitted)');
    expect(requests[0]).not.toContain('unique-secret-value');
    expect(requests[0]).not.toContain('TOKEN=old');
    // The workspace moves on; replay and the next turn still see the frozen change.
    await writeFile(join(root, 'a.txt'), 'rewritten-after-acceptance\n');
    const replay = agentExecutionSnapshotSchema.parse(
      await (
        await post(path, {
          requestId: 'ctx',
          input: input([{ kind: 'git-changes' }, { kind: 'project-tree' }]),
        })
      ).json(),
    );
    expect(replay.executionId).toBe(receipt.executionId);
    await expect
      .poll(
        async () =>
          (await getServerSessionStore(server.runtime).read(repo.id)).filter(
            (event) => event.type === 'execution.finished',
          ).length,
      )
      .toBe(1);
    const next = await post(path, {
      requestId: 'next',
      input: {
        ...input(undefined),
        userMessage: { role: 'user', content: [{ type: 'text', text: 'again' }] },
      },
    });
    expect(next.status).toBe(202);
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1]).toContain('unique-working-tree-change');
    expect(requests[1]).not.toContain('rewritten-after-acceptance');
    const accepted = (await getServerSessionStore(server.runtime).read(repo.id)).filter(
      (event) => event.type === 'execution.accepted',
    );
    expect(accepted[0]?.payload).toHaveProperty('workspaceContext.snapshots.0.kind', 'git-changes');
    expect(accepted[1]?.payload).not.toHaveProperty('workspaceContext');

    // A folder that is not a Git repository rejects Git changes and accepts the tree.
    const plain = await session(plainRoot);
    const plainPath = `/sessions/${plain.id}/executions`;
    const refused = await post(plainPath, {
      requestId: 'git',
      input: input([{ kind: 'git-changes' }]),
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      error: { code: 'execution-context-git-unavailable' },
    });
    expect(
      (await getServerSessionStore(server.runtime).read(plain.id)).some(
        (event) => event.type === 'execution.accepted',
      ),
    ).toBe(false);
    const tree = await post(plainPath, {
      requestId: 'tree',
      input: input([{ kind: 'project-tree' }]),
    });
    expect(tree.status).toBe(202);

    // Wire validation: duplicates and unknown kinds never reach capture.
    for (const contexts of [
      [{ kind: 'git-changes' }, { kind: 'git-changes' }],
      [{ kind: 'environment' }],
      [],
      [{ kind: 'project-tree', path: '/' }],
    ]) {
      const bad = await post(plainPath, { requestId: randomUUID(), input: input(contexts) });
      expect(bad.status).toBe(400);
    }
  } finally {
    await server.stop();
    await rm(root, { recursive: true, force: true });
    await rm(plainRoot, { recursive: true, force: true });
  }
}, 60_000);
