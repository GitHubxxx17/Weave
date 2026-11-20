import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createLlmProviderRegistry } from '@weave/llm';
import type { LlmRequest, StreamEvent } from '@weave/protocol';
import { definePlugin, promptSectionsExtensionPoint, type KernelPlugin } from '@weave/plugin';
import type { AgentRunner } from '@weave/runtime';
import {
  createInMemorySessionEventStore,
  type SessionEvent,
  type SessionEventStore,
} from '@weave/session';
import {
  appliedPromptSections,
  createPromptAudit,
  PromptAuditError,
  type AppliedPromptSection,
} from '../src/prompt-audit.js';
import {
  createServerAgentRunner,
  assembleServerGeneration,
  replaceServerGeneration,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
} from '../src/runtime.js';

const sessionId = 'prompt-audit-session';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function section(id: string, pluginId: string, text: string): AppliedPromptSection {
  return { id, pluginId, text };
}

function eventsOfType<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
): readonly Extract<SessionEvent, { type: T }>[] {
  return log.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

const auditTypes = (log: readonly SessionEvent[]): string[] =>
  log.map((event) => event.type).filter((type) => type.startsWith('prompt.'));

describe('appliedPromptSections', () => {
  it('trims each text, drops blank sections and keeps the order given', () => {
    expect(
      appliedPromptSections([
        { id: 'first', order: 1, text: '  Be brief.\n', pluginId: 'style-kit' },
        { id: 'blank', order: 2, text: ' \n\t ', pluginId: 'style-kit' },
        { id: 'second', order: 3, text: 'Ask first.', pluginId: 'safety-kit' },
      ]),
    ).toEqual([
      { id: 'first', pluginId: 'style-kit', text: 'Be brief.' },
      { id: 'second', pluginId: 'safety-kit', text: 'Ask first.' },
    ]);
  });

  it('refuses a section that does not say which plugin contributed it', () => {
    expect(() => appliedPromptSections([{ id: 'orphan', order: 1, text: 'Hello.' }])).toThrow(
      /Prompt section "orphan" does not name the plugin/,
    );
  });
});

describe('createPromptAudit', () => {
  const tone = section('tone', 'style-kit', 'Be brief.');
  const care = section('care', 'safety-kit', '中文提示');

  it('writes the text of each section, then the set in effect for the turn', async () => {
    const store = createInMemorySessionEventStore();

    await createPromptAudit({ store, sections: [tone, care] }).record({
      sessionId,
      turnId: 'turn-1',
    });

    const log = await store.read(sessionId);
    expect(log.map((event) => event.type)).toEqual([
      'prompt.section-content',
      'prompt.section-content',
      'prompt.sections-applied',
    ]);
    expect(log[0]?.payload).toEqual({ sha256: sha256('Be brief.'), text: 'Be brief.' });
    expect(log[1]?.payload).toEqual({ sha256: sha256('中文提示'), text: '中文提示' });
    expect(log[2]?.payload).toEqual({
      turnId: 'turn-1',
      sections: [
        { id: 'tone', pluginId: 'style-kit', sha256: sha256('Be brief.'), bytes: 9 },
        { id: 'care', pluginId: 'safety-kit', sha256: sha256('中文提示'), bytes: 12 },
      ],
    });
    await store.close();
  });

  it('writes nothing more while the set does not change', async () => {
    const store = createInMemorySessionEventStore();
    const audit = createPromptAudit({ store, sections: [tone, care] });

    await audit.record({ sessionId, turnId: 'turn-1' });
    await audit.record({ sessionId, turnId: 'turn-2' });
    await audit.record({ sessionId, turnId: 'turn-3' });

    expect(auditTypes(await store.read(sessionId))).toHaveLength(3);
    await store.close();
  });

  it('reads what the log already holds, so a restart does not write it again', async () => {
    const store = createInMemorySessionEventStore();
    await createPromptAudit({ store, sections: [tone, care] }).record({
      sessionId,
      turnId: 'turn-1',
    });

    await createPromptAudit({ store, sections: [tone, care] }).record({
      sessionId,
      turnId: 'turn-2',
    });

    expect(auditTypes(await store.read(sessionId))).toHaveLength(3);
    await store.close();
  });

  it('writes a changed set with only the text that is new', async () => {
    const store = createInMemorySessionEventStore();
    await createPromptAudit({ store, sections: [tone, care] }).record({
      sessionId,
      turnId: 'turn-1',
    });
    const longer = section('tone', 'style-kit', 'Be very brief.');

    await createPromptAudit({ store, sections: [longer, care] }).record({
      sessionId,
      turnId: 'turn-2',
    });

    const log = await store.read(sessionId);
    expect(auditTypes(log).slice(3)).toEqual(['prompt.section-content', 'prompt.sections-applied']);
    expect(eventsOfType(log, 'prompt.section-content').map((event) => event.payload.text)).toEqual([
      'Be brief.',
      '中文提示',
      'Be very brief.',
    ]);
    expect(eventsOfType(log, 'prompt.sections-applied').at(-1)?.payload).toMatchObject({
      turnId: 'turn-2',
      sections: [
        { id: 'tone', sha256: sha256('Be very brief.'), bytes: 14 },
        { id: 'care', sha256: sha256('中文提示') },
      ],
    });
    await store.close();
  });

  it('records a change in order as a change, because order is the order of the prompt', async () => {
    const store = createInMemorySessionEventStore();
    await createPromptAudit({ store, sections: [tone, care] }).record({
      sessionId,
      turnId: 'turn-1',
    });

    await createPromptAudit({ store, sections: [care, tone] }).record({
      sessionId,
      turnId: 'turn-2',
    });

    const log = await store.read(sessionId);
    expect(auditTypes(log).slice(3)).toEqual(['prompt.sections-applied']);
    expect(
      eventsOfType(log, 'prompt.sections-applied')
        .at(-1)
        ?.payload.sections.map((entry) => entry.id),
    ).toEqual(['care', 'tone']);
    await store.close();
  });

  it('records that no sections apply any more, once, and nothing before any were recorded', async () => {
    const store = createInMemorySessionEventStore();
    const none = createPromptAudit({ store, sections: [] });

    await none.record({ sessionId, turnId: 'turn-0' });
    expect(await store.read(sessionId)).toEqual([]);

    await createPromptAudit({ store, sections: [tone] }).record({ sessionId, turnId: 'turn-1' });
    await none.record({ sessionId, turnId: 'turn-2' });
    await none.record({ sessionId, turnId: 'turn-3' });

    const log = await store.read(sessionId);
    expect(auditTypes(log)).toEqual([
      'prompt.section-content',
      'prompt.sections-applied',
      'prompt.sections-applied',
    ]);
    expect(eventsOfType(log, 'prompt.sections-applied').at(-1)?.payload).toEqual({
      turnId: 'turn-2',
      sections: [],
    });
    await store.close();
  });

  it('does not write again a text the log already holds when a set returns', async () => {
    const store = createInMemorySessionEventStore();
    await createPromptAudit({ store, sections: [tone] }).record({ sessionId, turnId: 'turn-1' });
    await createPromptAudit({ store, sections: [] }).record({ sessionId, turnId: 'turn-2' });

    await createPromptAudit({ store, sections: [tone] }).record({ sessionId, turnId: 'turn-3' });

    const log = await store.read(sessionId);
    expect(eventsOfType(log, 'prompt.section-content')).toHaveLength(1);
    expect(
      eventsOfType(log, 'prompt.sections-applied').map((event) => event.payload.turnId),
    ).toEqual(['turn-1', 'turn-2', 'turn-3']);
    await store.close();
  });

  it('writes a text once when two sections share it', async () => {
    const store = createInMemorySessionEventStore();

    await createPromptAudit({
      store,
      sections: [section('one', 'style-kit', 'Same.'), section('two', 'safety-kit', 'Same.')],
    }).record({ sessionId, turnId: 'turn-1' });

    const log = await store.read(sessionId);
    expect(eventsOfType(log, 'prompt.section-content')).toHaveLength(1);
    expect(
      eventsOfType(log, 'prompt.sections-applied')[0]?.payload.sections.map((entry) => entry.id),
    ).toEqual(['one', 'two']);
    await store.close();
  });

  it('compares with what the log holds now, so a set another recorder wrote is not mistaken for its own', async () => {
    const store = createInMemorySessionEventStore();
    const first = createPromptAudit({ store, sections: [tone] });
    const second = createPromptAudit({
      store,
      sections: [section('tone', 'style-kit', 'Be calm.')],
    });

    await first.record({ sessionId, turnId: 'turn-1' });
    await second.record({ sessionId, turnId: 'turn-2' });
    await first.record({ sessionId, turnId: 'turn-3' });

    const log = await store.read(sessionId);
    expect(
      eventsOfType(log, 'prompt.sections-applied').map((event) => event.payload.turnId),
    ).toEqual(['turn-1', 'turn-2', 'turn-3']);
    expect(eventsOfType(log, 'prompt.sections-applied').at(-1)?.payload.sections[0]?.sha256).toBe(
      sha256('Be brief.'),
    );
    // The text of the first set was already on record when it came back.
    expect(eventsOfType(log, 'prompt.section-content').map((event) => event.payload.text)).toEqual([
      'Be brief.',
      'Be calm.',
    ]);
    await store.close();
  });

  it('keeps each Session on its own record', async () => {
    const store = createInMemorySessionEventStore();
    const audit = createPromptAudit({ store, sections: [tone] });

    await audit.record({ sessionId: 'first', turnId: 'turn-1' });
    await audit.record({ sessionId: 'second', turnId: 'turn-1' });

    expect(auditTypes(await store.read('first'))).toHaveLength(2);
    expect(auditTypes(await store.read('second'))).toHaveLength(2);
    await store.close();
  });

  describe('when the Store fails', () => {
    function flakyStore(inner: SessionEventStore, failures: { appends: number; reads: number }) {
      const store: SessionEventStore = {
        append: (id, events) => {
          if (failures.appends > 0) {
            failures.appends -= 1;
            return Promise.reject(new Error('disk full'));
          }
          return inner.append(id, events);
        },
        read: (id, options) => {
          if (failures.reads > 0) {
            failures.reads -= 1;
            return Promise.reject(new Error('disk unreadable'));
          }
          return inner.read(id, options);
        },
        close: () => inner.close(),
      };
      return store;
    }

    it('reports a write that failed as a prompt audit error, and tries again next time', async () => {
      const inner = createInMemorySessionEventStore();
      const audit = createPromptAudit({
        store: flakyStore(inner, { appends: 1, reads: 0 }),
        sections: [tone],
      });

      const failure: unknown = await audit
        .record({ sessionId, turnId: 'turn-1' })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PromptAuditError);
      expect(failure).toMatchObject({
        code: 'prompt-audit-failed',
        cause: expect.objectContaining({ message: 'disk full' }),
      });
      expect(await inner.read(sessionId)).toEqual([]);

      await audit.record({ sessionId, turnId: 'turn-2' });
      expect(auditTypes(await inner.read(sessionId))).toEqual([
        'prompt.section-content',
        'prompt.sections-applied',
      ]);
      await inner.close();
    });

    it('reports a log that cannot be read the same way', async () => {
      const inner = createInMemorySessionEventStore();
      const audit = createPromptAudit({
        store: flakyStore(inner, { appends: 0, reads: 1 }),
        sections: [tone],
      });

      await expect(audit.record({ sessionId, turnId: 'turn-1' })).rejects.toMatchObject({
        code: 'prompt-audit-failed',
      });
      await audit.record({ sessionId, turnId: 'turn-2' });
      expect(auditTypes(await inner.read(sessionId))).toHaveLength(2);
      await inner.close();
    });
  });
});

describe('prompt audit in the Server', () => {
  function systemText(request: LlmRequest): string {
    const system = request.messages.find((message) => message.role === 'system');
    return system === undefined
      ? ''
      : system.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }

  function providerSettings(onRequest: (request: LlmRequest) => void | Promise<void>) {
    const registry = createLlmProviderRegistry([
      {
        id: 'mock',
        label: '本地演示',
        type: 'mock',
        client: {
          async *stream(request: LlmRequest): AsyncIterable<StreamEvent> {
            await onRequest(request);
            yield { type: 'text-delta', text: '完成' };
            yield { type: 'finish', reason: 'stop' };
          },
        },
        defaultModel: 'test-model',
      },
    ]);
    return { registry, providers: registry.list(), defaultProvider: 'mock' } as const;
  }

  async function runTurn(runner: AgentRunner, text: string): Promise<void> {
    const events: unknown[] = [];
    for await (const event of runner.run({
      sessionId,
      userMessage: { role: 'user', content: [{ type: 'text', text }] },
      provider: 'mock',
      model: 'test-model',
    })) {
      events.push(event);
    }
  }

  const sectionPlugin = (
    id: string,
    sections: readonly { id: string; order: number; text: string }[],
  ): KernelPlugin =>
    definePlugin({
      manifest: { id, name: id, version: '1.0.0', apiVersion: '1.0.0', capabilities: ['prompt'] },
      setup(env) {
        env.contribute(promptSectionsExtensionPoint, (api) => {
          for (const entry of sections) {
            api.addSection(entry);
          }
        });
      },
    });

  it('records the sections of a turn before the model sees them, as the prompt renders them', async () => {
    const holder: { store?: SessionEventStore } = {};
    const requests: { recorded: string[]; system: string }[] = [];
    const runtime = createServerRuntime({
      providerSettings: providerSettings(async (request) => {
        const log = (await holder.store?.read(sessionId)) ?? [];
        requests.push({ recorded: auditTypes(log), system: systemText(request) });
      }),
    });
    await runtime.start();
    const store = getServerSessionStore(runtime);
    holder.store = store;

    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [
          sectionPlugin('prompt-contributor', [
            // Contributed out of order, one padded and one blank, as the prompt would see them.
            { id: 'later', order: 20, text: '  [[LATER]]  ' },
            { id: 'blank', order: 15, text: '   ' },
            { id: 'earlier', order: 10, text: '[[EARLIER]]' },
          ]),
        ],
      });

      await runTurn(runner, '你好');

      const log = await store.read(sessionId);
      const started = eventsOfType(log, 'turn.started')[0];
      const applied = eventsOfType(log, 'prompt.sections-applied')[0];
      expect(applied?.payload).toEqual({
        turnId: started?.payload.turnId,
        sections: [
          {
            id: 'earlier',
            pluginId: 'prompt-contributor',
            sha256: sha256('[[EARLIER]]'),
            bytes: 11,
          },
          { id: 'later', pluginId: 'prompt-contributor', sha256: sha256('[[LATER]]'), bytes: 9 },
        ],
      });
      expect(applied?.sequence).toBeGreaterThan(started?.sequence ?? Number.POSITIVE_INFINITY);
      expect(
        eventsOfType(log, 'prompt.section-content').map((event) => event.payload.text),
      ).toEqual(['[[EARLIER]]', '[[LATER]]']);
      // The record was durable by the time the model was asked.
      expect(requests).toHaveLength(1);
      expect(requests[0]?.recorded).toEqual([
        'prompt.section-content',
        'prompt.section-content',
        'prompt.sections-applied',
      ]);
      expect(requests[0]?.system).toContain('[[EARLIER]]');
      expect(requests[0]?.system).toContain('[[LATER]]');
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('writes nothing when no plugin adds a section', async () => {
    const runtime = createServerRuntime({ providerSettings: providerSettings(() => undefined) });
    await runtime.start();
    const store = getServerSessionStore(runtime);

    try {
      await runTurn(await createServerAgentRunner(runtime), '你好');

      const log = await store.read(sessionId);
      expect(auditTypes(log)).toEqual([]);
      expect(eventsOfType(log, 'turn.completed')[0]?.payload.status).toBe('completed');
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('follows the plugins across turns, restarts, changes and removal', async () => {
    const runtime = createServerRuntime({ providerSettings: providerSettings(() => undefined) });
    await runtime.start();
    const store = getServerSessionStore(runtime);
    const brief = sectionPlugin('style-kit', [{ id: 'tone', order: 10, text: 'Be brief.' }]);
    const briefer = sectionPlugin('style-kit', [{ id: 'tone', order: 10, text: 'Be very brief.' }]);

    try {
      // Turns of one runner, then a new runner over the same Session as after a restart.
      const first = await createServerAgentRunner(runtime, { kernelPlugins: [brief] });
      await runTurn(first, 'one');
      await runTurn(first, 'two');
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [brief] }),
      );
      const restarted = await createServerAgentRunner(runtime);
      await runTurn(restarted, 'three');
      expect(auditTypes(await store.read(sessionId))).toEqual([
        'prompt.section-content',
        'prompt.sections-applied',
      ]);

      // The plugin changes its text: the new set and only the new text are written.
      await replaceServerGeneration(
        runtime,
        await assembleServerGeneration(runtime, { kernelPlugins: [briefer] }),
      );
      await runTurn(first, 'four');
      expect(auditTypes(await store.read(sessionId)).slice(2)).toEqual([
        'prompt.section-content',
        'prompt.sections-applied',
      ]);

      // The plugin is gone: the log says no sections apply from this turn on.
      await replaceServerGeneration(runtime, await assembleServerGeneration(runtime));
      await runTurn(first, 'five');
      const log = await store.read(sessionId);
      expect(auditTypes(log).slice(4)).toEqual(['prompt.sections-applied']);

      const applied = eventsOfType(log, 'prompt.sections-applied');
      expect(applied.map((event) => event.payload.sections.length)).toEqual([1, 1, 0]);
      // Each set names the turn it took effect for: the first, the fourth and the fifth.
      const turns = eventsOfType(log, 'turn.started').map((event) => event.payload.turnId);
      expect(turns).toHaveLength(5);
      expect(applied.map((event) => event.payload.turnId)).toEqual([turns[0], turns[3], turns[4]]);
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });

  it('fails the turn without calling the model when the record cannot be written', async () => {
    const inner = createInMemorySessionEventStore();
    const failing: SessionEventStore = {
      append: (id, events) =>
        events.some((event) => event.type.startsWith('prompt.'))
          ? Promise.reject(new Error('disk full'))
          : inner.append(id, events),
      read: (id, options) => inner.read(id, options),
      close: () => inner.close(),
    };
    let modelCalls = 0;
    const runtime = createServerRuntime({
      sessionStoreFactory: () => failing,
      providerSettings: providerSettings(() => {
        modelCalls += 1;
      }),
    });
    await runtime.start();

    try {
      const runner = await createServerAgentRunner(runtime, {
        kernelPlugins: [sectionPlugin('style-kit', [{ id: 'tone', order: 10, text: 'Be brief.' }])],
      });

      await expect(runTurn(runner, '你好')).rejects.toMatchObject({ code: 'prompt-audit-failed' });

      expect(modelCalls).toBe(0);
      const log = await inner.read(sessionId);
      expect(auditTypes(log)).toEqual([]);
      expect(eventsOfType(log, 'turn.completed')[0]?.payload).toMatchObject({
        status: 'failed',
        reason: 'prompt-audit-failed',
      });
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
