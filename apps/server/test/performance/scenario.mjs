import { z } from 'zod';

export const scenarioOptionsSchema = z.strictObject({
  count: z
    .number()
    .int()
    .min(2)
    .max(5000)
    .refine((n) => n % 2 === 0, 'Use paired messages'),
  variant: z.enum(['markdown', 'tools']),
});
const timestamp = '2026-11-23T00:00:00.000Z';

/** Synthetic HTTP read models, deliberately independent of real stores and providers. */
export function createScenario(count, variant) {
  scenarioOptionsSchema.parse({ count, variant });
  const messages = [];
  const turns = [];
  for (let index = 0; index < count / 2; index++) {
    const turnId = `benchmark-turn-${index}`;
    const toolCallId = `benchmark-call-${index}`;
    const metadata = { occurredAt: timestamp, turnId };
    const push = (message) =>
      messages.push({
        ...message,
        ...metadata,
        messageId: `benchmark-message-${messages.length}`,
        sequence: messages.length + 2,
      });
    push({
      role: 'user',
      content: [{ type: 'text', text: `问题 ${index}：请分析组件的状态更新和取消行为。` }],
    });
    push({
      role: 'assistant',
      content: [
        {
          type: 'text',
          text:
            `### 分析 ${index}\n\n保留稳定的会话归属，检查请求结束时的状态。\n\n- 验证输入\n- 处理取消\n\n` +
            '```ts\nconst state = { status: "completed", count: 42 };\n```\n\n结果与持久化记录一致。',
        },
      ],
      ...(variant === 'tools'
        ? {
            toolCalls: [
              {
                id: toolCallId,
                name: 'read_file',
                arguments: JSON.stringify({ path: `src/component-${index}.tsx` }),
              },
            ],
          }
        : {}),
    });
    if (variant === 'tools')
      push({
        role: 'tool',
        toolCallId,
        content: [
          { type: 'text', text: 'export const component = "bounded fixture";\n'.repeat(12) },
        ],
      });
    turns.push({
      turnId,
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      provider: 'mock',
      model: 'benchmark',
      modelSteps: [],
      toolCalls: variant === 'tools' ? 1 : 0,
      failedToolCalls: 0,
      toolResults: variant === 'tools' ? [{ toolCallId, status: 'completed' }] : [],
    });
  }
  const sessions = [
    {
      id: 'benchmark-history',
      title: `性能基线 ${count} ${variant}`,
      lastSequence: messages.length + 1,
      messages,
      turns,
    },
    { id: 'benchmark-control', title: '性能对照会话', lastSequence: 1, messages: [], turns: [] },
  ];
  return {
    sessions,
    project: {
      id: 'benchmark-project',
      name: '隔离性能基线',
      folderName: 'synthetic',
      createdAt: timestamp,
      updatedAt: timestamp,
      // Studio reverses creation order; make the history Session the newest.
      sessions: [...sessions]
        .reverse()
        .map(({ messages: ignoredMessages, turns: ignoredTurns, ...summary }) => {
          void ignoredMessages;
          void ignoredTurns;
          return summary;
        }),
    },
  };
}
