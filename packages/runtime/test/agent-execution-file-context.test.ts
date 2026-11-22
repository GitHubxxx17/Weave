import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { StreamEvent } from '@weave/protocol';
import {
  createInMemorySessionEventStore,
  type CapturedFileContext,
  type SessionEventStore,
} from '@weave/session';
import { createAgentExecutionService } from '../src/agent-execution-service.js';
import { createAgentRunner } from '../src/agent-runner.js';
import {
  AgentExecutionError,
  type AgentExecutionInput,
  type CaptureFiles,
} from '../src/agent-execution-types.js';

const input: AgentExecutionInput = {
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
  userMessage: { role: 'user', content: [{ type: 'text', text: 'Explain' }] },
  files: [{ path: 'a.txt' }],
};
function bundle(content = 'unique-captured-body'): CapturedFileContext {
  return {
    version: 1,
    projectId: 'project',
    rootIdentity: 'a'.repeat(64),
    files: [
      {
        path: 'a.txt',
        encoding: 'utf-8',
        content,
        byteLength: Buffer.byteLength(content),
        sha256: createHash('sha256').update(content).digest('hex'),
        fileIdentity: 'b'.repeat(64),
      },
    ],
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function fixture(captureFiles?: CaptureFiles, supplied?: SessionEventStore) {
  const store = supplied ?? createInMemorySessionEventStore();
  await store.append('s', [{ type: 'session.created', payload: {} }]);
  const modelStarted = deferred<void>();
  const release = deferred<void>();
  const service = createAgentExecutionService({
    sessionStore: store,
    admit: async () => {},
    ...(captureFiles === undefined ? {} : { captureFiles }),
    runner: createAgentRunner({
      sessionStore: store,
      llm: {
        async *stream(_request, options): AsyncIterable<StreamEvent> {
          modelStarted.resolve();
          await Promise.race([
            release.promise,
            new Promise<void>((_yes, reject) => {
              if (options?.signal?.aborted) reject(options.signal.reason);
              else
                options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
                  once: true,
                });
            }),
          ]);
          yield { type: 'finish', reason: 'stop' };
        },
      },
    }),
  });
  const close = async () => {
    release.resolve();
    await service.drain();
    await store.close();
  };
  return { store, service, close, modelStarted, release };
}

describe('file snapshot admission', () => {
  it('captures once before durable acceptance and exact replay/conflict precedes capture, including closure', async () => {
    const capture = vi.fn<CaptureFiles>(async () => bundle());
    const f = await fixture(capture);
    try {
      const launch = { requestId: 'same', input };
      const first = await f.service.launch('s', launch);
      await f.modelStarted.promise;
      capture.mockImplementation(async () => {
        throw new Error('deleted file');
      });
      const replay = await f.service.launch('s', structuredClone(launch));
      expect(replay.executionId).toBe(first.executionId);
      expect(capture).toHaveBeenCalledTimes(1);
      await expect(
        f.service.launch('s', { ...launch, input: { ...input, files: [{ path: 'b.txt' }] } }),
      ).rejects.toMatchObject({ code: 'execution-request-conflict' });
      expect(capture).toHaveBeenCalledTimes(1);
      expect(first.fileAttachments).toEqual(
        bundle().files.map(({ content: _content, fileIdentity: _identity, ...summary }) => {
          void _content;
          void _identity;
          return summary;
        }),
      );
      const events = await f.store.read('s');
      expect(events.filter((event) => event.type === 'execution.accepted')).toHaveLength(1);
      expect(JSON.stringify(events).split('unique-captured-body')).toHaveLength(2);
      expect(JSON.stringify(first)).not.toContain('unique-captured-body');
      expect(JSON.stringify(first)).not.toContain('rootIdentity');
      f.service.closeSync();
      expect((await f.service.launch('s', launch)).executionId).toBe(first.executionId);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      await f.close();
    }
  });

  it('keeps queued summaries small, captures each duplicate once and rejects full queue before I/O', async () => {
    const capture = vi.fn<CaptureFiles>(async () => bundle());
    const f = await fixture(capture);
    try {
      await f.service.launch('s', { requestId: 'active', input });
      await f.modelStarted.promise;
      const launch = { requestId: 'queued', input };
      const [a, b] = await Promise.all([
        f.service.launch('s', launch),
        f.service.launch('s', launch),
      ]);
      expect(a.executionId).toBe(b.executionId);
      for (let i = 1; i < 10; i++) await f.service.launch('s', { requestId: `q${i}`, input });
      expect(capture).toHaveBeenCalledTimes(11);
      await expect(f.service.launch('s', { requestId: 'full', input })).rejects.toMatchObject({
        code: 'execution-queue-full',
      });
      expect(capture).toHaveBeenCalledTimes(11);
      const queue = await f.service.queue('s');
      expect(queue.queued.every((item) => item.fileCount === 1)).toBe(true);
      expect(JSON.stringify(queue)).not.toContain('unique-captured-body');
      expect(JSON.stringify(queue)).not.toContain('rootIdentity');
      const removed = await f.service.cancelQueued('s', a.executionId, {
        requestId: 'remove',
        expectedRevision: queue.revision,
      });
      expect(removed.queued).toHaveLength(9);
      expect(capture).toHaveBeenCalledTimes(11);
    } finally {
      await f.close();
    }
  });

  it('rejects absent or invalid capture atomically and maps unknown I/O failure to a safe code', async () => {
    for (const capture of [
      undefined,
      async () => ({ ...bundle(), files: [] }),
      async () => {
        throw new Error('/private/root/raw-error');
      },
    ]) {
      const f = await fixture(capture as CaptureFiles | undefined);
      try {
        await expect(f.service.launch('s', { requestId: 'refused', input })).rejects.toMatchObject({
          code:
            capture === undefined ? 'execution-file-unavailable' : 'execution-file-capture-failed',
        });
        expect(await f.store.read('s')).toHaveLength(1);
        expect((await f.service.queue('s')).active).toBeNull();
      } finally {
        await f.close();
      }
    }
  });

  it('close aborts the owned capture and waits for cleanup before rejecting without late acceptance', async () => {
    const started = deferred<AbortSignal>();
    const cleaned = deferred<void>();
    const capture: CaptureFiles = async (_session, _files, { signal }) => {
      started.resolve(signal);
      await cleaned.promise;
      return bundle();
    };
    const f = await fixture(capture);
    const pending = f.service.launch('s', { requestId: 'closing', input });
    const signal = await started.promise;
    f.service.closeSync();
    expect(signal.aborted).toBe(true);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    cleaned.resolve();
    await expect(pending).rejects.toMatchObject({ code: 'execution-file-capture-timeout' });
    expect(await f.store.read('s')).toHaveLength(1);
    await f.close();
  });

  it('preserves a typed whole-batch capture rejection and a later attempt can capture fresh bytes', async () => {
    const capture = vi
      .fn<CaptureFiles>()
      .mockRejectedValueOnce(
        new AgentExecutionError('execution-file-too-large', 'File is too large'),
      )
      .mockResolvedValueOnce(bundle('fresh'));
    const f = await fixture(capture);
    try {
      const launch = { requestId: 'retry-after-rejection', input };
      await expect(f.service.launch('s', launch)).rejects.toMatchObject({
        code: 'execution-file-too-large',
      });
      expect(await f.store.read('s')).toHaveLength(1);
      await expect(f.service.launch('s', launch)).resolves.toMatchObject({
        fileAttachments: [{ byteLength: 5 }],
      });
      expect(capture).toHaveBeenCalledTimes(2);
    } finally {
      await f.close();
    }
  });

  it.each(['after', 'unreadable', 'before'] as const)(
    'reconciles %s append failure without replacing any durable capture',
    async (mode) => {
      const base = createInMemorySessionEventStore();
      let fail = true;
      let unreadable = false;
      const store: SessionEventStore = {
        ...base,
        async read(session, options) {
          if (unreadable) throw new Error('read unavailable');
          return base.read(session, options);
        },
        async append(session, events) {
          if (fail && events.some((event) => event.type === 'execution.accepted')) {
            fail = false;
            if (mode !== 'before') await base.append(session, events);
            if (mode === 'unreadable') unreadable = true;
            throw new Error('append error');
          }
          return base.append(session, events);
        },
      };
      const capture = vi.fn<CaptureFiles>(async () => bundle('original'));
      const f = await fixture(capture, store);
      try {
        const launch = { requestId: 'ambiguous', input };
        let first;
        if (mode === 'after') first = await f.service.launch('s', launch);
        else
          await expect(f.service.launch('s', launch)).rejects.toMatchObject({
            code:
              mode === 'before' ? 'execution-persistence-error' : 'execution-admission-uncertain',
          });
        unreadable = false;
        capture.mockResolvedValue(bundle('modified'));
        const retry = await f.service.launch('s', launch);
        if (first !== undefined) expect(retry.executionId).toBe(first.executionId);
        expect(capture).toHaveBeenCalledTimes(mode === 'before' ? 2 : 1);
        const acceptances = (await base.read('s')).filter(
          (event) => event.type === 'execution.accepted',
        );
        expect(acceptances).toHaveLength(1);
        expect(acceptances[0]?.payload.fileContext?.files[0]?.content).toBe(
          mode === 'before' ? 'modified' : 'original',
        );
      } finally {
        unreadable = false;
        await f.close();
      }
    },
  );

  it('aborts the cooperative deadline without detaching cleanup or appending a late capture', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Deadline', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    const started = deferred<AbortSignal>();
    const cleanup = deferred<void>();
    const f = await fixture(async (_session, _files, { signal }) => {
      started.resolve(signal);
      await cleanup.promise;
      return bundle();
    });
    try {
      const pending = f.service.launch('s', { requestId: 'deadline', input });
      const checked = expect(pending).rejects.toMatchObject({
        code: 'execution-file-capture-timeout',
      });
      const signal = await started.promise;
      await vi.advanceTimersByTimeAsync(5001);
      expect(signal.aborted).toBe(true);
      expect(await f.store.read('s')).toHaveLength(1);
      cleanup.resolve();
      await checked;
      expect(await f.store.read('s')).toHaveLength(1);
    } finally {
      cleanup.resolve();
      timeout.mockRestore();
      vi.useRealTimers();
      await f.close();
    }
  });

  it('does not relabel a confirmed append as capture timeout when closure arrives after append started', async () => {
    const base = createInMemorySessionEventStore();
    const entered = deferred<void>();
    const releaseAppend = deferred<void>();
    const store: SessionEventStore = {
      ...base,
      async append(session, events) {
        if (events.some((event) => event.type === 'execution.accepted')) {
          entered.resolve();
          await releaseAppend.promise;
        }
        return base.append(session, events);
      },
    };
    const capture = vi.fn<CaptureFiles>(async () => bundle());
    const f = await fixture(capture, store);
    try {
      const pending = f.service.launch('s', { requestId: 'committing', input });
      await entered.promise;
      f.service.closeSync();
      releaseAppend.resolve();
      const receipt = await pending;
      expect(receipt.fileAttachments).toHaveLength(1);
      expect(
        (await base.read('s')).filter((event) => event.type === 'execution.accepted'),
      ).toHaveLength(1);
      expect(capture).toHaveBeenCalledTimes(1);
    } finally {
      releaseAppend.resolve();
      await f.close();
    }
  });
});
