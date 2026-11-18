import { createInMemorySessionEventStore, type NewSessionEvent } from '@weave/session';
import { describe, expect, it } from 'vitest';
import {
  createRecallTool,
  createSessionRecallResolver,
  type RecallToolResult,
} from '../src/index.js';

const context = { signal: new AbortController().signal, sessionId: 'session-1' };

const sample: readonly RecallToolResult[] = [
  {
    toolCallId: 'c1',
    name: 'read_file',
    content: 'OLD content',
    truncated: false,
    status: 'completed',
    path: 'a.ts',
    order: 0,
  },
  {
    toolCallId: 'c2',
    name: 'read_file',
    content: 'NEW content',
    truncated: false,
    status: 'completed',
    path: 'a.ts',
    order: 1,
  },
  {
    toolCallId: 'c3',
    name: 'grep',
    content: 'grep result',
    truncated: false,
    status: 'completed',
    order: 2,
  },
];

describe('createRecallTool', () => {
  const tool = createRecallTool({ resolve: () => sample });

  it('is a read-only tool without an approval gate', () => {
    expect(tool.name).toBe('recall');
    expect(tool.approval).toBeUndefined();
  });

  it('returns the full content of a result addressed by tool-call id', async () => {
    const output = await tool.execute({ toolCallId: 'c1' }, context);
    expect(output).toBe('OLD content');
  });

  it('returns the most recent result when addressed by path', async () => {
    const output = await tool.execute({ path: 'a.ts' }, context);
    expect(output).toBe('NEW content');
  });

  it('reports when neither toolCallId nor path is provided', async () => {
    const output = await tool.execute({}, context);
    expect(output).toContain('toolCallId');
    expect(output).toContain('path');
  });

  it('reports a missing tool-call id', async () => {
    const output = await tool.execute({ toolCallId: 'absent' }, context);
    expect(output).toContain('未找到');
  });

  it('reports a path that was never read', async () => {
    const output = await tool.execute({ path: 'never.ts' }, context);
    expect(output).toContain('未找到');
  });

  it('is unavailable without a Session context', async () => {
    const output = await tool.execute(
      { toolCallId: 'c1' },
      { signal: new AbortController().signal },
    );
    expect(output).toContain('会话');
  });
});

describe('createSessionRecallResolver', () => {
  const turnEvents: readonly NewSessionEvent[] = [
    { type: 'session.created', payload: {} },
    {
      type: 'message.created',
      payload: {
        messageId: 'm1',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      },
    },
    { type: 'turn.started', payload: { turnId: 't1' } },
    {
      type: 'step.started',
      payload: { turnId: 't1', stepId: 's1', kind: 'model', provider: 'mock', model: 'm' },
    },
    {
      type: 'message.created',
      payload: {
        messageId: 'm2',
        message: {
          role: 'assistant',
          content: [],
          toolCalls: [{ id: 'tc1', name: 'read_file', arguments: '{"path":"README.md"}' }],
        },
      },
    },
    { type: 'step.completed', payload: { turnId: 't1', stepId: 's1', status: 'completed' } },
    { type: 'step.started', payload: { turnId: 't1', stepId: 's2', kind: 'tool' } },
    {
      type: 'tool-call.created',
      payload: {
        turnId: 't1',
        stepId: 's2',
        toolCall: { id: 'tc1', name: 'read_file', arguments: '{"path":"README.md"}' },
      },
    },
    {
      type: 'tool-result.created',
      payload: {
        turnId: 't1',
        stepId: 's2',
        toolCallId: 'tc1',
        name: 'read_file',
        content: 'file body',
        truncated: false,
        status: 'completed',
      },
    },
    {
      type: 'message.created',
      payload: {
        messageId: 'm3',
        message: {
          role: 'tool',
          toolCallId: 'tc1',
          content: [{ type: 'text', text: 'file body' }],
        },
      },
    },
    { type: 'step.completed', payload: { turnId: 't1', stepId: 's2', status: 'completed' } },
    { type: 'turn.completed', payload: { turnId: 't1', status: 'completed' } },
  ];

  it('projects durable tool results with their originating path', async () => {
    const store = createInMemorySessionEventStore();
    await store.append('session-1', turnEvents);
    const resolve = createSessionRecallResolver(store);

    const results = await resolve('session-1');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolCallId: 'tc1',
      name: 'read_file',
      content: 'file body',
      status: 'completed',
      path: 'README.md',
    });
  });

  it('returns nothing for an unknown Session', async () => {
    const store = createInMemorySessionEventStore();
    const resolve = createSessionRecallResolver(store);
    expect(await resolve('missing')).toEqual([]);
  });
});
