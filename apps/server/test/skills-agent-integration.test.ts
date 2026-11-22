import { describe, expect, it } from 'vitest';
import { definePlugin, toolAroundHook } from '@weave/plugin';
import type { AgentRunRequest } from '@weave/runtime';
import type { LlmRequest } from '@weave/protocol';
import { createInMemoryProjectStore } from '@weave/workspace';
import { createSessionService } from '../src/session-service.js';
import { createInMemorySessionEventStore } from '@weave/session';
import {
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';
import { createSkillCatalogService } from '../src/skill-catalog.js';

const input: AgentRunRequest = {
  sessionId: 'skills-agent',
  provider: 'scripted',
  model: 'fixture',
  skills: [],
  userMessage: { role: 'user', content: [{ type: 'text', text: 'Plan the work' }] },
};
async function drain(iterable: AsyncIterable<unknown>) {
  for await (const event of iterable) void event;
}
describe('Skills through the real Server Agent', () => {
  it('prepares bounded catalog, loads instructions and resources through shared Pipeline and records delivery', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    const projects = createInMemoryProjectStore();
    const sessionService = createSessionService({
      projectStore: projects,
      sessionStore: getServerSessionStore(runtime),
    });
    const project = await projects.createProject({ name: 'Skills', folderName: 'skills' });
    const session = await sessionService.create(project.id);
    const calls: LlmRequest[] = [];
    let exactRef: { id: string; instructionSha256: string; bundleSha256: string };
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream(request) {
          calls.push(request);
          const name =
            calls.length === 1
              ? 'read_skill'
              : calls.length === 2
                ? 'read_skill_resource'
                : undefined;
          if (name !== undefined) {
            yield { type: 'tool-call-start', id: `read-${calls.length}`, name };
            yield {
              type: 'tool-call-delta',
              id: `read-${calls.length}`,
              argumentsDelta: JSON.stringify({
                skill: exactRef,
                ...(name === 'read_skill_resource' ? { path: 'references/planning.md' } : {}),
              }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            yield { type: 'text-delta', text: 'planned' };
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime);
      const catalog = await createSkillCatalogService({
        current: () => runtime.serverHost.controller()?.current(),
      }).catalog(session.id);
      const { id, instructionSha256, bundleSha256 } = catalog.entries[0]!;
      exactRef = { id, instructionSha256, bundleSha256 };
      await drain(runner.run({ ...input, sessionId: session.id }));
      expect(calls).toHaveLength(3);
      expect(JSON.stringify(calls[0])).toContain('Skill catalog');
      expect(JSON.stringify(calls[2])).toContain('Planning checklist');
      const log = await getServerSessionStore(runtime).read(session.id);
      expect(log.filter((event) => event.type === 'skill.applied')).toHaveLength(1);
      const detail = await sessionService.get(session.id);
      expect(detail.turns[0]?.request).toMatchObject({
        provider: 'scripted',
        model: 'fixture',
        permissionMode: 'ask',
      });
      expect(
        detail.messages.find((message) => message.messageId === detail.turns[0]?.userMessageId)
          ?.turnId,
      ).toBe(detail.turns[0]?.turnId);
      expect(detail.turns[0]?.skills).toMatchObject({
        requested: [],
        failures: [],
        applications: [{ skill: { id: exactRef.id }, invocation: 'model', delivery: 'delivered' }],
      });
      expect(log.filter((event) => event.type === 'tool-result.created')).toHaveLength(2);
      expect(log.findIndex((event) => event.type === 'skill.applied')).toBeLessThan(
        log.findIndex((event) => event.type === 'tool-result.created'),
      );
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await projects.close();
    }
  });
  it('preserves real tool-call attribution for recoverable Skill failures in Session detail', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    const projects = createInMemoryProjectStore();
    const service = createSessionService({
      projectStore: projects,
      sessionStore: getServerSessionStore(runtime),
    });
    const project = await projects.createProject({ name: 'Failure', folderName: 'failure' });
    const session = await service.create(project.id);
    let calls = 0;
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream() {
          calls++;
          if (calls === 1) {
            yield { type: 'tool-call-start', id: 'missing-skill-call', name: 'read_skill' };
            yield {
              type: 'tool-call-delta',
              id: 'missing-skill-call',
              argumentsDelta: JSON.stringify({
                skill: {
                  id: 'builtin:missing',
                  instructionSha256: 'a'.repeat(64),
                  bundleSha256: 'b'.repeat(64),
                },
              }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime);
      await drain(runner.run({ ...input, sessionId: session.id }));
      expect((await service.get(session.id)).turns[0]?.skills?.failures).toEqual([
        {
          skill: {
            id: 'builtin:missing',
            instructionSha256: 'a'.repeat(64),
            bundleSha256: 'b'.repeat(64),
          },
          stage: 'load',
          code: 'skill-not-found',
          toolCallId: 'missing-skill-call',
        },
      ]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
      await projects.close();
    }
  });
  it('fails stop when plugin around middleware fabricates a successful loader result', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    let calls = 0;
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream() {
          calls++;
          yield { type: 'tool-call-start', id: 'fabricated', name: 'read_skill' };
          yield { type: 'tool-call-delta', id: 'fabricated', argumentsDelta: '{}' };
          yield { type: 'finish', reason: 'tool-call' };
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [
          definePlugin({
            manifest: {
              id: 'fabricator',
              name: 'Fabricator',
              version: '1.0.0',
              apiVersion: '1.0.0',
              capabilities: ['tool'],
              contributes: { hooks: ['weave.tools.around'] },
            },
            setup(env) {
              env.onHook(toolAroundHook, async (request) => ({
                name: request.name,
                toolCallId: request.toolCallId,
                content: '{}',
                truncated: false,
              }));
            },
          }),
        ],
      });
      await expect(drain(runner.run(input))).rejects.toMatchObject({ code: 'skill-audit-failed' });
      expect(calls).toBe(1);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('stops before the next model call when loader audit append fails', async () => {
    const base = createInMemorySessionEventStore();
    let rejectApplied = false;
    const runtime = createServerRuntime({
      sessionStoreFactory: () => ({
        ...base,
        async append(sessionId, events) {
          if (rejectApplied && events.some((event) => event.type === 'skill.applied'))
            throw new Error('audit disk full');
          return base.append(sessionId, events);
        },
      }),
    });
    await runtime.start();
    let calls = 0;
    let exactRef: { id: string; instructionSha256: string; bundleSha256: string };
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream() {
          calls++;
          rejectApplied = true;
          yield { type: 'tool-call-start', id: 'failed-audit', name: 'read_skill' };
          yield {
            type: 'tool-call-delta',
            id: 'failed-audit',
            argumentsDelta: JSON.stringify({ skill: exactRef }),
          };
          yield { type: 'finish', reason: 'tool-call' };
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime);
      const catalog = await createSkillCatalogService({
        current: () => runtime.serverHost.controller()?.current(),
      }).catalog(input.sessionId);
      const { id, instructionSha256, bundleSha256 } = catalog.entries[0]!;
      exactRef = { id, instructionSha256, bundleSha256 };
      await expect(drain(runner.run(input))).rejects.toMatchObject({ code: 'skill-audit-failed' });
      expect(calls).toBe(1);
      expect(
        (await base.read(input.sessionId)).filter((event) => event.type === 'skill.applied'),
      ).toHaveLength(0);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});

describe('admitted Skills and Generation replacement', () => {
  it('keeps admitted old Skill text while a queued selection checks its exact refs in the new generation', async () => {
    const { skillsExtensionPoint } = await import('@weave/plugin');
    const { assembleServerGeneration, commitServerGeneration } = await import('../src/runtime.js');
    const runtime = createServerRuntime();
    await runtime.start();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: LlmRequest[] = [];
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream(request) {
          requests.push(request);
          entered.resolve();
          await release.promise;
          yield { type: 'finish', reason: 'stop' };
        },
      },
    });
    const plugin = (instructions: string) =>
      definePlugin({
        manifest: {
          id: 'generation-skill',
          name: 'Generation Skill',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['skill'],
          contributes: { skills: ['versioned'] },
        },
        setup(env) {
          env.contribute(skillsExtensionPoint, (api) =>
            api.addSkill({ name: 'versioned', description: 'Versioned', instructions }),
          );
        },
      });
    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [plugin('old generation instructions')],
      });
      const catalog = await createSkillCatalogService({
        current: () => runtime.serverHost.controller()?.current(),
      }).catalog(input.sessionId);
      const { id, instructionSha256, bundleSha256 } = catalog.entries.find(
        (entry) => entry.source.kind === 'plugin',
      )!;
      const request = { ...input, skills: [{ id, instructionSha256, bundleSha256 }] };
      const active = runner.run(request)[Symbol.asyncIterator]();
      const first = active.next();
      await entered.promise;
      const queued = runner.run(request)[Symbol.asyncIterator]();
      const second = queued.next().then(
        () => undefined,
        (error: unknown) => error,
      );
      const candidate = await assembleServerGeneration(runtime, {
        kernelPlugins: [plugin('new generation instructions')],
      });
      commitServerGeneration(runtime, candidate);
      release.resolve();
      await first;
      expect(await second).toMatchObject({ code: 'skill-source-changed' });
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0])).toContain('old generation instructions');
      expect(JSON.stringify(requests[0])).not.toContain('new generation instructions');
      await active.return?.();
      await queued.return?.();
    } finally {
      release.resolve();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});

describe('Skill pages under the actual Runtime budgets', () => {
  it('keeps accepted pages intact through both Pipeline and model context with custom small caps', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    let calls = 0;
    let intact = false;
    let exactRef: { id: string; instructionSha256: string; bundleSha256: string };
    runtime.serverHost.hostProviderRegistry.register({
      id: 'scripted',
      label: 'Scripted',
      type: 'mock',
      client: {
        async *stream(request) {
          calls++;
          if (calls === 1) {
            yield { type: 'tool-call-start', id: 'budget', name: 'read_skill' };
            yield {
              type: 'tool-call-delta',
              id: 'budget',
              argumentsDelta: JSON.stringify({ skill: exactRef }),
            };
            yield { type: 'finish', reason: 'tool-call' };
          } else {
            const message = request.messages.find((message) => message.role === 'tool');
            const text =
              message?.content
                .filter((part) => part.type === 'text')
                .map((part) => part.text)
                .join('') ?? '';
            const page = JSON.parse(text) as { eof: boolean; text: string };
            intact =
              page.text.length > 0 && Buffer.byteLength(text) <= 800 && !text.includes('省略');
            yield { type: 'finish', reason: 'stop' };
          }
        },
      },
    });
    try {
      const runner = await createServerAgentRunner(runtime, {
        toolResultMaxBytes: 800,
        context: { maxToolResultTokens: 160 },
      });
      const catalog = await createSkillCatalogService({
        current: () => runtime.serverHost.controller()?.current(),
      }).catalog(input.sessionId);
      const { id, instructionSha256, bundleSha256 } = catalog.entries[0]!;
      exactRef = { id, instructionSha256, bundleSha256 };
      await drain(runner.run(input));
      expect(calls).toBe(2);
      expect(intact).toBe(true);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
