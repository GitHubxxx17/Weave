import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRetrievalTools } from '../src/retrieval-tools.js';
import { createToolRegistry } from '../src/tool-registry.js';
import { createToolPipeline } from '../src/tool-pipeline.js';
import {
  activateAgentToolAuthority,
  createAgentToolAuthority,
  withAgentToolInvocation,
} from '../src/agent-tool-authority.js';
import { createApprovalBroker } from '../src/approval-broker.js';
import type { RetrievalService } from '../src/retrieval-types.js';
import { RetrievalError } from '../src/retrieval-errors.js';
const identity = {
  sessionId: 'session',
  executionId: 'exec',
  turnId: 'turn',
  userMessageId: 'message',
};
const query = { query: 'findSymbol', filters: { sources: ['workspace'], paths: {} } };
function fixture(mode: 'ask' | 'trust' | 'yolo' = 'yolo') {
  const execute = vi.fn(async () => ({ requestId: randomUUID(), hits: [] }));
  const service = {
    agent: {
      query: execute,
      status: async () => ({}),
      cancel: async () => ({}),
      prepareBuild: async () => ({}),
      describeBuild: () => ({
        preview: {
          mode: 'hybrid',
          project: { projectId: randomUUID() },
          manifestDigest: 'a'.repeat(64),
          requestId: randomUUID(),
        },
      }),
      executeBuild: execute,
    },
    local: {
      capabilities: () => ({
        lexical: { available: true },
        embedding: { configured: false, reason: 'not-configured' },
      }),
    },
  } as unknown as RetrievalService;
  const registry = createToolRegistry();
  const tools = createRetrievalTools({ service });
  for (const tool of Object.values(tools)) registry.register(tool);
  const token = createAgentToolAuthority({ identity, registry, ownerOf: () => 'host' });
  const signal = new AbortController().signal;
  const end = activateAgentToolAuthority(
    {
      sessionId: identity.sessionId,
      executionIdentity: identity,
      toolAuthority: token,
      userMessage: { role: 'user', content: [{ type: 'text', text: 'search' }] },
    },
    registry,
    { provider: 'test', model: 'test', permissionMode: mode, useProviderDefaults: false },
    signal,
  )!;
  const broker = createApprovalBroker();
  const run = (name: string, input: unknown, policy?: () => 'deny' | 'abstain') => {
    const request = {
      ...identity,
      toolCallId: 'call',
      name,
      arguments: JSON.stringify(input),
      signal,
      toolAuthority: token,
      permissionMode: mode,
    };
    return withAgentToolInvocation(request, () =>
      createToolPipeline({
        registry,
        approvalBroker: broker,
        allowHostToolContext: (tool) => Object.values(tools).includes(tool as never),
        ...(policy ? { policy } : {}),
      }).execute(request),
    );
  };
  return { execute, service, tools, registry, broker, run, end };
}
describe('retrieval host Pipeline tools', () => {
  it.each(['ask', 'trust', 'yolo'] as const)(
    'requires actual semantic approval in %s mode',
    async (mode) => {
      const f = fixture(mode);
      f.broker.subscribe((event) => {
        if (event.type === 'approval.created') f.broker.reject(event.request.approvalId);
      });
      await expect(f.run('semantic_search_project', query)).rejects.toMatchObject({
        code: 'tool-approval-rejected',
      });
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.broker.list()).toHaveLength(1);
      f.end();
    },
  );
  it('lets a deny policy stop semantic preview and execution', async () => {
    const f = fixture();
    await expect(f.run('semantic_search_project', query, () => 'deny')).rejects.toMatchObject({
      code: 'tool-denied',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.broker.list()).toHaveLength(0);
    f.end();
  });
  it('does not ask or send semantic egress for lexical search', async () => {
    const f = fixture();
    await f.run('search_project', query);
    expect(f.broker.list()).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[3]).toBeUndefined();
    f.end();
  });
  it('denies unbound host calls before around middleware', async () => {
    const f = fixture();
    const around = vi.fn();
    const pipeline = createToolPipeline({
      registry: f.registry,
      allowHostToolContext: () => true,
      around,
    });
    await expect(
      pipeline.execute({
        name: 'search_project',
        toolCallId: 'fake',
        arguments: JSON.stringify(query),
      }),
    ).rejects.toMatchObject({ code: 'tool-not-permitted' });
    expect(around).not.toHaveBeenCalled();
    f.end();
  });
  it('only forwards classified Runtime errors as safe finite tool codes', async () => {
    const f = fixture();
    f.execute.mockRejectedValueOnce(new RetrievalError('retrieval-stale-source'));
    await expect(f.run('search_project', query)).rejects.toMatchObject({
      code: 'retrieval-stale-source',
    });
    f.end();
  });
});
