import type { Message, ToolCall, ToolDefinition } from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import { buildModelContext, type ContextBudget } from '../src/context/build-context.js';

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

function assistantCall(text: string, toolCalls: readonly ToolCall[]): Message {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    toolCalls,
  };
}

function toolResult(toolCallId: string, text: string): Message {
  return { role: 'tool', toolCallId, content: [{ type: 'text', text }] };
}

function budget(windowTokens: number, overrides?: Partial<ContextBudget>): ContextBudget {
  return { windowTokens, reserveOutputTokens: 0, marginRatio: 0, ...overrides };
}

function textOf(message: Message): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function allText(messages: readonly Message[]): string {
  return messages.map(textOf).join('\n');
}

const base = {
  system: [] as readonly Message[],
  tools: undefined as readonly ToolDefinition[] | undefined,
  maxToolResultTokens: 1000,
};

describe('buildModelContext fitting within budget', () => {
  it('keeps the whole conversation when it fits and reports no trimming', () => {
    const history = [user('q1'), assistantText('a1'), user('q2'), assistantText('a2')];
    const result = buildModelContext({ ...base, history, budget: budget(100_000) });

    expect(result.overflow).toBe(false);
    expect(result.breakdown.trimmed).toBe(false);
    expect(result.messages).toHaveLength(history.length);
    expect(allText(result.messages)).toContain('a1');
  });

  it('does not emit system messages (the caller prepends them)', () => {
    const system = [
      { role: 'system' as const, content: [{ type: 'text' as const, text: 'rules' }] },
    ];
    const result = buildModelContext({
      ...base,
      system,
      history: [user('q1')],
      budget: budget(100_000),
    });

    expect(result.messages.every((message) => message.role !== 'system')).toBe(true);
    expect(result.breakdown.categories.system).toBeGreaterThan(0);
  });

  it('counts tool definitions against the window', () => {
    const tools: ToolDefinition[] = [
      { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } },
    ];
    const result = buildModelContext({
      ...base,
      tools,
      history: [user('q1')],
      budget: budget(100_000),
    });

    expect(result.breakdown.categories.tools).toBeGreaterThan(0);
  });

  it('sums the category breakdown to the reported sent total', () => {
    const history = [user('q1'), assistantText('a1')];
    const result = buildModelContext({ ...base, history, budget: budget(100_000) });
    const { categories, sentTokens } = result.breakdown;
    const sum =
      categories.system +
      categories.tools +
      categories.userMessages +
      categories.assistantText +
      categories.assistantReasoning +
      categories.toolCalls +
      categories.toolResults +
      categories.skeleton;

    expect(sum).toBe(sentTokens);
  });

  it('keeps a tool cycle and its result adjacent when kept in full', () => {
    const history = [
      user('q1'),
      assistantCall('', [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }]),
      toolResult('c1', 'content of a'),
      user('q2'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(100_000) });

    const assistantIndex = result.messages.findIndex(
      (message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
    );
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    const next = result.messages[assistantIndex + 1];
    expect(next?.role).toBe('tool');
  });
});

describe('buildModelContext fidelity compression', () => {
  const longAnswer = 'A'.repeat(400);

  it('skeletonizes older turns while keeping the current turn verbatim', () => {
    const history = [user('q1 old question'), assistantText(longAnswer), user('q2')];
    const result = buildModelContext({ ...base, history, budget: budget(40) });

    expect(result.overflow).toBe(false);
    expect(result.breakdown.trimmed).toBe(true);
    // The skeleton is a single synthetic message, then the pinned current turn.
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual(user('q2'));
  });

  it('preserves full user text and points to the recall tool in the skeleton', () => {
    const history = [user('q1 old question'), assistantText(longAnswer), user('q2')];
    const result = buildModelContext({ ...base, history, budget: budget(40) });
    const skeleton = textOf(result.messages[0]!);

    expect(skeleton).toContain('q1 old question');
    expect(skeleton).toContain('recall');
    expect(result.breakdown.categories.skeleton).toBeGreaterThan(0);
  });

  it('keeps tool name, path, and success marker without the full result', () => {
    const history = [
      user('old'),
      assistantCall('', [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }]),
      toolResult('c1', 'X'.repeat(500)),
      user('current'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(30) });
    const skeleton = textOf(result.messages[0]!);

    expect(skeleton).toContain('read_file');
    expect(skeleton).toContain('a.ts');
    // The full 500-character body must not be inlined into the skeleton.
    expect(skeleton).not.toContain('X'.repeat(500));
    // No dangling tool message survives once the cycle is compressed.
    expect(result.messages.slice(0, -1).some((message) => message.role === 'tool')).toBe(false);
  });

  it('names a search pattern or a shortened command when a tool call has no path', () => {
    const longCommand = `pnpm --filter @weave/runtime test ${'x'.repeat(120)}`;
    const history = [
      user('old'),
      assistantCall('', [
        { id: 'c1', name: 'grep', arguments: '{"pattern":"createAgentRunner","path":"src"}' },
        { id: 'c2', name: 'run_command', arguments: JSON.stringify({ command: longCommand }) },
      ]),
      toolResult('c1', 'Y'.repeat(300)),
      toolResult('c2', 'Z'.repeat(300)),
      user('current'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(40) });
    const skeleton = textOf(result.messages[0]!);

    expect(skeleton).toContain('grep createAgentRunner');
    expect(skeleton).toContain('run_command pnpm --filter @weave/runtime test');
    expect(skeleton).not.toContain(longCommand);
  });

  it('keeps the error text of a failed tool result in the skeleton', () => {
    const failure = 'Tool "read_file" failed (workspace-file-not-found). missing path';
    const history = [
      user('old'),
      assistantCall('', [{ id: 'c2', name: 'read_file', arguments: '{"path":"missing.ts"}' }]),
      toolResult('c2', failure),
      user('current'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(30) });
    const skeleton = textOf(result.messages[0]!);

    expect(skeleton).toContain('workspace-file-not-found');
  });

  it('head/tail truncates an oversized tool result that is kept in full', () => {
    const history = [
      user('q'),
      assistantCall('', [{ id: 'c3', name: 'read_file', arguments: '{"path":"big.txt"}' }]),
      toolResult('c3', 'y'.repeat(20_000)),
    ];
    const result = buildModelContext({
      ...base,
      history,
      budget: budget(100_000),
      maxToolResultTokens: 100,
    });

    expect(result.breakdown.trimmed).toBe(true);
    const tool = result.messages.find((message) => message.role === 'tool');
    expect(textOf(tool!)).toContain('省略');
    expect(textOf(tool!).length).toBeLessThan(20_000);
  });
});

describe('buildModelContext overflow', () => {
  it('flags overflow when fixed cost leaves no room', () => {
    const result = buildModelContext({ ...base, history: [user('q')], budget: budget(0) });
    expect(result.overflow).toBe(true);
  });

  it('flags overflow when the current turn alone exceeds the budget', () => {
    const result = buildModelContext({
      ...base,
      history: [user('长'.repeat(400))],
      budget: budget(20),
    });
    expect(result.overflow).toBe(true);
  });

  it('reserved output tokens and margin reduce the usable window', () => {
    const history = [user('q1 old question'), assistantText('A'.repeat(400)), user('q2')];
    const tight = buildModelContext({
      ...base,
      history,
      budget: budget(200, { reserveOutputTokens: 180, marginRatio: 0 }),
    });
    const loose = buildModelContext({ ...base, history, budget: budget(200) });

    expect(loose.breakdown.trimmed).toBe(false);
    expect(tight.breakdown.trimmed).toBe(true);
  });
});
