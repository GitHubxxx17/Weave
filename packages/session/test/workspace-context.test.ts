import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  capturedWorkspaceContextSchema,
  createInMemorySessionEventStore,
  newSessionEventSchema,
  projectAgentExecutionQueue,
  projectMessageWorkspaceContexts,
  projectSession,
  workspaceContextSummaries,
  type CapturedWorkspaceContext,
  type NewSessionEvent,
} from '../src/index.js';

const input = {
  userMessage: { role: 'user', content: [{ type: 'text', text: 'inspect' }] },
  provider: 'mock',
  model: 'test',
  permissionMode: 'ask',
} as const;

type Kind = 'git-changes' | 'project-tree';
function snapshot(kind: Kind, content: string): CapturedWorkspaceContext['snapshots'][number] {
  const common = {
    capturedAt: '2026-11-24T10:00:00.000Z',
    content,
    byteLength: Buffer.byteLength(content, 'utf8'),
    truncated: false,
    sha256: createHash('sha256').update(content, 'utf8').digest('hex'),
  };
  return kind === 'git-changes' ? { kind, ...common } : { kind, ...common, entryCount: 1 };
}
function capture(
  kinds: readonly Kind[] = ['git-changes'],
  content = '中文 unique-context-body\r\n',
): CapturedWorkspaceContext {
  return {
    version: 1,
    projectId: 'project',
    snapshots: kinds.map((kind) => snapshot(kind, content)),
  };
}

function accepted(
  id = 'a',
  context = capture(),
): Extract<NewSessionEvent, { type: 'execution.accepted' }> {
  const logical = { ...input, contexts: context.snapshots.map(({ kind }) => ({ kind })) };
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
      workspaceContext: context,
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

describe('captured workspace context integrity', () => {
  it('preserves exact text and derives only safe summaries', () => {
    const context = capture(['git-changes', 'project-tree']);
    expect(capturedWorkspaceContextSchema.parse(context)).toEqual(context);
    expect(workspaceContextSummaries(context)).toEqual([
      {
        kind: 'git-changes',
        capturedAt: '2026-11-24T10:00:00.000Z',
        byteLength: Buffer.byteLength('中文 unique-context-body\r\n'),
        truncated: false,
      },
      {
        kind: 'project-tree',
        capturedAt: '2026-11-24T10:00:00.000Z',
        byteLength: Buffer.byteLength('中文 unique-context-body\r\n'),
        truncated: false,
      },
    ]);
    expect(JSON.stringify(workspaceContextSummaries(context))).not.toContain('unique-context');
  });

  it('enforces byte limits per kind, not JS string length', () => {
    const ok = (kind: Kind, content: string) =>
      capturedWorkspaceContextSchema.safeParse(capture([kind], content)).success;
    expect(ok('git-changes', 'a'.repeat(131_072))).toBe(true);
    expect(ok('git-changes', 'a'.repeat(131_073))).toBe(false);
    expect(ok('git-changes', '中'.repeat(43_691))).toBe(false);
    expect(ok('project-tree', 'a'.repeat(65_536))).toBe(true);
    expect(ok('project-tree', 'a'.repeat(65_537))).toBe(false);
    const tree = snapshot('project-tree', 'a');
    expect(
      capturedWorkspaceContextSchema.safeParse({
        ...capture(),
        snapshots: [{ ...tree, entryCount: 2001 }],
      }).success,
    ).toBe(false);
  });

  it('rejects false sizes, hashes, NUL, duplicates, empty batches and extra fields', () => {
    const context = capture();
    const [first] = context.snapshots;
    for (const changed of [
      { ...first!, byteLength: first!.byteLength - 1 },
      { ...first!, sha256: 'c'.repeat(64) },
      { ...first!, capturedAt: 'yesterday' },
      { ...first!, extra: true },
      snapshot('git-changes', 'a\0b'),
    ])
      expect(
        capturedWorkspaceContextSchema.safeParse({ ...context, snapshots: [changed] }).success,
      ).toBe(false);
    for (const changed of [
      { ...context, snapshots: [] },
      { ...context, snapshots: [first, first] },
      { ...context, extra: true },
      { ...context, projectId: '' },
      { ...context, version: 2 },
    ])
      expect(capturedWorkspaceContextSchema.safeParse(changed).success).toBe(false);
  });
});

describe('context-bearing accepted input', () => {
  it('accepts legacy facts and new queued captured facts', () => {
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
    expect(
      newSessionEventSchema.safeParse(accepted('b', capture(['project-tree', 'git-changes'])))
        .success,
    ).toBe(true);
  });

  it('requires a matching capture, effective input and queued dispatch for every context list', () => {
    const event = accepted('a', capture(['git-changes', 'project-tree']));
    const {
      workspaceContext: _context,
      dispatch: _dispatch,
      runInput: _run,
      ...rest
    } = event.payload;
    void _context;
    void _dispatch;
    void _run;
    const variants = [
      { ...rest, dispatch: 'queued', runInput: event.payload.runInput },
      {
        ...rest,
        workspaceContext: event.payload.workspaceContext,
        runInput: event.payload.runInput,
      },
      { ...rest, dispatch: 'queued', workspaceContext: event.payload.workspaceContext },
      { ...event.payload, input: { ...input } },
      // kinds must match the capture exactly, in order, with no extras
      {
        ...event.payload,
        input: {
          ...event.payload.input,
          contexts: [{ kind: 'project-tree' }, { kind: 'git-changes' }],
        },
      },
      { ...event.payload, input: { ...event.payload.input, contexts: [{ kind: 'git-changes' }] } },
      {
        ...event.payload,
        runInput: { ...event.payload.runInput, contexts: [{ kind: 'git-changes' }] },
      },
      { ...event.payload, runInput: { ...event.payload.runInput, useProviderDefaults: true } },
      // a capture without a request is forged state
      {
        ...rest,
        input,
        runInput: { ...input, useProviderDefaults: false },
        dispatch: 'queued',
        workspaceContext: capture(),
      },
      { ...event.payload, content: 'forged' },
    ];
    for (const payload of variants)
      expect(newSessionEventSchema.safeParse({ type: event.type, payload }).success).toBe(false);
  });

  it('rejects duplicate kinds in the logical request', () => {
    const event = accepted();
    const contexts = [{ kind: 'git-changes' }, { kind: 'git-changes' }];
    expect(
      newSessionEventSchema.safeParse({
        type: event.type,
        payload: {
          ...event.payload,
          input: { ...event.payload.input, contexts },
          runInput: { ...event.payload.runInput, contexts },
        },
      }).success,
    ).toBe(false);
  });
});

describe('workspace context projections', () => {
  it('binds the body only after the exact claimed Turn begins and adds no file summaries', async () => {
    const context = capture();
    const waiting = await events([accepted('a', context)]);
    expect(projectMessageWorkspaceContexts(waiting).size).toBe(0);
    const pending = await events([accepted('a', context), claim()]);
    expect(projectMessageWorkspaceContexts(pending).size).toBe(0);
    const begun = await events([accepted('a', context), claim(), message(), start()]);
    const message0 = projectSession(begun).messages[0]!;
    expect(message0).toMatchObject({ messageId: 'user-a', turnId: 'turn-a' });
    expect(message0.fileAttachments).toBeUndefined();
    expect(projectMessageWorkspaceContexts(begun)).toEqual(new Map([['user-a', context]]));
    const metadata = JSON.stringify(projectAgentExecutionQueue(pending));
    expect(metadata).not.toContain('unique-context-body');
    expect(metadata).not.toContain('workspaceContext');
    expect(JSON.stringify(projectSession(begun))).not.toContain('unique-context-body');
  });

  it('never returns cancelled queued snapshots as model history', async () => {
    const log = await events([
      accepted(),
      { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
    ]);
    expect(projectSession(log).messages).toEqual([]);
    expect(projectMessageWorkspaceContexts(log).size).toBe(0);
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
    expect(() => projectMessageWorkspaceContexts(log)).toThrow();
  });

  it('rejects unclaimed, cancelled and changed-message bindings', async () => {
    const first = accepted();
    const cases: readonly (readonly NewSessionEvent[])[] = [
      [first, message(), start()],
      [
        first,
        { type: 'execution.finished', payload: { executionId: 'a', status: 'cancelled' } },
        message(),
        start(),
      ],
      [message(), first],
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
    }
  });
});
