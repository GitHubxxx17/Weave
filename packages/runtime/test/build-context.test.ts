import type { Message, ToolCall, ToolDefinition } from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import { buildModelContext, type ContextBudget } from '../src/context/build-context.js';
import {
  estimateMessageTokens,
  estimateTokens,
  estimateToolsTokens,
} from '../src/context/token-estimate.js';

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
  const longAnswer = 'A'.repeat(4000);

  it('skeletonizes older turns while keeping the current turn verbatim', () => {
    const history = [user('q1 old question'), assistantText(longAnswer), user('q2')];
    const result = buildModelContext({ ...base, history, budget: budget(200) });

    expect(result.overflow).toBe(false);
    expect(result.breakdown.trimmed).toBe(true);
    expect(result.messages).toContainEqual(user('q1 old question'));
    expect(result.messages.at(-1)).toEqual(user('q2'));
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(200);
  });

  it('preserves full user text and points to the recall tool in the skeleton', () => {
    const history = [user('q1 old question'), assistantText(longAnswer), user('q2')];
    const result = buildModelContext({ ...base, history, budget: budget(200) });
    const skeleton = allText(result.messages);

    expect(skeleton).toContain('q1 old question');
    expect(skeleton).toContain('recall');
    expect(result.breakdown.categories.skeleton).toBeGreaterThan(0);
  });

  it('keeps tool name, path, and success marker without the full result', () => {
    const history = [
      user('old'),
      assistantCall('', [{ id: 'c1', name: 'read_file', arguments: '{"path":"a.ts"}' }]),
      toolResult('c1', 'X'.repeat(4000)),
      user('current'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(200) });
    const skeleton = allText(result.messages);

    expect(skeleton).toContain('read_file');
    expect(skeleton).toContain('a.ts');
    expect(result.overflow).toBe(false);
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(200);
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
      toolResult('c1', 'Y'.repeat(4000)),
      toolResult('c2', 'Z'.repeat(4000)),
      user('current'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(250) });
    const skeleton = allText(result.messages);

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
    const skeleton = allText(result.messages);

    expect(skeleton).toContain('workspace-file-not-found');
    expect(result.overflow).toBe(true);
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

describe('buildModelContext estimated budget bounds', () => {
  it('counts images in system and user content and preserves older attachments', () => {
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=' };
    const old: Message = { role: 'user', content: [image] };
    const system: Message[] = [{ role: 'system', content: [image] }];
    const result = buildModelContext({
      ...base,
      system,
      history: [old, user('q')],
      budget: budget(2050),
    });

    expect(result.breakdown.categories.system).toBe(1028);
    expect(result.breakdown.categories.userMessages).toBe(1033);
    expect(result.breakdown.sentTokens).toBe(2061);
    expect(result.messages).toContainEqual(old);
    expect(result.overflow).toBe(true);
  });

  it('accounts for separate text parts and strips reasoning from sent messages', () => {
    const assistant: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
        { type: 'reasoning', text: '隐'.repeat(4000) },
      ],
    };
    const result = buildModelContext({
      ...base,
      history: [user('q'), assistant],
      budget: budget(11),
    });

    expect(result.breakdown.sentTokens).toBe(11);
    expect(result.overflow).toBe(false);
    expect(result.messages[1]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it.each([0, 1, 20, 30, 40])(
    'overflows a %i token budget when even the faithful skeleton cannot fit',
    (limit) => {
      const result = buildModelContext({
        ...base,
        history: [user('old'), assistantText('A'.repeat(4000)), user('q')],
        budget: budget(limit),
      });

      expect(result.overflow).toBe(true);
      expect(result.breakdown.sentTokens).toBeGreaterThan(limit);
      expect(result.messages).toContainEqual(user('old'));
    },
  );

  it('does not admit a large skeleton after reserving only the current turn', () => {
    const history: Message[] = Array.from({ length: 100 }, (_, i) => [
      user(`old ${i}`),
      assistantText('中'.repeat(500)),
    ]).flat();
    history.push(user('current'));
    const result = buildModelContext({ ...base, history, budget: budget(200) });

    expect(result.overflow).toBe(true);
    expect(result.breakdown.sentTokens).toBeGreaterThan(200);
    for (const message of history.filter((message) => message.role === 'user')) {
      expect(result.messages).toContainEqual(message);
    }
  });

  it('retains a huge older user message instead of silently truncating it to fit', () => {
    const old = user('意'.repeat(2000));
    const result = buildModelContext({ ...base, history: [old, user('q')], budget: budget(100) });

    expect(result.messages).toContainEqual(old);
    expect(result.overflow).toBe(true);
  });

  it('fits CJK head and tail plus its truncation notice within the explicit result threshold', () => {
    const text = `开头${'中'.repeat(500)}结尾`;
    const result = buildModelContext({
      ...base,
      history: [
        user('q'),
        assistantCall('', [{ id: 'c', name: 'read', arguments: '{}' }]),
        toolResult('c', text),
      ],
      budget: budget(100),
      maxToolResultTokens: 30,
    });
    const tool = result.messages.find((message) => message.role === 'tool')!;

    expect(result.overflow).toBe(false);
    expect(estimateTokens(textOf(tool))).toBeLessThanOrEqual(30);
    expect(textOf(tool)).toMatch(/^开头.*省略.*结尾$/s);
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(100);
  });

  it('keeps full text when a tiny result threshold cannot hold the notice and both ends', () => {
    const text = `首${'中'.repeat(500)}尾`;
    const result = buildModelContext({
      ...base,
      history: [
        user('q'),
        assistantCall('', [{ id: 'c', name: 'read', arguments: '{}' }]),
        toolResult('c', text),
      ],
      budget: budget(100),
      maxToolResultTokens: 1,
    });

    expect(result.overflow).toBe(true);
    expect(textOf(result.messages.at(-1)!)).toBe(text);
  });

  it('preserves complete failed results in both current and compressed historical tool cycles', () => {
    const failure = `Tool read failed (missing). ${'错'.repeat(500)}`;
    const cycle = [
      assistantCall('', [{ id: 'c', name: 'read', arguments: '{"path":"missing"}' }]),
      toolResult('c', failure),
    ];
    for (const history of [
      [user('q'), ...cycle],
      [user('old'), ...cycle, user('q')],
    ]) {
      const result = buildModelContext({
        ...base,
        history,
        budget: budget(100),
        maxToolResultTokens: 20,
      });

      expect(allText(result.messages)).toContain(failure);
      expect(result.overflow).toBe(true);
    }
  });

  it('uses authoritative failure facts even when the content has no error keyword', () => {
    const failure = toolResult('c', `不存在。${'详'.repeat(500)}`);
    const result = buildModelContext({
      ...base,
      history: [
        user('old'),
        assistantCall('', [{ id: 'c', name: 'read', arguments: '{}' }]),
        failure,
        user('q'),
      ],
      toolResultStatuses: new Map([[failure, 'failed']]),
      budget: budget(100),
      maxToolResultTokens: 20,
    });

    expect(allText(result.messages)).toContain(textOf(failure));
    expect(result.overflow).toBe(true);
  });

  it('keeps unknown historical failures when the status map covers other messages only', () => {
    const failure = toolResult('c', `error ${'详'.repeat(500)}`);
    const result = buildModelContext({
      ...base,
      history: [
        user('q'),
        assistantCall('', [{ id: 'c', name: 'read', arguments: '{}' }]),
        failure,
      ],
      toolResultStatuses: new Map(),
      budget: budget(100),
      maxToolResultTokens: 20,
    });

    expect(textOf(result.messages.at(-1)!)).toBe(textOf(failure));
    expect(result.overflow).toBe(true);
  });

  it('preserves failure text when a mixed successful and failed cycle is skeletonized', () => {
    const failure = toolResult('bad', `不存在。${'详'.repeat(80)}`);
    const result = buildModelContext({
      ...base,
      history: [
        user('old'),
        assistantCall('', [
          { id: 'bad', name: 'read', arguments: '{"path":"missing"}' },
          { id: 'good', name: 'read', arguments: '{"path":"big"}' },
        ]),
        failure,
        toolResult('good', 'X'.repeat(8000)),
        user('q'),
      ],
      toolResultStatuses: new Map([[failure, 'failed']]),
      budget: budget(250),
    });

    expect(result.overflow).toBe(false);
    expect(result.breakdown.trimmed).toBe(true);
    expect(allText(result.messages)).toContain(textOf(failure));
    expect(allText(result.messages)).toContain('[recall id=bad]');
    expect(allText(result.messages)).toContain('[recall id=good]');
    expect(result.messages.some((message) => message.role === 'tool')).toBe(false);
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(250);
  });

  it('keeps an unmatched tool result visible rather than dropping it during skeletonization', () => {
    const orphan = toolResult('unexpected', '孤立内容');
    const result = buildModelContext({
      ...base,
      history: [user('old'), assistantText('A'.repeat(4000)), orphan, user('q')],
      budget: budget(200),
    });

    expect(result.messages).toContainEqual(orphan);
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(200);
  });

  it('reports the estimate of every emitted part across system, tools, images and skeletons', () => {
    const image = { type: 'image' as const, mediaType: 'image/png', data: 'aGVsbG8=' };
    const system: Message[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, image],
      },
    ];
    const tools: ToolDefinition[] = [{ name: 'a', description: 'b', parameters: {} }];
    const history = [
      user('old'),
      assistantText('A'.repeat(8000)),
      { role: 'user' as const, content: [image] },
    ];
    const result = buildModelContext({ ...base, system, tools, history, budget: budget(2250) });
    const actual = [...system, ...result.messages].reduce(
      (sum, message) => sum + estimateMessageTokens(message),
      estimateToolsTokens(tools),
    );

    expect(result.overflow).toBe(false);
    expect(result.breakdown.trimmed).toBe(true);
    expect(result.breakdown.categories.system).toBe(1030);
    expect(result.breakdown.categories.tools).toBe(7);
    expect(result.breakdown.sentTokens).toBe(actual);
    expect(Object.values(result.breakdown.categories).reduce((sum, value) => sum + value, 0)).toBe(
      actual,
    );
    expect(actual).toBeLessThanOrEqual(2250);
  });

  it('can truncate successful output containing error when authoritative status is supplied', () => {
    const success = toolResult('c', `error documentation ${'中'.repeat(500)}`);
    const result = buildModelContext({
      ...base,
      history: [
        user('q'),
        assistantCall('', [{ id: 'c', name: 'read', arguments: '{}' }]),
        success,
      ],
      toolResultStatuses: new Map([[success, 'completed']]),
      budget: budget(100),
      maxToolResultTokens: 30,
    });

    expect(result.overflow).toBe(false);
    expect(result.breakdown.sentTokens).toBeLessThanOrEqual(100);
  });

  it('counts tools, system, output reserve and margin with exact usable-boundary admission', () => {
    const system: Message[] = [{ role: 'system', content: [{ type: 'text', text: 'rules' }] }];
    const tools: ToolDefinition[] = [{ name: 'a', description: 'b', parameters: {} }];
    // system 6 + tool 7 + user 5 = 18; floor(40 * .75) - reserve 12 = 18.
    for (const [reserveOutputTokens, overflow] of [
      [12, false],
      [13, true],
    ] as const) {
      const result = buildModelContext({
        ...base,
        system,
        tools,
        history: [user('q')],
        budget: budget(40, { marginRatio: 0.25, reserveOutputTokens }),
      });

      expect(result.breakdown.sentTokens).toBe(18);
      expect(result.overflow).toBe(overflow);
    }
  });

  it('restores recent whole tool cycles while budgeting the remaining older skeleton', () => {
    const history = [
      user('old'),
      assistantText('A'.repeat(4000)),
      assistantCall('', [
        { id: 'a', name: 'read', arguments: '{"path":"a"}' },
        { id: 'b', name: 'read', arguments: '{"path":"b"}' },
      ]),
      toolResult('a', 'one'),
      toolResult('b', 'two'),
      user('q'),
    ];
    const result = buildModelContext({ ...base, history, budget: budget(200) });

    expect(result.overflow).toBe(false);
    const callIndex = result.messages.findIndex(
      (message) => message.role === 'assistant' && message.toolCalls?.length === 2,
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(result.messages.slice(callIndex + 1, callIndex + 3)).toEqual([
      toolResult('a', 'one'),
      toolResult('b', 'two'),
    ]);
    const actual = [...base.system, ...result.messages].reduce(
      (total, message) => total + estimateMessageTokens(message),
      estimateToolsTokens(base.tools),
    );
    expect(result.breakdown.sentTokens).toBe(actual);
    expect(actual).toBeLessThanOrEqual(200);
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
