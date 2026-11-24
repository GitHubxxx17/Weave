import { describe, expect, it } from 'vitest';
import { createServerAgentRunner, createServerRuntime } from '../src/runtime.js';
import { runAgentTurn } from './agent-run-helper.js';

describe('default Agent Runner', () => {
  it('streams the deterministic local demo', async () => {
    const runtime = createServerRuntime();
    await runtime.start();

    try {
      const body = await runAgentTurn(await createServerAgentRunner(runtime), {
        sessionId: 'session-http-1',
        userMessage: { role: 'user', content: [{ type: 'text', text: '你好' }] },
        provider: 'mock',
        model: 'test-model',
      });
      const firstTextDelta =
        'event: text-delta\n' +
        'data: {"type":"text-delta","text":"这是 Weave 的本地 Agent 演示。"}';
      const secondTextDelta =
        'event: text-delta\n' + 'data: {"type":"text-delta","text":" 当前消息通过 SSE 增量传输。"}';

      expect(body).toContain(firstTextDelta);
      expect(body).toContain(secondTextDelta);
      expect(body.indexOf(firstTextDelta)).toBeLessThan(body.indexOf(secondTextDelta));
      expect(body).toMatch(/event: completed\ndata: \{"type":"completed","turnId":"[^"]+"\}\n\n$/);
      expect(body).not.toContain('event: error');
    } finally {
      await runtime.stop();
    }
  });
});
