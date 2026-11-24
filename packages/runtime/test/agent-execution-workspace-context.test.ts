import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { LlmRequest, Message, StreamEvent } from '@weave/protocol';
import {
  createInMemorySessionEventStore,
  projectMessageWorkspaceContexts,
  projectSession,
  type CapturedWorkspaceContext,
  type SessionEventStore,
} from '@weave/session';
import { createAgentExecutionService } from '../src/agent-execution-service.js';
import { createAgentRunner } from '../src/agent-runner.js';
import {
  AgentExecutionError,
  type AgentExecutionInput,
  type CaptureContexts,
  type CaptureFiles,
} from '../src/agent-execution-types.js';

const baseInput: AgentExecutionInput = {
  provider: 'mock',
  model: 'model',
  permissionMode: 'ask',
  userMessage: { role: 'user', content: [{ type: 'text', text: 'Review my change' }] },
};
const withContexts = (
  contexts: NonNullable<AgentExecutionInput['contexts']>,
  text = 'Review my change',
): AgentExecutionInput => ({
  ...baseInput,
  userMessage: { role: 'user', content: [{ type: 'text', text }] },
  contexts,
});

function snapshot(
  kind: 'git-changes' | 'project-tree',
  content: string,
): CapturedWorkspaceContext['snapshots'][number] {
  const common = {
    capturedAt: '2026-11-24T10:00:00.000Z',
    content,
    byteLength: Buffer.byteLength(content),
    truncated: false,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
  return kind === 'git-changes'
    ? { kind, ...common }
    : { kind, ...common, entryCount: content.split('\n').length };
}
function bundle(
  contents: Partial<Record<'git-changes' | 'project-tree', string>>,
  kinds: readonly ('git-changes' | 'project-tree')[] = ['git-changes'],
): CapturedWorkspaceContext {
  return {
    version: 1,
    projectId: 'project',
    snapshots: kinds.map((kind) => snapshot(kind, contents[kind] ?? `${kind}-body`)),
  };
}

async function fixture(options: {
  captureContexts?: CaptureContexts;
  captureFiles?: CaptureFiles;
  store?: SessionEventStore;
}) {
  const store = options.store ?? createInMemorySessionEventStore();
  await store.append('s', [{ type: 'session.created', payload: {} }]);
  const requests: LlmRequest[] = [];
  const service = createAgentExecutionService({
    sessionStore: store,
    admit: async () => {},
    ...(options.captureContexts === undefined ? {} : { captureContexts: options.captureContexts }),
    ...(options.captureFiles === undefined ? {} : { captureFiles: options.captureFiles }),
    runner: createAgentRunner({
      sessionStore: store,
      llm: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(request): AsyncIterable<StreamEvent> {
          requests.push(structuredClone(request));
          yield { type: 'finish', reason: 'stop' };
        },
      },
    }),
  });
  const finished = async (count: number): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const events = await store.read('s');
      if (events.filter((event) => event.type === 'execution.finished').length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Execution did not finish');
  };
  const close = async () => {
    await service.drain();
    await store.close();
  };
  return { store, service, requests, finished, close };
}

const textOf = (message: Message | undefined): string =>
  (message?.content ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');

describe('workspace context admission', () => {
  it('freezes captured contexts at acceptance and renders them as untrusted data to the model', async () => {
    const capture = vi.fn<CaptureContexts>(async () =>
      bundle({ 'git-changes': 'DIFF-BODY-v1' }, ['git-changes']),
    );
    const f = await fixture({ captureContexts: capture });
    try {
      const receipt = await f.service.launch('s', {
        requestId: 'r1',
        input: withContexts([{ kind: 'git-changes' }]),
      });
      await f.finished(1);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0]?.[1]).toEqual([{ kind: 'git-changes' }]);
      // Summaries only: the captured text never leaves the Session event.
      expect(receipt.contextAttachments).toEqual([
        {
          kind: 'git-changes',
          capturedAt: '2026-11-24T10:00:00.000Z',
          byteLength: Buffer.byteLength('DIFF-BODY-v1'),
          truncated: false,
        },
      ]);
      expect(JSON.stringify(receipt)).not.toContain('DIFF-BODY-v1');
      expect(JSON.stringify(await f.service.queue('s'))).not.toContain('DIFF-BODY-v1');
      const events = await f.store.read('s');
      const acceptedEvents = events.filter((event) => event.type === 'execution.accepted');
      expect(acceptedEvents).toHaveLength(1);
      expect(acceptedEvents[0]?.payload.workspaceContext?.snapshots[0]?.content).toBe(
        'DIFF-BODY-v1',
      );
      expect(JSON.stringify(events).split('DIFF-BODY-v1')).toHaveLength(2);
      const sent = f.requests[0]!.messages.at(-1)!;
      expect(textOf(sent)).toContain('Review my change');
      expect(textOf(sent)).toContain('untrusted data');
      expect(textOf(sent)).toContain('DIFF-BODY-v1');
      expect(textOf(sent)).toContain('"capturedAt":"2026-11-24T10:00:00.000Z"');
      expect(textOf(sent)).not.toContain('projectId');
      expect(projectSession(events).messages[0]?.fileAttachments).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it('replays the frozen content in later turns even when the workspace changed', async () => {
    const capture = vi.fn<CaptureContexts>(async () =>
      bundle({ 'git-changes': 'FROZEN-DIFF' }, ['git-changes']),
    );
    const f = await fixture({ captureContexts: capture });
    try {
      await f.service.launch('s', {
        requestId: 'first',
        input: withContexts([{ kind: 'git-changes' }]),
      });
      await f.finished(1);
      capture.mockImplementation(async () =>
        bundle({ 'git-changes': 'LATER-DIFF' }, ['git-changes']),
      );
      await f.service.launch('s', { requestId: 'second', input: baseInput });
      await f.finished(2);
      expect(capture).toHaveBeenCalledTimes(1);
      const secondRequest = f.requests[1]!.messages;
      const joined = secondRequest.map(textOf).join('\n');
      expect(joined).toContain('FROZEN-DIFF');
      expect(joined).not.toContain('LATER-DIFF');
      const events = await f.store.read('s');
      expect([...projectMessageWorkspaceContexts(events).values()]).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('does not change prompts or events for executions without contexts', async () => {
    const f = await fixture({});
    try {
      await f.service.launch('s', { requestId: 'plain', input: baseInput });
      await f.finished(1);
      const accepted = (await f.store.read('s')).find(
        (event) => event.type === 'execution.accepted',
      );
      expect(accepted?.payload).not.toHaveProperty('workspaceContext');
      expect(accepted?.payload.input).not.toHaveProperty('contexts');
      expect(f.requests[0]!.messages.map(textOf).join('\n')).not.toContain('untrusted');
    } finally {
      await f.close();
    }
  });

  it('captures once per request id and replays the receipt without re-capturing', async () => {
    const capture = vi.fn<CaptureContexts>(async () => bundle({}, ['git-changes']));
    const f = await fixture({ captureContexts: capture });
    try {
      const launch = { requestId: 'same', input: withContexts([{ kind: 'git-changes' }]) };
      const first = await f.service.launch('s', launch);
      capture.mockImplementation(async () => {
        throw new Error('workspace changed');
      });
      const replay = await f.service.launch('s', structuredClone(launch));
      expect(replay.executionId).toBe(first.executionId);
      expect(capture).toHaveBeenCalledTimes(1);
      await expect(
        f.service.launch('s', {
          ...launch,
          input: withContexts([{ kind: 'project-tree' }]),
        }),
      ).rejects.toMatchObject({ code: 'execution-request-conflict' });
      expect(capture).toHaveBeenCalledTimes(1);
      await f.finished(1);
      expect(
        (await f.store.read('s')).filter((event) => event.type === 'execution.accepted'),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('captures both kinds in request order and keeps queued entries free of content', async () => {
    const capture = vi.fn<CaptureContexts>(async (_session, contexts) =>
      bundle(
        { 'git-changes': 'DIFF', 'project-tree': 'a.ts\nb.ts' },
        contexts.map(({ kind }) => kind),
      ),
    );
    const f = await fixture({ captureContexts: capture });
    try {
      const receipt = await f.service.launch('s', {
        requestId: 'both',
        input: withContexts([{ kind: 'project-tree' }, { kind: 'git-changes' }]),
      });
      expect(receipt.contextAttachments?.map(({ kind }) => kind)).toEqual([
        'project-tree',
        'git-changes',
      ]);
      await f.finished(1);
      const rendered = textOf(f.requests[0]!.messages.at(-1));
      expect(rendered.indexOf('project-tree')).toBeLessThan(rendered.indexOf('git-changes'));
    } finally {
      await f.close();
    }
  });

  it('captures files and contexts together under one acceptance', async () => {
    const content = 'file-body';
    const captureFiles = vi.fn<CaptureFiles>(async () => ({
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
    }));
    const captureContexts = vi.fn<CaptureContexts>(async () => bundle({}, ['project-tree']));
    const f = await fixture({ captureContexts, captureFiles });
    try {
      const receipt = await f.service.launch('s', {
        requestId: 'together',
        input: { ...withContexts([{ kind: 'project-tree' }]), files: [{ path: 'a.txt' }] },
      });
      expect(receipt.fileAttachments).toHaveLength(1);
      expect(receipt.contextAttachments).toHaveLength(1);
      await f.finished(1);
      const text = textOf(f.requests[0]!.messages.at(-1));
      expect(text).toContain('file-body');
      expect(text).toContain('project-tree-body');
    } finally {
      await f.close();
    }
  });

  it('refuses atomically when capture is absent, typed, invalid or mismatched', async () => {
    const cases: readonly [CaptureContexts | undefined, string][] = [
      [undefined, 'execution-context-unavailable'],
      [
        async () => {
          throw new AgentExecutionError(
            'execution-context-git-unavailable',
            'Git changes need a Git repository with at least one commit',
          );
        },
        'execution-context-git-unavailable',
      ],
      [
        async () => {
          throw new Error('/private/root/raw-error');
        },
        'execution-context-capture-failed',
      ],
      [async () => ({ ...bundle({}), snapshots: [] }), 'execution-context-capture-failed'],
      [async () => bundle({}, ['project-tree']), 'execution-context-capture-failed'],
    ];
    for (const [capture, code] of cases) {
      const f = await fixture(capture === undefined ? {} : { captureContexts: capture });
      try {
        await expect(
          f.service.launch('s', {
            requestId: 'refused',
            input: withContexts([{ kind: 'git-changes' }]),
          }),
        ).rejects.toMatchObject({ code });
        expect(await f.store.read('s')).toHaveLength(1);
        expect((await f.service.queue('s')).active).toBeNull();
      } finally {
        await f.close();
      }
    }
  });

  it('does not leak raw capture errors into the typed rejection', async () => {
    const f = await fixture({
      captureContexts: async () => {
        throw new Error('/private/root/raw-error');
      },
    });
    try {
      const error = await f.service
        .launch('s', { requestId: 'raw', input: withContexts([{ kind: 'git-changes' }]) })
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(AgentExecutionError);
      expect(String((error as Error).message)).not.toContain('/private');
    } finally {
      await f.close();
    }
  });

  it('shares the 5 second acceptance deadline and appends nothing after it', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Deadline', 'TimeoutError')),
        milliseconds,
      );
      return controller.signal;
    });
    let observed: AbortSignal | undefined;
    const f = await fixture({
      captureContexts: async (_session, _contexts, { signal }) => {
        observed = signal;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        return bundle({}, ['git-changes']);
      },
    });
    try {
      const pending = f.service.launch('s', {
        requestId: 'deadline',
        input: withContexts([{ kind: 'git-changes' }]),
      });
      const checked = expect(pending).rejects.toMatchObject({
        code: 'execution-file-capture-timeout',
      });
      await vi.advanceTimersByTimeAsync(5001);
      await checked;
      expect(observed?.aborted).toBe(true);
      expect(timeout).toHaveBeenCalledWith(5000);
      expect(await f.store.read('s')).toHaveLength(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      await f.close();
    }
  });

  it('keeps one deadline across file and context capture', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = await fixture({
      captureFiles: async () => {
        throw new AgentExecutionError('execution-file-too-large', 'too large');
      },
      captureContexts: async () => bundle({}, ['git-changes']),
    });
    try {
      await expect(
        f.service.launch('s', {
          requestId: 'one-deadline',
          input: { ...withContexts([{ kind: 'git-changes' }]), files: [{ path: 'a.txt' }] },
        }),
      ).rejects.toMatchObject({ code: 'execution-file-too-large' });
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      vi.useRealTimers();
      await f.close();
    }
  });

  it('rejects the runner when its request names contexts that were not accepted', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('s', [{ type: 'session.created', payload: {} }]);
    const runner = createAgentRunner({
      sessionStore: store,
      llm: {
        // eslint-disable-next-line @typescript-eslint/require-await
        async *stream(): AsyncIterable<StreamEvent> {
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const events: unknown[] = [];
    let failure: unknown;
    try {
      for await (const event of runner.run({
        ...baseInput,
        sessionId: 's',
        contexts: [{ kind: 'git-changes' }],
      }))
        events.push(event);
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'agent-invalid-input' });
    expect(await store.read('s')).toHaveLength(1);
  });
});
