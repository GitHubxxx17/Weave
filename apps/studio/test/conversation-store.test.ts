import { describe, expect, it } from 'vitest';
import { createConversationStore } from '../src/features/conversation/conversation-store.js';
import {
  conversationRows,
  conversationTurns,
  getConversationRow,
  getConversationRetry,
} from '../src/features/conversation/conversation-model.js';
import type { AgentExecutionSnapshot } from '../src/features/agent/agent-execution-types.js';
import type { LiveOwner } from '../src/features/conversation/conversation-types.js';
import type { SessionDetail } from '../src/features/workspace/workspace-types.js';
const at = '2026-11-24T00:00:00.000Z';
const owner = (id = 'e', epoch = 1): LiveOwner => ({
  sessionId: 's',
  executionId: id,
  turnId: `t-${id}`,
  userMessageId: `u-${id}`,
  runId: `r-${id}`,
  epoch,
});
const execution = (id = 'e'): AgentExecutionSnapshot => ({
  executionId: id,
  requestId: `r-${id}`,
  sessionId: 's',
  turnId: `t-${id}`,
  userMessageId: `u-${id}`,
  createdAt: at,
  status: 'running',
  cursor: `epoch:${id}:0`,
  input: {
    provider: 'p',
    model: 'm',
    permissionMode: 'ask',
    userMessage: { role: 'user', content: [{ type: 'text', text: id }] },
  },
  events: [],
});
function detail(sequence: number, ids: string[]): SessionDetail {
  return {
    id: 's',
    title: 's',
    lastSequence: sequence,
    messages: ids.flatMap((id) => [
      {
        role: 'user' as const,
        messageId: `u-${id}`,
        turnId: `t-${id}`,
        content: [{ type: 'text' as const, text: id }],
      },
      {
        role: 'assistant' as const,
        messageId: `a-${id}`,
        turnId: `t-${id}`,
        content: [{ type: 'text' as const, text: `durable ${id}` }],
      },
    ]),
    turns: ids.map((id) => ({
      turnId: `t-${id}`,
      userMessageId: `u-${id}`,
      status: 'completed' as const,
      startedAt: at,
      modelSteps: [],
      toolResults: [],
      toolCalls: 0,
      failedToolCalls: 0,
    })),
  };
}
function harness() {
  let n = 0;
  const callbacks = new Map<number, () => void>();
  const cancelled: (() => void)[] = [];
  const timers = new Map<number, () => void>();
  const store = createConversationStore({
    scheduleFrame: (callback: () => void) => {
      callbacks.set(++n, callback);
      return n;
    },
    cancelFrame: (id: number) => {
      const callback = callbacks.get(id);
      if (callback) cancelled.push(callback);
      callbacks.delete(id);
    },
    scheduleTimeout: (callback: () => void) => {
      timers.set(++n, callback);
      return n;
    },
    cancelTimeout: (id: number) => {
      timers.delete(id);
    },
    isHidden: () => false,
  });
  return {
    store,
    callbacks,
    cancelled,
    timers,
    run() {
      const todo = [...callbacks.values()];
      callbacks.clear();
      todo.forEach((callback) => callback());
    },
  };
}
describe('conversation store', () => {
  it('publishes one frame for all admitted events while preserving history indices and row order', () => {
    const h = harness();
    h.store.hydrate(detail(10, ['old']));
    h.store.replaceLive(owner(), execution());
    const before = h.store.getSnapshot('s');
    let publications = 0;
    h.store.subscribeSession('s', () => publications++);
    for (let i = 0; i < 100; i++)
      h.store.appendLive(owner(), { type: 'text-delta', text: String(i % 10) });
    expect(h.callbacks.size).toBe(1);
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('');
    h.run();
    const after = h.store.getSnapshot('s');
    expect(publications).toBe(1);
    expect(after.rowIds).toBe(before.rowIds);
    expect(after.rowsById).toBe(before.rowsById);
    expect(after.turnById).toBe(before.turnById);
    expect(getConversationRow(after, 't-e')?.text).toBe('0123456789'.repeat(10));
    expect(conversationTurns(after)).toBe(conversationTurns(before));
  });
  it('keeps multiple terminal overlays until exact durable confirmation and rejects stale base rollback', () => {
    const h = harness();
    h.store.replaceLive(owner('a'), execution('a'));
    h.store.appendLive(owner('a'), { type: 'text-delta', text: 'first' });
    h.store.updateLiveStatus(owner('a'), {
      cursor: 'epoch:a:9',
      status: 'completed',
      durableThroughSequence: 20,
    });
    h.store.replaceLive(owner('b'), execution('b'));
    h.store.appendLive(owner('b'), { type: 'text-delta', text: 'second' });
    h.store.flush(owner('b'));
    expect(conversationRows(h.store.getSnapshot('s')).map((row) => row.id)).toEqual([
      'u-a',
      't-a',
      'u-b',
      't-b',
    ]);
    h.store.updateLiveStatus(owner('b'), {
      cursor: 'epoch:b:9',
      status: 'completed',
      durableThroughSequence: 30,
    });
    expect(h.store.settle(owner('b'), detail(30, ['a', 'b']))).toEqual({
      confirmed: true,
      historyApplied: true,
    });
    expect(h.store.settle(owner('a'), detail(20, ['a']))).toEqual({
      confirmed: true,
      historyApplied: false,
    });
    expect(h.store.getSnapshot('s').durableSequence).toBe(30);
    expect(getConversationRow(h.store.getSnapshot('s'), 't-b')?.text).toBe('durable b');
    expect(h.store.getSnapshot('s').liveOverlays.size).toBe(0);
    h.cancelled.forEach((callback) => callback());
    expect(h.store.getSnapshot('s').liveOverlays.size).toBe(0);
  });
  it('retains the older overlay at its durable history position after the newer execution settles', () => {
    const h = harness();
    h.store.replaceLive(owner('a'), execution('a'));
    h.store.appendLive(owner('a'), { type: 'text-delta', text: 'first live' });
    h.store.updateLiveStatus(owner('a'), {
      cursor: 'epoch:a:9',
      status: 'completed',
      durableThroughSequence: 20,
    });
    h.store.replaceLive(owner('b'), execution('b'));
    h.store.updateLiveStatus(owner('b'), {
      cursor: 'epoch:b:9',
      status: 'completed',
      durableThroughSequence: 30,
    });
    h.store.settle(owner('b'), detail(30, ['a', 'b']));
    expect(conversationRows(h.store.getSnapshot('s')).map((row) => row.id)).toEqual([
      'u-a',
      't-a',
      'u-b',
      't-b',
    ]);
    expect(getConversationRow(h.store.getSnapshot('s'), 't-a')?.text).toBe('first live');
    expect(h.store.getSnapshot('s').latestAssistantId).toBe('t-b');
  });
  it('rebuilds from reconnect snapshots and prevents a delayed running snapshot replacing terminal output', () => {
    const h = harness();
    h.store.replaceLive(owner(), execution());
    h.store.appendLive(owner(), { type: 'text-delta', text: 'old' });
    const late = [...h.callbacks.values()];
    h.store.replaceLive(owner(), {
      ...execution(),
      cursor: 'epoch:e:10',
      events: [{ type: 'text-delta', text: 'reconnected' }],
    });
    late.forEach((callback) => callback());
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('reconnected');
    h.store.appendLive(owner(), { type: 'text-delta', text: ' complete' });
    h.store.updateLiveStatus(owner(), {
      cursor: 'epoch:e:12',
      status: 'completed',
      durableThroughSequence: 20,
    });
    h.store.replaceLive(owner(), {
      ...execution(),
      cursor: 'epoch:e:11',
      events: [{ type: 'text-delta', text: 'late running' }],
    });
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('reconnected complete');
  });
  it('publishes through the hidden-tab fallback and ignores its cancelled frame later', () => {
    const h = harness();
    h.store.replaceLive(owner(), execution());
    h.store.appendLive(owner(), { type: 'reasoning-delta', text: 'hidden progress' });
    const frames = [...h.callbacks.values()];
    [...h.timers.values()].forEach((callback) => callback());
    const published = h.store.getSnapshot('s');
    expect(getConversationRow(published, 't-e')?.reasoning).toBe('hidden progress');
    frames.forEach((callback) => callback());
    expect(h.store.getSnapshot('s')).toBe(published);
  });
  it('retains admitted output when terminal recovery resets its transport event log', () => {
    const h = harness();
    h.store.replaceLive(owner(), execution());
    h.store.appendLive(owner(), { type: 'text-delta', text: 'complete admitted output' });
    h.store.replaceLive(owner(), {
      ...execution(),
      status: 'completed',
      cursor: 'restart:e:0',
      events: [],
      durableThroughSequence: 20,
    });
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe(
      'complete admitted output',
    );
    expect(h.store.settle(owner(), detail(19, ['e'])).confirmed).toBe(false);
    expect(h.store.settle(owner(), detail(20, ['e'])).confirmed).toBe(true);
  });
  it('fences a detached observer but keeps its pending output until exact durable Turn readback', () => {
    const h = harness();
    h.store.replaceLive(owner(), execution());
    h.store.appendLive(owner(), { type: 'text-delta', text: 'pending detached' });
    h.store.detachLive(owner());
    h.store.appendLive(owner(), { type: 'text-delta', text: 'late' });
    h.cancelled.forEach((callback) => callback());
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('pending detached');
    h.store.replaceLive(owner(), {
      ...execution(),
      events: [{ type: 'text-delta', text: 'late replacement' }],
    });
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('pending detached');
    h.store.hydrate(detail(10, ['unrelated']));
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('pending detached');
    h.store.hydrate(detail(20, ['e']));
    expect(h.store.getSnapshot('s').liveOverlays.size).toBe(0);
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('durable e');
  });
  it('requires matching terminal Turn and watermark and keeps the exact captured retry request', () => {
    const h = harness();
    const input = {
      ...execution(),
      input: {
        ...execution().input,
        temperature: 0.2,
        maxTokens: 35,
        useProviderDefaults: false,
        reasoningEffort: 'high',
        files: [{ path: 'src/a.ts' }],
        userMessage: {
          role: 'user' as const,
          content: [
            { type: 'text' as const, text: 'exact question' },
            { type: 'image' as const, mediaType: 'image/png', data: 'abc' },
          ],
        },
      },
    };
    h.store.replaceLive(owner(), input);
    h.store.updateLiveStatus(owner(), {
      cursor: 'epoch:e:9',
      status: 'completed',
      durableThroughSequence: 20,
    });
    expect(getConversationRetry(h.store.getSnapshot('s'), 't-e')).toMatchObject({
      sessionId: 's',
      temperature: 0.2,
      maxTokens: 35,
      files: [{ path: 'src/a.ts' }],
      skills: [],
      userMessage: input.input.userMessage,
    });
    expect(h.store.settle(owner(), detail(19, ['e']))).toEqual({
      confirmed: false,
      historyApplied: false,
    });
    const foreign = detail(20, ['e']);
    foreign.turns[0]!.userMessageId = 'somebody-else';
    expect(h.store.settle(owner(), foreign)).toEqual({ confirmed: false, historyApplied: false });
    expect(h.store.settle(owner(), detail(20, ['e']))).toEqual({
      confirmed: true,
      historyApplied: true,
    });
    expect(h.store.getSnapshot('s').liveOverlays.size).toBe(0);
    expect(h.store.settle(owner(), detail(20, ['e']))).toEqual({
      confirmed: false,
      historyApplied: false,
    });
  });
  it('fences replace, terminal, removal, dispose and execution ABA against late callbacks', () => {
    const h = harness();
    h.store.replaceLive(owner(), execution());
    h.store.appendLive(owner(), { type: 'text-delta', text: 'obsolete' });
    const late = [...h.callbacks.values()];
    h.store.replaceLive(owner('e', 2), {
      ...execution(),
      events: [{ type: 'text-delta', text: 'fresh' }],
    });
    h.store.appendLive(owner(), { type: 'text-delta', text: 'wrong owner' });
    late.forEach((callback) => callback());
    expect(getConversationRow(h.store.getSnapshot('s'), 't-e')?.text).toBe('fresh');
    h.store.appendLive(owner('e', 2), { type: 'text-delta', text: ' final' });
    h.store.updateLiveStatus(owner('e', 2), {
      cursor: 'epoch:e:5',
      status: 'completed',
      durableThroughSequence: 10,
    });
    const terminal = h.store.getSnapshot('s');
    h.cancelled.forEach((callback) => callback());
    expect(h.store.getSnapshot('s')).toBe(terminal);
    expect(getConversationRow(terminal, 't-e')?.text).toBe('fresh final');
    h.store.removeSession('s');
    late.forEach((callback) => callback());
    expect(h.store.getSnapshot('s').rowIds).toEqual([]);
    h.store.dispose();
    h.store.appendLive(owner('e', 2), { type: 'text-delta', text: 'late' });
    expect(h.store.getSnapshot('s').rowIds).toEqual([]);
  });
  it('preserves loaded views, extra submission fields and monotonic watermarks without repeated notifications', () => {
    const h = harness();
    const messages = [
      {
        id: 'u',
        role: 'user' as const,
        text: 'q',
        reasoning: '',
        tools: [],
        occurredAt: at,
        turnId: 't',
        submission: {
          sessionId: 's',
          provider: 'p',
          model: 'm',
          skills: [],
          userMessage: {
            role: 'user' as const,
            content: [{ type: 'text' as const, text: 'exact' }],
          },
        },
      },
    ];
    const input = { sessionId: 's', messages, turns: [], detailKnown: true, durableSequence: 4 };
    h.store.hydrateView(input);
    const first = h.store.getSnapshot('s');
    expect(h.store.hydrateView(input)).toBe(false);
    expect(h.store.getSnapshot('s')).toBe(first);
    expect(
      h.store.hydrateView({
        sessionId: 's',
        messages: [],
        turns: [],
        detailKnown: false,
        durableSequence: 9,
      }),
    ).toBe(false);
    expect(h.store.getSnapshot('s')).toBe(first);
    expect(h.store.hydrate(detail(3, []))).toBe(false);
    expect(h.store.getSnapshot('s').durableSequence).toBe(4);
  });
});
