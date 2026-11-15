import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  createToolPipeline,
  createToolRegistry,
  type ToolDefinition,
} from '@weave/runtime';

interface EchoInput {
  readonly text: string;
}

function createRegistry(
  execute: ToolDefinition<EchoInput, unknown>['execute'] = ({ text }) => text,
) {
  const registry = createToolRegistry();
  registry.register({
    name: 'echo',
    description: 'Returns the input text',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
    },
    inputSchema: z.object({ text: z.string() }),
    execute,
  });
  return registry;
}

describe('Tool Pipeline', () => {
  it('parses and validates arguments before invoking the tool', async () => {
    const execute = vi.fn(({ text }: EchoInput) => text.toUpperCase());
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({
      toolCallId: 'call-1',
      name: 'echo',
      content: 'HELLO',
      truncated: false,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unknown tools and invalid JSON without invoking a handler', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({ toolCallId: 'call-1', name: 'missing', arguments: '{}' }),
    ).rejects.toMatchObject({ code: 'tool-not-found' });
    await expect(
      pipeline.execute({ toolCallId: 'call-2', name: 'echo', arguments: '{' }),
    ).rejects.toMatchObject({ code: 'tool-invalid-json' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects invalid arguments before invoking a handler', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":42}',
      }),
    ).rejects.toMatchObject({ code: 'tool-invalid-arguments' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps an already aborted request to tool-cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn();
    const pipeline = createToolPipeline({ registry: createRegistry(execute) });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'tool-cancelled' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('maps a deadline to tool-timeout', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(
        (_input, { signal }) =>
          new Promise<string>((resolve, reject) => {
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('', 'AbortError')),
              { once: true },
            );
          }),
      ),
      timeoutMs: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-timeout' });
  });

  it('does not invoke a tool when the timeout budget is zero', async () => {
    const execute = vi.fn();
    const pipeline = createToolPipeline({
      registry: createRegistry(execute),
      timeoutMs: 0,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-timeout' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves tool errors as causes', async () => {
    const cause = new Error('disk unavailable');
    const pipeline = createToolPipeline({
      registry: createRegistry(() => Promise.reject(cause)),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-execution-failed', cause });
  });

  it('limits UTF-8 output without splitting a multibyte character', async () => {
    const pipeline = createToolPipeline({
      registry: createRegistry(() => '你好a'),
      maxResultBytes: 5,
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '你', truncated: true });
  });

  it('serializes structured results and marks undefined as empty content', async () => {
    const structured = createToolPipeline({
      registry: createRegistry(() => ({ ok: true })),
    });
    const empty = createToolPipeline({
      registry: createRegistry(() => undefined),
    });

    await expect(
      structured.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '{"ok":true}', truncated: false });
    await expect(
      empty.execute({
        toolCallId: 'call-2',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).resolves.toMatchObject({ content: '', truncated: false });
  });

  it('classifies circular results as serialization failures', async () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const pipeline = createToolPipeline({
      registry: createRegistry(() => circular),
    });

    await expect(
      pipeline.execute({
        toolCallId: 'call-1',
        name: 'echo',
        arguments: '{"text":"hello"}',
      }),
    ).rejects.toMatchObject({ code: 'tool-result-serialization-failed' });
  });
});
