import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  capturedFileContextSchema,
  createInMemorySessionEventStore,
  createSessionProjectionCache,
  fileAttachmentSummaries,
  newSessionEventSchema,
  projectAgentExecutionQueue,
  projectMessageFileContexts,
  projectSession,
  type CapturedFileContext,
  type NewSessionEvent,
} from '../src/index.js';
import { applyEvent, createProjectionState } from '../src/projection.js';

const input = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
} as const;

function capture(
  contents: readonly string[] = ['\uFEFF中文\r\nunique-captured-body'],
): CapturedFileContext {
  return {
    version: 1,
    projectId: 'project',
    rootIdentity: 'a'.repeat(64),
    files: contents.map((content, n) => ({
      path: `${n}.txt`,
      encoding: 'utf-8',
      byteLength: Buffer.byteLength(content, 'utf8'),
      sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
      content,
      fileIdentity: String(n + 1).repeat(64),
    })),
  };
}

function accepted(
  id = 'a',
  context = capture(),
): Extract<NewSessionEvent, { type: 'execution.accepted' }> {
  const logical = { ...input, files: context.files.map(({ path }) => ({ path })) };
  return {
    type: 'execution.accepted',
    payload: {
      executionId: id,
      requestId: id,
      requestDigest: 'b'.repeat(64),
      turnId: `turn-${id}`,
      userMessageId: `user-${id}`,
      dispatch: 'queued',
      input: logical,
      runInput: { ...logical, useProviderDefaults: false },
      fileContext: context,
    },
  };
}

const claim = (id = 'a'): NewSessionEvent => ({
  type: 'execution.claimed',
  payload: { executionId: id },
});
const message = (id = 'a'): NewSessionEvent => ({
  type: 'message.created',
  payload: { messageId: `user-${id}`, message: input.userMessage },
});
const start = (id = 'a'): Extract<NewSessionEvent, { type: 'turn.started' }> => ({
  type: 'turn.started',
  payload: { executionId: id, turnId: `turn-${id}`, userMessageId: `user-${id}` },
});

async function events(batch: readonly NewSessionEvent[]) {
  const store = createInMemorySessionEventStore();
  await store.append('s', [{ type: 'session.created', payload: {} }, ...batch]);
  return store.read('s');
}

describe('captured file context integrity', () => {
  it('preserves exact UTF-8 BOM/CRLF/multibyte and empty files, deriving only summaries', () => {
    const context = capture(['\uFEFF中文\r\n', '']);
    expect(capturedFileContextSchema.parse(context)).toEqual(context);
    expect(fileAttachmentSummaries(context)).toEqual([
      {
        path: '0.txt',
        encoding: 'utf-8',
        byteLength: 11,
        sha256: '2f51beb0b0be0225423bb9183353bf369006feb16a567619fa541b51c2e71a96',
      },
      {
        path: '1.txt',
        encoding: 'utf-8',
        byteLength: 0,
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    ]);
  });

  it('enforces actual per-file and aggregate byte limits, not JS string length', () => {
    expect(capturedFileContextSchema.safeParse(capture(['a'.repeat(65_536)])).success).toBe(true);
    expect(capturedFileContextSchema.safeParse(capture(['中'.repeat(21_846)])).success).toBe(false);
    expect(
      capturedFileContextSchema.safeParse(capture(Array(4).fill('a'.repeat(65_536)))).success,
    ).toBe(true);
    expect(
      capturedFileContextSchema.safeParse(
        capture([...Array<string>(4).fill('a'.repeat(65_536)), 'a']),
      ).success,
    ).toBe(false);
    expect(capturedFileContextSchema.safeParse(capture(Array<string>(8).fill(''))).success).toBe(
      true,
    );
    expect(capturedFileContextSchema.safeParse(capture(Array<string>(9).fill(''))).success).toBe(
      false,
    );
    expect(capturedFileContextSchema.safeParse(capture([])).success).toBe(false);
  });

  it('rejects false sizes, hashes, non-text content, authority and extra fields', () => {
    const context = capture();
    const file = context.files[0]!;
    for (const changed of [
      { ...file, byteLength: file.byteLength - 1 },
      { ...file, sha256: 'c'.repeat(64) },
      { ...file, encoding: 'utf8' },
      { ...file, fileIdentity: 'invalid' },
      { ...file, extra: true },
    ])
      expect(capturedFileContextSchema.safeParse({ ...context, files: [changed] }).success).toBe(
        false,
      );
    for (const content of ['a\0b', '\ud800', '\udc00']) {
      expect(capturedFileContextSchema.safeParse(capture([content])).success).toBe(false);
    }
    for (const changed of [
      { ...context, extra: true },
      { ...context, rootIdentity: 'invalid' },
      { ...context, projectId: '' },
      { ...context, version: 2 },
    ]) {
      expect(capturedFileContextSchema.safeParse(changed).success).toBe(false);
    }
    expect(capturedFileContextSchema.safeParse({ ...context, files: [file, file] }).success).toBe(
      false,
    );
    expect(
      capturedFileContextSchema.safeParse({
        ...context,
        files: [file, { ...file, path: 'alias.txt' }],
      }).success,
    ).toBe(false);
  });
});

describe('file-bearing accepted input', () => {
  it('accepts legacy no-file facts and new queued captured facts', () => {
    expect(
      newSessionEventSchema.safeParse({
        type: 'execution.accepted',
        payload: {
          executionId: 'old',
          requestId: 'old',
          requestDigest: 'a'.repeat(64),
          turnId: 'old-turn',
          userMessageId: 'old-user',
          input,
        },
      }).success,
    ).toBe(true);
    expect(newSessionEventSchema.safeParse(accepted()).success).toBe(true);
  });

  it('requires capture, immutable effective input and queued dispatch for every nonempty ref batch', () => {
    const event = accepted('a', capture(['a', 'b']));
    const {
      fileContext: _context,
      dispatch: _dispatch,
      runInput: _runInput,
      ...rest
    } = event.payload;
    void _context;
    void _dispatch;
    void _runInput;
    const variants = [
      { ...rest, dispatch: 'queued', runInput: event.payload.runInput },
      { ...rest, fileContext: event.payload.fileContext, runInput: event.payload.runInput },
      { ...rest, dispatch: 'queued', fileContext: event.payload.fileContext },
      { ...event.payload, input: { ...input } },
      { ...event.payload, input: { ...input, files: [] } },
      {
        ...event.payload,
        input: { ...event.payload.input, files: [{ path: '1.txt' }, { path: '0.txt' }] },
      },
      { ...event.payload, input: { ...event.payload.input, files: [{ path: '0.txt' }] } },
      { ...event.payload, runInput: { ...event.payload.runInput, files: [{ path: 'different' }] } },
      { ...event.payload, runInput: { ...event.payload.runInput, useProviderDefaults: true } },
      { ...event.payload, runInput: { ...event.payload.runInput, model: 'changed' } },
      { ...rest, input, runInput: event.payload.runInput },
      { ...event.payload, content: 'forged' },
    ];
    for (const payload of variants)
      expect(newSessionEventSchema.safeParse({ type: event.type, payload }).success).toBe(false);
  });
});

describe('captured message projections', () => {
  it('binds summaries and body only after the exact claimed Turn begins', async () => {
    const context = capture();
    const waiting = await events([accepted('a', context)]);
    expect(projectAgentExecutionQueue(waiting).queued[0]?.fileCount).toBe(1);
    const pending = await events([accepted('a', context), claim()]);
    expect(projectSession(pending).messages).toEqual([]);
    expect(projectMessageFileContexts(pending).size).toBe(0);
    const begun = await events([accepted('a', context), claim(), message(), start()]);
    expect(projectSession(begun).messages[0]).toMatchObject({
      messageId: 'user-a',
      turnId: 'turn-a',
      fileAttachments: fileAttachmentSummaries(context),
    });
    expect(projectMessageFileContexts(begun)).toEqual(new Map([['user-a', context]]));
    const metadata = JSON.stringify(projectAgentExecutionQueue(pending));
    expect(JSON.parse(metadata).queued).toEqual([]);
    expect(JSON.parse(metadata).active.fileCount).toBe(1);
    for (const privateValue of [
      'unique-captured-body',
      'fileContext',
      'rootIdentity',
      'fileIdentity',
      'a'.repeat(64),
      '1'.repeat(64),
    ]) {
      expect(metadata).not.toContain(privateValue);
      expect(JSON.stringify(projectSession(begun))).not.toContain(privateValue);
    }
  });

  it('keeps incremental/full projection equal and pending state free of body through cancel/start', async () => {
    const store = createInMemorySessionEventStore();
    const cache = createSessionProjectionCache(store);
    const batches: readonly (readonly NewSessionEvent[])[] = [
      [{ type: 'session.created', payload: {} }, accepted(), accepted('b')],
      [claim()],
      [message(), start()],
      [
        {
          type: 'execution.finished',
          payload: { executionId: 'b', status: 'cancelled', reason: 'queue-cancelled' },
        },
      ],
    ];
    for (const batch of batches) {
      await store.append('s', batch);
      const log = await store.read('s');
      expect(await cache.project('s')).toEqual(projectSession(log));
      const state = createProjectionState();
      for (const event of log) applyEvent(state, event);
      expect(
        JSON.stringify(state, (_key, value: unknown) =>
          value instanceof Map ? [...value] : value,
        ),
      ).not.toContain('unique-captured-body');
    }
    expect(projectMessageFileContexts(await store.read('s')).size).toBe(1);
    const state = createProjectionState();
    for (const event of await store.read('s')) applyEvent(state, event);
    expect(state.fileContexts.pending.size).toBe(0);
  });

  it('never returns cancelled queued snapshots as model history', async () => {
    const log = await events([
      accepted(),
      { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
    ]);
    expect(projectSession(log).messages).toEqual([]);
    expect(projectMessageFileContexts(log).size).toBe(0);
  });

  it.each([
    { executionId: 'wrong' },
    { turnId: 'wrong' },
    { userMessageId: 'user-b' },
    { executionId: undefined },
    { userMessageId: undefined },
  ])('rejects a mismatched captured Turn binding %j', async (changed) => {
    const started = start();
    const log = await events([
      accepted(),
      claim(),
      message(),
      message('b'),
      { ...started, payload: { ...started.payload, ...changed } },
    ]);
    expect(() => projectSession(log)).toThrow();
    expect(() => projectMessageFileContexts(log)).toThrow();
  });

  it('rejects unclaimed, cancelled, duplicate-owner and changed-message bindings', async () => {
    const first = accepted();
    const second = accepted('b');
    const cases: readonly (readonly NewSessionEvent[])[] = [
      [first, message(), start()],
      [
        first,
        { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
        message(),
        start(),
      ],
      [first, { ...second, payload: { ...second.payload, turnId: 'turn-a' } }],
      [first, { ...second, payload: { ...second.payload, userMessageId: 'user-a' } }],
      [first, { ...second, payload: { ...second.payload, executionId: 'a' } }],
      [message(), first],
      [
        message(),
        { type: 'turn.started', payload: { turnId: 'turn-a', userMessageId: 'user-a' } },
        first,
      ],
      [
        first,
        claim(),
        {
          type: 'message.created',
          payload: {
            messageId: 'user-a',
            message: { role: 'user', content: [{ type: 'text', text: 'changed' }] },
          },
        },
        start(),
      ],
    ];
    for (const batch of cases) {
      const log = await events(batch);
      expect(() => projectSession(log)).toThrow();
      expect(() => projectMessageFileContexts(log)).toThrow();
    }
  });
});
