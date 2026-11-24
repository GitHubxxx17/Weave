import { createToolCommandMockLlmClient } from '@weave/llm';
import type { StreamEvent } from '@weave/protocol';
import { describe, expect, it } from 'vitest';
import { runCommandInputSchema } from '../src/index.js';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe('mock /tool demo and run_command', () => {
  const client = createToolCommandMockLlmClient({
    fallback: [{ type: 'finish', reason: 'stop' }],
  });
  const tools = [{ name: 'run_command', description: 'Run a command', parameters: {} }];

  it('shows a run_command example that passes the real input schema', async () => {
    const events = await collect(
      client.stream({
        provider: 'mock',
        model: 'weave-local-demo',
        messages: [{ role: 'user', content: [{ type: 'text', text: '/tool' }] }],
        tools,
      }),
    );
    const text = events
      .filter((event) => event.type === 'text-delta')
      .map((event) => event.text)
      .join('');
    const line = text.split('\n').find((candidate) => candidate.startsWith('/tool run_command '));
    expect(line).toBeDefined();

    const json = line?.slice('/tool run_command '.length) ?? '';
    expect(runCommandInputSchema.safeParse(JSON.parse(json)).success).toBe(true);
  });

  it('forwards the example arguments to a run_command call unchanged', async () => {
    const example = '{"command":"echo hello","risk":"low","riskReason":"只打印一行文字"}';
    const events = await collect(
      client.stream({
        provider: 'mock',
        model: 'weave-local-demo',
        messages: [
          { role: 'user', content: [{ type: 'text', text: `/tool run_command ${example}` }] },
        ],
        tools,
      }),
    );
    const delta = events.find((event) => event.type === 'tool-call-delta');
    expect(delta).toMatchObject({ argumentsDelta: example });
    expect(runCommandInputSchema.safeParse(JSON.parse(example)).success).toBe(true);
  });
});
