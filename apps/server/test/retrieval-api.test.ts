import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  memoryReceiptSchema,
  memoryRefSchema,
  retrievalCapabilitiesSchema,
  retrievalJobSnapshotSchema,
  retrievalPreviewSchema,
  retrievalQueryResultSchema,
  retrievalReceiptSchema,
  retrievalSourceResultSchema,
} from '@weave/protocol';
import { RetrievalStoreError, RetrievalStoreStartupError } from '@weave/retrieval';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startServer, type StartServerOptions } from '../src/main.js';
import { getServerSessionStore } from '../src/runtime.js';
import { retryFailedServerStartupCleanup } from '../src/server-shutdown.js';

type StartedServer = Awaited<ReturnType<typeof startServer>>;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function json(response: Response, status = 200): Promise<unknown> {
  const value: unknown = await response.json();
  expect(response.status, JSON.stringify(value)).toBe(status);
  return value;
}

function request(server: StartedServer, path: string, body?: unknown): Promise<Response> {
  return fetch(
    `http://127.0.0.1:${server.port}${path}`,
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
  );
}

async function fixture(options: StartServerOptions = {}) {
  const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-retrieval-http-'));
  cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
  const root = join(dataDirectory, 'project');
  const otherRoot = join(dataDirectory, 'other');
  await Promise.all([mkdir(root), mkdir(otherRoot)]);
  const sourcePath = join(root, 'task.ts');
  const source = 'export const durableJob = "索引权限";\n';
  await writeFile(sourcePath, source);
  const serverOptions = { dataDirectory, environment: {}, ...options };
  async function start() {
    const server = await startServer(0, serverOptions);
    cleanups.push(() => server.stop());
    return server;
  }
  const server = await start();
  const createProject = async (name: string, folder: string) => {
    const body = await json(
      await request(server, '/projects', {
        name,
        folderName: name.toLowerCase(),
        folderPath: folder,
      }),
      201,
    );
    return (body as { id: string }).id;
  };
  const projectId = await createProject('Primary', root);
  const otherId = await createProject('Other', otherRoot);
  return { server, start, projectId, otherId, source, sourcePath, root };
}

function route(id: string, path: string): string {
  return `/projects/${id}/retrieval/${path}`;
}

function query(
  query: string,
  sources: Array<'workspace' | 'memory'> = ['workspace'],
  mode = 'lexical',
) {
  return { requestId: randomUUID(), mode, intent: { query, filters: { sources, paths: {} } } };
}

async function build(server: StartedServer, projectId: string, intent: unknown) {
  const requestId = randomUUID();
  const preview = retrievalPreviewSchema.parse(
    await json(await request(server, route(projectId, 'preview'), { requestId, intent })),
  );
  const input = {
    requestId,
    previewId: preview.previewId,
    mode: preview.mode,
    manifestDigest: preview.manifestDigest,
  };
  const receipt = retrievalReceiptSchema.parse(
    await json(await request(server, route(projectId, 'builds'), input)),
  );
  await vi.waitFor(async () => {
    const snapshot = retrievalJobSnapshotSchema.parse(
      await json(await request(server, route(projectId, `builds/${receipt.jobId}`))),
    );
    expect(snapshot.job.terminal, JSON.stringify(snapshot)).toMatchObject({ status: 'completed' });
  });
  return { input, receipt, preview };
}

describe('Retrieval with the production Server composition', () => {
  it('retains branded partial startup cleanup and preserves the Store startup classification', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'weave-retrieval-startup-'));
    cleanups.push(() => rm(dataDirectory, { recursive: true, force: true }));
    const options = { dataDirectory, environment: {} };
    const busy = new RetrievalStoreError('retrieval-busy');
    await expect(
      startServer(0, {
        ...options,
        retrievalIndexFactory: () => {
          throw busy;
        },
      }),
    ).rejects.toBe(busy);
    const cleanup = {
      closeSync: vi.fn(),
      drain: vi.fn(async () => {}),
      close: vi.fn(async () => {}).mockRejectedValueOnce(new Error('Owner is still open')),
    };
    const partial = new RetrievalStoreStartupError(cleanup);
    const failure: unknown = await startServer(0, {
      ...options,
      retrievalIndexFactory: () => {
        throw partial;
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(partial);
    expect(cleanup.close).toHaveBeenCalledOnce();
    await retryFailedServerStartupCleanup(failure);
    expect(cleanup.close).toHaveBeenCalledTimes(2);
    const server = await startServer(0, options);
    cleanups.push(() => server.stop());
    expect((await request(server, '/health')).status).toBe(200);
  });

  it('builds without credentials, finds code and CJK text, opens exact bytes, and replays after restart', async () => {
    const { server, start, projectId, otherId, source, sourcePath } = await fixture();
    expect(
      retrievalCapabilitiesSchema.parse(
        await json(await request(server, route(projectId, 'capabilities'))),
      ),
    ).toMatchObject({
      lexical: { available: true },
      embedding: { configured: false },
    });
    const { input, receipt } = await build(server, projectId, {
      mode: 'lexical',
      workspace: { paths: {} },
    });
    const found = retrievalQueryResultSchema.parse(
      await json(await request(server, route(projectId, 'query'), query('索引权限'))),
    );
    const citation = found.hits[0]?.citation;
    expect(citation?.source).toMatchObject({ kind: 'workspace', path: 'task.ts' });
    const opened = retrievalSourceResultSchema.parse(
      await json(await request(server, route(projectId, 'source'), { citation })),
    );
    expect(opened.page.text).toBe(source);
    await json(await request(server, route(otherId, `builds/${receipt.jobId}`)), 404);
    await server.stop();

    const restarted = await start();
    expect(await json(await request(restarted, route(projectId, 'builds'), input))).toEqual(
      receipt,
    );
    expect(
      await json(
        await request(restarted, route(projectId, 'builds'), { ...input, mode: 'hybrid' }),
        409,
      ),
    ).toMatchObject({ error: { code: 'retrieval-request-conflict' } });
    const after = retrievalQueryResultSchema.parse(
      await json(await request(restarted, route(projectId, 'query'), query('durableJob'))),
    );
    expect(after.hits[0]?.citation).toEqual(citation);
    await writeFile(sourcePath, 'export const durableJob = "replacement";\n');
    expect(
      await json(await request(restarted, route(projectId, 'source'), { citation }), 409),
    ).toMatchObject({ error: { code: 'retrieval-stale-source' } });
  });

  it('hides an indexed Memory as soon as access is disabled', async () => {
    const { server, projectId } = await fixture();
    const scope = { kind: 'project' as const, projectId };
    const { receipt } = (await json(
      await request(server, '/memory/records', {
        operation: 'create',
        expectedRevision: 0,
        requestId: randomUUID(),
        scope,
        title: 'Reviewed source',
        content: 'compositionneedle inside reviewed memory',
        tags: ['weave'],
      }),
      201,
    )) as { receipt: unknown };
    const memoryRef = memoryRefSchema.parse(memoryReceiptSchema.parse(receipt).result);
    await json(
      await request(server, '/memory/access', {
        scope,
        requestId: randomUUID(),
        expectedSettingRevision: 0,
        level: 'read-only',
      }),
    );
    await build(server, projectId, {
      mode: 'lexical',
      workspace: { enabled: false, paths: {} },
      memoryRefs: [memoryRef],
    });
    const search = () =>
      request(server, route(projectId, 'query'), query('compositionneedle', ['memory']));
    const found = retrievalQueryResultSchema.parse(await json(await search()));
    const citation = found.hits[0]?.citation;
    expect(citation?.source).toMatchObject({ kind: 'memory', ref: memoryRef });
    await json(
      await request(server, '/memory/access', {
        scope,
        requestId: randomUUID(),
        expectedSettingRevision: 1,
        level: 'disabled',
      }),
    );
    const after = retrievalQueryResultSchema.parse(await json(await search()));
    expect(after.hits).toEqual([]);
    expect(
      await json(await request(server, route(projectId, 'source'), { citation }), 409),
    ).toMatchObject({ error: { code: 'retrieval-stale-source' } });
  });

  it('sends actual approved chunk bytes and requires a separate semantic query action', async () => {
    const sent: Array<{ input: string[] }> = [];
    const embeddingFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      sent.push(body);
      const vector = [1, ...Array<number>(511).fill(0)];
      return Response.json({
        object: 'list',
        model: 'text-embedding-3-small',
        data: body.input.map((_value, index) => ({
          object: 'embedding',
          index,
          embedding: vector,
        })),
      });
    };
    const { server, projectId, source } = await fixture({
      embeddingFetch,
      environment: {
        WEAVE_EMBEDDING_PROVIDER: 'openai',
        WEAVE_OPENAI_EMBEDDING_API_KEY: 'fixture-key',
      },
    });
    const requestId = randomUUID();
    const preview = retrievalPreviewSchema.parse(
      await json(
        await request(server, route(projectId, 'preview'), {
          requestId,
          intent: { mode: 'hybrid', workspace: { paths: {} } },
        }),
      ),
    );
    expect(sent).toEqual([]);
    const input = {
      requestId,
      previewId: preview.previewId,
      mode: preview.mode,
      manifestDigest: preview.manifestDigest,
    };
    const receipt = retrievalReceiptSchema.parse(
      await json(await request(server, route(projectId, 'builds'), input)),
    );
    await vi.waitFor(async () => {
      const { job } = retrievalJobSnapshotSchema.parse(
        await json(await request(server, route(projectId, `builds/${receipt.jobId}`))),
      );
      expect(job.terminal, JSON.stringify(job)).toMatchObject({ status: 'completed' });
    });
    expect(sent).toMatchObject([{ input: [source] }]);
    expect(await json(await request(server, route(projectId, 'builds'), input))).toEqual(receipt);
    await json(await request(server, route(projectId, 'query'), query('durableJob')));
    expect(sent).toHaveLength(1);
    const hybrid = retrievalQueryResultSchema.parse(
      await json(
        await request(
          server,
          route(projectId, 'query'),
          query('durableJob', ['workspace'], 'hybrid'),
        ),
      ),
    );
    expect(hybrid.hits[0]).toMatchObject({ lexicalRank: 1, vectorRank: 1 });
    expect(sent).toMatchObject([{ input: [source] }, { input: ['durableJob'] }]);
  });

  it('runs root and pinned child searches through the real Runner and durable Session calls', async () => {
    const prompts: Array<{
      messages: Array<{ role: string; content: unknown }>;
      tools?: Array<{ function: { name: string } }>;
    }> = [];
    const fetchModel: typeof fetch = async (_url, init) => {
      const modelRequest = JSON.parse(String(init?.body)) as (typeof prompts)[number];
      prompts.push(modelRequest);
      const userText = JSON.stringify(
        modelRequest.messages.find(({ role }) => role === 'user')?.content,
      );
      const child = userText.includes('Find durableJob as child.');
      const step = modelRequest.messages.filter(({ role }) => role === 'tool').length;
      const tool =
        !child && step === 1
          ? {
              name: 'agent_spawn',
              arguments: {
                title: 'Child search',
                prompt: 'Find durableJob as child.',
                access: 'workspace',
              },
            }
          : step === 0
            ? { name: 'search_project', arguments: query('durableJob').intent }
            : undefined;
      const chunk = {
        id: randomUUID(),
        object: 'chat.completion.chunk',
        created: 1,
        model: 'retrieval-test',
        choices: [
          {
            index: 0,
            delta: tool
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: randomUUID(),
                      type: 'function',
                      function: {
                        name: tool.name,
                        arguments: JSON.stringify(tool.arguments),
                      },
                    },
                  ],
                }
              : { content: 'Search complete.' },
            finish_reason: null,
          },
        ],
      };
      const final = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      };
      return new Response(
        `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const { server, projectId } = await fixture({
      fetch: fetchModel,
      environment: {
        WEAVE_LLM_PROVIDERS: JSON.stringify([
          {
            id: 'retrieval-test',
            label: 'Retrieval test',
            type: 'openai-compatible',
            baseUrl: 'https://fixture.invalid/v1',
            apiKey: 'fixture-only',
            defaultModel: 'retrieval-test',
          },
        ]),
      },
    });
    await build(server, projectId, { mode: 'lexical', workspace: { paths: {} } });
    const { id: sessionId } = (await json(
      await request(server, `/projects/${projectId}/sessions`, {}),
      201,
    )) as { id: string };
    await json(
      await request(server, `/sessions/${sessionId}/executions`, {
        requestId: randomUUID(),
        input: {
          provider: 'retrieval-test',
          model: 'retrieval-test',
          permissionMode: 'ask',
          userMessage: { role: 'user', content: [{ type: 'text', text: 'Find durableJob.' }] },
        },
      }),
      202,
    );
    const store = getServerSessionStore(server.runtime);
    const readFinished = async (id: string) => {
      await expect
        .poll(async () =>
          (await store.read(id)).some((event) => event.type === 'execution.finished'),
        )
        .toBe(true);
      return store.read(id);
    };
    const parentEvents = await readFinished(sessionId);
    const accepted = parentEvents.find((event) => event.type === 'agent.task.accepted');
    expect(accepted?.payload).toMatchObject({ access: 'workspace' });
    const childEvents = await readFinished(accepted!.payload.childSessionId);
    for (const events of [parentEvents, childEvents]) {
      const result = events.find(
        (event) => event.type === 'tool-result.created' && event.payload.name === 'search_project',
      );
      expect(result?.payload).toMatchObject({
        name: 'search_project',
        status: 'completed',
        truncated: false,
      });
      if (result?.type !== 'tool-result.created') throw new Error('Missing search tool result');
      const found = retrievalQueryResultSchema.parse(JSON.parse(result.payload.content));
      expect(found.hits[0]?.citation.source).toMatchObject({ path: 'task.ts' });
    }
    const childPrompt = prompts.find((modelRequest) =>
      JSON.stringify(modelRequest.messages.find(({ role }) => role === 'user')?.content).includes(
        'Find durableJob as child.',
      ),
    );
    const childTools = childPrompt?.tools?.map((item) => item.function.name);
    expect(childTools).toEqual(expect.arrayContaining(['search_project', 'project_index_status']));
    for (const tool of ['build_project_index', 'cancel_project_index', 'semantic_search_project'])
      expect(childTools).not.toContain(tool);
  });

  it('fences further embedding batches when project memory access is revoked', async () => {
    const sent: string[][] = [];
    const embeddingFetch: typeof fetch = async (_url, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      sent.push(input);
      // Hold the first observable send until the Memory precommit fence aborts it.
      return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException('Cancelled', 'AbortError'));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    };
    const { server, projectId, root } = await fixture({
      embeddingFetch,
      environment: {
        WEAVE_EMBEDDING_PROVIDER: 'openai',
        WEAVE_OPENAI_EMBEDDING_API_KEY: 'fixture-key',
      },
    });
    await Promise.all(
      Array.from({ length: 17 }, (_, index) =>
        writeFile(join(root, `${index}.ts`), `export const marker${index} = ${index};\n`),
      ),
    );
    const scope = { kind: 'project' as const, projectId };
    const { receipt: memoryReceipt } = (await json(
      await request(server, '/memory/records', {
        operation: 'create',
        expectedRevision: 0,
        requestId: randomUUID(),
        scope,
        title: 'Reviewed source',
        content: 'exact reviewed body',
        tags: ['weave'],
      }),
      201,
    )) as { receipt: unknown };
    const memoryRef = memoryRefSchema.parse(memoryReceiptSchema.parse(memoryReceipt).result);
    await json(
      await request(server, '/memory/access', {
        scope,
        requestId: randomUUID(),
        expectedSettingRevision: 0,
        level: 'read-only',
      }),
    );
    const requestId = randomUUID();
    const preview = retrievalPreviewSchema.parse(
      await json(
        await request(server, route(projectId, 'preview'), {
          requestId,
          intent: {
            mode: 'hybrid',
            workspace: { paths: {} },
            memoryRefs: [memoryRef],
          },
        }),
      ),
    );
    expect(preview.embedding?.requestCount).toBeGreaterThan(1);
    const input = {
      requestId,
      previewId: preview.previewId,
      mode: preview.mode,
      manifestDigest: preview.manifestDigest,
    };
    const receipt = retrievalReceiptSchema.parse(
      await json(await request(server, route(projectId, 'builds'), input)),
    );
    await expect.poll(() => sent.length).toBe(1);
    await json(
      await request(server, '/memory/access', {
        scope,
        requestId: randomUUID(),
        expectedSettingRevision: 1,
        level: 'disabled',
      }),
    );
    await expect
      .poll(async () => {
        const { job } = retrievalJobSnapshotSchema.parse(
          await json(await request(server, route(projectId, `builds/${receipt.jobId}`))),
        );
        return job.terminal;
      })
      .toMatchObject({ status: 'cancelled', reason: 'authority-revoked' });
    expect(sent).toHaveLength(1);
  });
});
