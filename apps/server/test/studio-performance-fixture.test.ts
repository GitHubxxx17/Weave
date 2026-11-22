import { describe, expect, it } from 'vitest';
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

  it('emits ordered paced deltas and a terminal event using the current SSE contract', async () => {
    const fixture = await startPerformanceFixture({
      count: 100,
      variant: 'markdown',
      intervalMs: 0,
    });
    try {
      const response = await fetch(`${fixture.url}/agent/runs/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'benchmark-history',
          userMessage: {
            role: 'user',
            content: [{ type: 'text', text: 'benchmark' }],
          },
          provider: 'mock',
          model: 'benchmark',
        }),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const body = await response.text();
      const frames = body
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.split('\ndata: ')[1]!));
      expect(frames.slice(0, -1).map((frame) => frame.text)).toEqual(
        Array.from(
          { length: 100 },
          (_, index) => `benchmark-stream-${String(index).padStart(3, '0')} `,
        ),
      );
      expect(frames.at(-1)).toEqual({ type: 'completed', turnId: 'benchmark-live' });
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
