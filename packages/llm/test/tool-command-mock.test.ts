import type { LlmRequest, Message, StreamEvent } from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import { createToolCommandMockLlmClient } from '../src/index.js';

const fallback: readonly StreamEvent[] = [
  { type: 'text-delta', text: '固定回答' },
  { type: 'finish', reason: 'stop' },
];

const tools = [{ name: 'run_command', description: 'Run a command', parameters: {} }];

function user(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }] };
}

function request(messages: readonly Message[], withTools = true): LlmRequest {
  return {
    provider: 'mock',
    model: 'weave-local-demo',
    messages: [{ role: 'system', content: [{ type: 'text', text: '系统说明' }] }, ...messages],
    ...(withTools ? { tools } : {}),
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

function textOf(events: readonly StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'text-delta')
    .map((event) => event.text)
    .join('');
}

describe('Tool command mock client', () => {
  const client = createToolCommandMockLlmClient({ fallback });

  it('replays the fallback script for an ordinary message', async () => {
    await expect(collect(client.stream(request([user('你好')])))).resolves.toEqual(fallback);
  });

  it('turns each /tool line into a tool call and passes the arguments verbatim', async () => {
    const events = await collect(
      client.stream(
        request([
          user(
            [
              '先跑两个命令',
              '/tool run_command {"command":"echo hello"}',
              '  /tool list_dir  ',
              '/tool run_command {not json',
            ].join('\n'),
          ),
        ]),
      ),
    );

    expect(events.map((event) => event.type)).toEqual([
      'tool-call-start',
      'tool-call-delta',
      'tool-call-start',
      'tool-call-delta',
      'tool-call-start',
      'tool-call-delta',
      'finish',
    ]);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'tool-call' });
    const starts = events.filter((event) => event.type === 'tool-call-start');
    expect(starts.map((event) => event.name)).toEqual(['run_command', 'list_dir', 'run_command']);
    expect(new Set(starts.map((event) => event.id)).size).toBe(3);
    expect(starts.every((event) => event.id.startsWith('mock-call-'))).toBe(true);
    expect(
      events
        .filter((event) => event.type === 'tool-call-delta')
        .map((event) => event.argumentsDelta),
    ).toEqual(['{"command":"echo hello"}', '{}', '{not json']);
    // Each delta belongs to the call started just before it.
    expect(events[1]).toMatchObject({ id: starts[0]?.id });
  });

  it('explains the syntax instead of calling tools when a line has no tool name', async () => {
    const events = await collect(
      client.stream(request([user('/tool run_command {"command":"ls"}\n/tool {"command":"ls"}')])),
    );

    expect(events.some((event) => event.type === 'tool-call-start')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    expect(textOf(events)).toContain('无法识别这些 /tool 指令：\n/tool {"command":"ls"}');
    expect(textOf(events)).toContain('格式：/tool 工具名 JSON参数');
  });

  it('does not treat other slash words as commands', async () => {
    await expect(collect(client.stream(request([user('/toolbox 是什么')])))).resolves.toEqual(
      fallback,
    );
  });

  it('says so when the request offers no tools', async () => {
    const events = await collect(
      client.stream(request([user('/tool run_command {"command":"ls"}')], false)),
    );

    expect(textOf(events)).toBe('（本地演示）本轮没有可用的工具，/tool 指令无法执行。');
  });

  it('summarizes the tool results that end the conversation', async () => {
    const events = await collect(
      client.stream(
        request([
          user('/tool run_command {"command":"echo hi"}\n/tool write_file {}'),
          {
            role: 'assistant',
            content: [],
            toolCalls: [
              { id: 'call-1', name: 'run_command', arguments: '{"command":"echo hi"}' },
              { id: 'call-2', name: 'write_file', arguments: '{}' },
            ],
          },
          {
            role: 'tool',
            toolCallId: 'call-1',
            content: [{ type: 'text', text: '\n$ echo hi\nexit code: 0 · 0.0 s' }],
          },
          {
            role: 'tool',
            toolCallId: 'call-2',
            content: [
              {
                type: 'text',
                text: `Tool "write_file" failed (tool-approval-rejected). ${'x'.repeat(300)}`,
              },
            ],
          },
        ]),
      ),
    );

    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
    const text = textOf(events);
    expect(text.split('\n')).toEqual([
      '（本地演示）收到 2 个工具结果：',
      '- run_command：$ echo hi',
      expect.stringMatching(
        /^- write_file：Tool "write_file" failed \(tool-approval-rejected\)\. x+…$/,
      ),
    ]);
    expect(text.split('\n')[2]?.length).toBeLessThan(180);
  });

  it('validates the request and honours cancellation', async () => {
    await expect(
      collect(client.stream({ provider: 'mock', model: 'm', messages: [{ role: 'x' }] } as never)),
    ).rejects.toThrow();

    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(
        client.stream(request([user('/tool run_command {}')]), { signal: controller.signal }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(() => createToolCommandMockLlmClient({ fallback, delayMs: -1 })).toThrow(RangeError);
  });
});
