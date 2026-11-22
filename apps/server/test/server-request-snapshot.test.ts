import { describe, expect, it } from 'vitest';
import type { AgentRunRequest } from '@weave/runtime';
import {
  assembleServerGeneration,
  commitServerGeneration,
  createServerRuntime,
  disposeServerPlugins,
} from '../src/runtime.js';

describe('Server generation request snapshot', () => {
  it('copies image parts and exact Skill refs before the generation queue while selecting the generation at its head', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    const seen: AgentRunRequest[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const first = await assembleServerGeneration(runtime);
    commitServerGeneration(runtime, {
      ...first,
      runner: {
        async *run(request) {
          seen.push(request);
          firstStarted.resolve();
          await gate.promise;
          yield { type: 'completed', turnId: 'one' };
        },
      },
    });
    const runner = runtime.serverHost.controller()!.runner;
    const request = {
      sessionId: 's',
      provider: 'mock',
      model: 'm',
      userMessage: {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'original' },
          { type: 'image' as const, mediaType: 'image/png' as const, data: 'aGVsbG8=' },
        ],
      },
      skills: [
        {
          id: 'builtin:weave-planning',
          instructionSha256: 'a'.repeat(64),
          bundleSha256: 'b'.repeat(64),
        },
      ],
    };
    try {
      const active = runner.run(request)[Symbol.asyncIterator]();
      const activeNext = active.next();
      await firstStarted.promise;
      const queued = runner.run(request)[Symbol.asyncIterator]();
      const queuedNext = queued.next();
      request.userMessage.content[0]!.text = 'mutated';
      request.skills[0]!.bundleSha256 = 'c'.repeat(64);
      request.userMessage.content[1]!.data = 'Y2hhbmdlZA==';
      const next = await assembleServerGeneration(runtime);
      commitServerGeneration(runtime, {
        ...next,
        runner: {
          async *run(value) {
            seen.push(value);
            yield { type: 'completed', turnId: 'two' };
          },
        },
      });
      gate.resolve();
      await activeNext;
      await queuedNext;
      expect(seen[1]?.skills?.[0]?.bundleSha256).toBe('b'.repeat(64));
      expect(seen[1]?.userMessage.content[0]).toEqual({ type: 'text', text: 'original' });
      expect(seen[1]?.userMessage.content[1]).toEqual({
        type: 'image',
        mediaType: 'image/png',
        data: 'aGVsbG8=',
      });
      await queued.return?.();
      await active.return?.();
    } finally {
      gate.resolve();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
