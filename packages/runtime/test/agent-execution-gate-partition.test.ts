import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { StreamEvent } from '@weave/protocol';
import { createInMemorySessionEventStore, type CapturedFileContext } from '@weave/session';
import { createAgentExecutionService } from '../src/agent-execution-service.js';
import { createAgentRunner } from '../src/agent-runner.js';
import type { AgentExecutionInput } from '../src/agent-execution-types.js';

const base: AgentExecutionInput = {
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
  userMessage: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
};
const withFiles: AgentExecutionInput = { ...base, files: [{ path: 'a.txt' }] };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const emptyBundle: CapturedFileContext = {
  version: 1,
  projectId: 'project',
  rootIdentity: 'a'.repeat(64),
  files: [
    {
      path: 'a.txt',
      encoding: 'utf-8',
      content: 'body',
      byteLength: 4,
      sha256: createHash('sha256').update('body').digest('hex'),
      fileIdentity: 'b'.repeat(64),
    },
  ],
};
const flush = async () => {
  for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function setup(
  sessions: readonly string[],
  extra: { admit?: (sessionId: string) => Promise<void> } = {},
) {
  const store = createInMemorySessionEventStore();
  for (const sessionId of sessions)
    await store.append(sessionId, [{ type: 'session.created', payload: {} }]);
  const hold = deferred();
  const captureHold = deferred();
  const service = createAgentExecutionService({
    sessionStore: store,
    admit: extra.admit ?? (async () => {}),
    captureFiles: async (sessionId, _files, options) => {
      if (sessionId === 'a')
        await new Promise<void>((resolve, reject) => {
          void captureHold.promise.then(resolve);
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        });
      return emptyBundle;
    },
    runner: createAgentRunner({
      sessionStore: store,
      llm: {
        async *stream(_request, options): AsyncIterable<StreamEvent> {
          await Promise.race([
            hold.promise,
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
  const send = (sessionId: string, requestId: string, files = false) =>
    service.launch(sessionId, { requestId, input: files ? withFiles : base });
  const close = async () => {
    hold.resolve();
    captureHold.resolve();
    await service.drain();
    await store.close();
  };
  return { store, service, send, hold, captureHold, close };
}

describe('execution gate partitioned by session', () => {
  it('keeps other sessions responsive while one session is stuck capturing files', async () => {
    const f = await setup(['a', 'b']);
    try {
      let stuckDone = false;
      const stuck = f.send('a', 'a1', true).finally(() => {
        stuckDone = true;
      });
      stuck.catch(() => {});
      await flush();
      expect(stuckDone).toBe(false);

      const b1 = await f.send('b', 'b1');
      const b2 = await f.send('b', 'b2');
      const b3 = await f.send('b', 'b3');
      const queue = await f.service.queue('b');
      expect(queue.queued.map((item) => item.executionId)).toEqual([
        b2.executionId,
        b3.executionId,
      ]);
      const reordered = await f.service.reorderQueue('b', {
        requestId: 'reorder',
        expectedRevision: queue.revision,
        executionIds: [b3.executionId, b2.executionId],
      });
      expect(reordered.queued.map((item) => item.executionId)).toEqual([
        b3.executionId,
        b2.executionId,
      ]);
      await f.service.cancelQueued('b', b3.executionId, {
        requestId: 'cancel-b3',
        expectedRevision: reordered.revision,
      });
      const cancelled = await f.service.cancel('b', b1.executionId);
      expect(['cancelling', 'cancelled', 'interrupted']).toContain(cancelled.status);
      expect(stuckDone).toBe(false);

      f.captureHold.resolve();
      expect((await stuck).sessionId).toBe('a');
    } finally {
      await f.close();
    }
  });

  it('keeps FIFO ordering inside one session', async () => {
    const f = await setup(['a']);
    try {
      let secondDone = false;
      const first = f.send('a', 'a1', true);
      first.catch(() => {});
      await flush();
      const second = f.send('a', 'a2').finally(() => {
        secondDone = true;
      });
      second.catch(() => {});
      await flush();
      expect(secondDone).toBe(false);
      f.captureHold.resolve();
      const [one, two] = await Promise.all([first, second]);
      expect(one.status).not.toBe('queued');
      expect(two.status).toBe('queued');
    } finally {
      await f.close();
    }
  });

  describe('global pending limit', () => {
    async function filled(extra: Parameters<typeof setup>[1] = {}) {
      const sessions = [...Array.from({ length: 10 }, (_item, index) => `s${index}`), 'x', 'y'];
      const f = await setup(sessions, extra);
      for (const [index, sessionId] of sessions.entries()) {
        await f.send(sessionId, `${sessionId}-active`);
        const queued = index < 9 ? 10 : index === 9 ? 9 : 0;
        for (let count = 0; count < queued; count++)
          await f.send(sessionId, `${sessionId}-${count}`);
      }
      return f;
    }

    it('admits only one of two concurrent launches when one slot is left', async () => {
      const armed = { on: false };
      const gate = deferred();
      const f = await filled({
        admit: async (sessionId) => {
          if (armed.on && (sessionId === 'x' || sessionId === 'y')) await gate.promise;
        },
      });
      try {
        armed.on = true;
        const results = [f.send('x', 'x-new'), f.send('y', 'y-new')].map((promise) =>
          promise.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          ),
        );
        await flush();
        gate.resolve();
        const settled = await Promise.all(results);
        expect(settled.filter((item) => item.ok)).toHaveLength(1);
        const failed = settled.find((item) => !item.ok);
        expect(failed).toMatchObject({ error: { code: 'execution-queue-full' } });
      } finally {
        gate.resolve();
        await f.close();
      }
    }, 30000);

    it('releases the reservation when admission fails', async () => {
      const armed = { on: false };
      let failX = true;
      const gate = deferred();
      const f = await filled({
        admit: async (sessionId) => {
          if (armed.on && sessionId === 'x' && failX) {
            await gate.promise;
            throw new Error('denied');
          }
        },
      });
      try {
        armed.on = true;
        const x = f.send('x', 'x-new');
        x.catch(() => {});
        await flush();
        await expect(f.send('y', 'y-new')).rejects.toMatchObject({
          code: 'execution-queue-full',
        });
        gate.resolve();
        await expect(x).rejects.toThrow();
        failX = false;
        expect((await f.send('y', 'y-new')).status).toBe('queued');
      } finally {
        gate.resolve();
        await f.close();
      }
    }, 30000);
  });

  it('drain and recover finish across sessions and drain stops new admissions', async () => {
    const f = await setup(['a', 'b', 'c']);
    try {
      const stuck = f.send('a', 'a1', true);
      const stuckOutcome = stuck.then(
        () => 'ok',
        (error: unknown) => (error as { code?: string }).code,
      );
      await flush();
      await f.send('b', 'b1');
      await f.send('b', 'b2');
      await f.send('c', 'c1');

      const recovered = f.service.recover(['b', 'c']);
      await recovered;

      await f.service.drain();
      expect(await stuckOutcome).toBe('execution-file-capture-timeout');
      await expect(f.send('c', 'c-late')).rejects.toMatchObject({ code: 'execution-closed' });
      const queue = await f.service.queue('b');
      expect(queue.queued).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
});
