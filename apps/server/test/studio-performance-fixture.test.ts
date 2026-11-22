import { describe, expect, it } from 'vitest';
import {
  agentExecutionFrameSchema,
  agentExecutionSnapshotSchema,
  agentExecutionSummarySchema,
  agentExecutionQueueSnapshotSchema,
} from '@weave/runtime';
import { z } from 'zod';
// @ts-expect-error Node-only acceptance tooling is JavaScript, outside production TS contracts.
import { createScenario } from './performance/scenario.mjs';
// @ts-expect-error Node-only acceptance tooling is JavaScript, outside production TS contracts.
import { startPerformanceFixture } from './performance/fixture.mjs';

describe('Studio performance fixture', () => {
  it('bounds inputs and creates paired history with exactly the requested visible messages', () => {
    expect(() => createScenario(3, 'markdown')).toThrow();
    expect(() => createScenario(50_000, 'markdown')).toThrow();
    expect(() => createScenario(100, 'unknown')).toThrow();
    const scenario = createScenario(100, 'tools');
    const detail = scenario.sessions[0];
    expect(
      detail.messages.filter((m: { role: string }) => ['user', 'assistant'].includes(m.role)),
    ).toHaveLength(100);
    expect(detail.turns).toHaveLength(50);
    for (const turn of detail.turns) {
      expect(turn.status).toBe('completed');
      const call = detail.messages.find(
        (m: { role: string; turnId: string }) => m.role === 'assistant' && m.turnId === turn.turnId,
      ).toolCalls[0];
      expect(detail.messages.some((m: { toolCallId?: string }) => m.toolCallId === call.id)).toBe(
        true,
      );
    }
  });

  it('serves isolated JSON and rejects unknown routes and traversal', async () => {
    const fixture = await startPerformanceFixture({ count: 100, variant: 'markdown' });
    try {
      const projects = await fetch(`${fixture.url}/projects?includeArchived=true`).then((r) =>
        r.json(),
      );
      expect(projects.projects).toHaveLength(1);
      expect(projects.projects[0].sessions).toHaveLength(2);
      const detail = await fetch(`${fixture.url}/sessions/benchmark-history`).then((r) => r.json());
      expect(detail.messages).toHaveLength(100);
      expect((await fetch(`${fixture.url}/unknown-api`)).status).toBe(404);
      expect((await fetch(`${fixture.url}/%2e%2e%2fpackage.json`)).status).toBe(404);
    } finally {
      await fixture.close();
      await fixture.close();
    }
  });

  it('accepts once, streams the original 100 tokens and restores two durable visible messages', async () => {
    const fixture = await startPerformanceFixture({
      count: 100,
      variant: 'markdown',
      intervalMs: 0,
    });
    try {
      const input = {
        userMessage: { role: 'user', content: [{ type: 'text', text: 'benchmark request' }] },
        provider: 'mock',
        model: 'benchmark',
        permissionMode: 'ask',
      };
      const post = (value: unknown) =>
        fetch(`${fixture.url}/sessions/benchmark-history/executions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        });
      const accepted = await post({ requestId: 'benchmark-request', input });
      expect(accepted.status).toBe(202);
      const receipt = agentExecutionSnapshotSchema.parse(await accepted.json());
      const replay = await post({ requestId: 'benchmark-request', input });
      expect(replay.status).toBe(202);
      expect(agentExecutionSnapshotSchema.parse(await replay.json()).executionId).toBe(
        receipt.executionId,
      );
      expect(
        (await post({ requestId: 'benchmark-request', input: { ...input, model: 'conflict' } }))
          .status,
      ).toBe(409);
      const path = `${fixture.url}/sessions/benchmark-history/executions/${receipt.executionId}`;
      const response = await fetch(`${path}/events?after=${encodeURIComponent(receipt.cursor)}`);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const body = await response.text();
      const frames = body
        .trim()
        .split('\n\n')
        .map((frame) => agentExecutionFrameSchema.parse(JSON.parse(frame.split('\ndata: ')[1]!)));
      expect(
        frames
          .filter((frame) => frame.type === 'event' && frame.event.type === 'text-delta')
          .map((frame) =>
            frame.type === 'event' && frame.event.type === 'text-delta' ? frame.event.text : '',
          ),
      ).toEqual(
        Array.from(
          { length: 100 },
          (_, index) => `benchmark-stream-${String(index).padStart(3, '0')} `,
        ),
      );
      expect(frames.at(-1)).toMatchObject({
        type: 'status',
        status: 'completed',
        durableThroughSequence: expect.any(Number),
      });
      const snapshot = agentExecutionSnapshotSchema.parse(await (await fetch(path)).json());
      expect(snapshot).toMatchObject({
        executionId: receipt.executionId,
        status: 'completed',
        events: [],
      });
      const summaries = z
        .array(agentExecutionSummarySchema)
        .parse(await (await fetch(`${fixture.url}/sessions/benchmark-history/executions`)).json());
      expect(summaries).toHaveLength(1);
      const detail = await (await fetch(`${fixture.url}/sessions/benchmark-history`)).json();
      expect(
        detail.messages.filter((message: { role: string }) =>
          ['user', 'assistant'].includes(message.role),
        ),
      ).toHaveLength(102);
      expect(detail.messages.slice(-2)).toMatchObject([
        {
          messageId: receipt.userMessageId,
          turnId: receipt.turnId,
          role: 'user',
          content: input.userMessage.content,
        },
        {
          turnId: receipt.turnId,
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: Array.from(
                { length: 100 },
                (_, index) => `benchmark-stream-${String(index).padStart(3, '0')} `,
              ).join(''),
            },
          ],
        },
      ]);
      expect(detail.lastSequence).toBeGreaterThanOrEqual(snapshot.durableThroughSequence!);
      expect((await fetch(`${fixture.url}/agent/runs/stream`, { method: 'POST' })).status).toBe(
        404,
      );
    } finally {
      await fixture.close();
    }
  });
  it('exposes queue replacement state used by production Studio without changing benchmark work', async () => {
    const fixture = await startPerformanceFixture({ count: 100, variant: 'markdown' });
    try {
      const response = await fetch(
        `${fixture.url}/sessions/benchmark-history/executions/queue/events`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      try {
        const frame = new TextDecoder().decode((await reader.read()).value);
        expect(frame).toContain('event: queue');
        const snapshot = agentExecutionQueueSnapshotSchema.parse(
          JSON.parse(frame.split('data: ')[1]!.trim()),
        );
        expect(snapshot).toMatchObject({
          sessionId: 'benchmark-history',
          active: null,
          queued: [],
        });
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } finally {
      await fixture.close();
    }
  });

  it('holds approval snapshot subscription open and closes active streams', async () => {
    const fixture = await startPerformanceFixture({ count: 100, variant: 'markdown' });
    const response = await fetch(`${fixture.url}/approvals/stream`);
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        'event: approval.snapshot\ndata: {"approvals":[]}\n\n',
      );
      const next = reader.read();
      await fixture.close();
      await next.then(
        (value) => expect(value.done).toBe(true),
        (error) => expect(error).toBeInstanceOf(TypeError),
      );
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
      await fixture.close();
    }
  });
});
