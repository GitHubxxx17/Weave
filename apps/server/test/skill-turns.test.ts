import { describe, expect, it } from 'vitest';
import { createInMemorySessionEventStore, projectSession } from '@weave/session';
import { createAgentRunner } from '@weave/runtime';
import { createGenerationSkillCatalog } from '../src/skill-catalog.js';
import { createTurnSkillController } from '../src/skill-turns.js';
import { withSkillAuditPipeline } from '../src/skill-audit.js';

async function fixture() {
  const store = createInMemorySessionEventStore();
  const catalog = createGenerationSkillCatalog({
    generation: 1,
    userDirectory: false,
    pluginSkills: [],
  });
  const observation = await catalog.observe('s');
  const { id, instructionSha256, bundleSha256 } = observation.catalog.entries[0]!;
  const ref = { id, instructionSha256, bundleSha256 };
  const controller = createTurnSkillController({ catalog, store, generation: 1 });
  const abort = new AbortController();
  return {
    store,
    catalog,
    ref,
    controller,
    abort,
    context: {
      sessionId: 's',
      turnId: 't',
      permissionMode: 'ask' as const,
      skills: [],
      signal: abort.signal,
      maxToolResultTokens: 8000,
    },
  };
}
describe('turn Skill state and required audit', () => {
  it.each(['prepare', 'selection-failure', 'model-eof'] as const)(
    'settles an already started %s audit append before persisting Runner cancellation',
    async (stage) => {
      const f = await fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const expectedType =
        stage === 'prepare'
          ? 'skill.catalog-applied'
          : stage === 'selection-failure'
            ? 'skill.failed'
            : 'skill.applied';
      const store = {
        ...f.store,
        async append(...args: Parameters<typeof f.store.append>) {
          if (args[1].some((event) => event.type === expectedType)) {
            entered.resolve();
            await release.promise;
          }
          return f.store.append(...args);
        },
      };
      const controller = createTurnSkillController({
        catalog: f.catalog,
        generation: 1,
        store,
      });
      let signal: AbortSignal | undefined;
      const runner = createAgentRunner({
        sessionStore: store,
        instructions: async (context) => {
          signal = context.signal;
          const prepared = await controller.prepare(context);
          if (stage === 'model-eof') {
            const scope = { ...context, toolCallId: 'c' };
            const page = await controller.read({ skill: f.ref }, scope);
            await controller.commitReceipt(controller.pendingReceipt(scope)!, {
              name: 'read_skill',
              toolCallId: 'c',
              content: JSON.stringify(page),
              truncated: false,
            });
          }
          return prepared.text;
        },
        llm: {
          async *stream() {
            yield { type: 'finish', reason: 'stop' };
          },
        },
      });
      const events = runner.run({
        sessionId: 's',
        provider: 'mock',
        model: 'test',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'Plan' }] },
        skills: stage === 'selection-failure' ? [{ ...f.ref, bundleSha256: 'c'.repeat(64) }] : [],
      });
      const iterator = events[Symbol.asyncIterator]();
      try {
        const next = iterator.next();
        await entered.promise;
        const returned = iterator.return!();
        expect(signal?.aborted).toBe(true);
        expect((await f.store.read('s')).some((event) => event.type === 'turn.completed')).toBe(
          false,
        );
        release.resolve();
        await returned;
        await next;
        const events = await f.store.read('s');
        const auditIndex = events.findIndex((event) => event.type === expectedType);
        const terminalIndex = events.findIndex((event) => event.type === 'turn.completed');
        expect(auditIndex).toBeGreaterThanOrEqual(0);
        expect(auditIndex).toBeLessThan(terminalIndex);
        expect(events.slice(terminalIndex + 1)).toEqual([]);
        expect(projectSession(events).turns[0]?.status).toBe('cancelled');
      } finally {
        release.resolve();
        await iterator.return?.();
        f.abort.abort();
        await controller.drain();
        await f.store.close();
      }
    },
  );
  it.each(['prepare', 'selection-failure', 'model-eof'] as const)(
    'does not append %s Skill facts after cancellation while audit reads the log',
    async (stage) => {
      const f = await fixture();
      await f.store.append('s', [
        { type: 'session.created', payload: {} },
        { type: 'turn.started', payload: { turnId: 't' } },
        { type: 'step.started', payload: { turnId: 't', stepId: 'm', kind: 'model' } },
      ]);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let holdRead = false;
      const controller = createTurnSkillController({
        catalog: f.catalog,
        generation: 1,
        store: {
          ...f.store,
          async read(...args) {
            if (holdRead) {
              entered.resolve();
              await release.promise;
            }
            return f.store.read(...args);
          },
        },
      });
      try {
        if (stage === 'model-eof') await controller.prepare(f.context);
        holdRead = true;
        const context = { sessionId: 's', turnId: 't', toolCallId: 'c', signal: f.abort.signal };
        const operation =
          stage === 'model-eof'
            ? (async () => {
                const page = await controller.read({ skill: f.ref }, context);
                await controller.commitReceipt(controller.pendingReceipt(context)!, {
                  name: 'read_skill',
                  toolCallId: 'c',
                  content: JSON.stringify(page),
                  truncated: false,
                });
              })()
            : controller.prepare({
                ...f.context,
                skills:
                  stage === 'selection-failure' ? [{ ...f.ref, bundleSha256: 'c'.repeat(64) }] : [],
              });
        const outcome = operation.then(
          () => undefined,
          (error: unknown) => error,
        );
        await entered.promise;
        f.abort.abort();
        await f.store.append('s', [
          {
            type: 'step.completed',
            payload: { turnId: 't', stepId: 'm', status: 'cancelled' },
          },
          { type: 'turn.completed', payload: { turnId: 't', status: 'cancelled' } },
        ]);
        release.resolve();
        expect(await outcome).toBeDefined();
        const events = await f.store.read('s');
        const end = events.findIndex((event) => event.type === 'turn.completed');
        expect(events.slice(end + 1)).toEqual([]);
        expect(projectSession(events).turns[0]?.status).toBe('cancelled');
      } finally {
        release.resolve();
        f.abort.abort();
        await controller.drain();
        await f.store.close();
      }
    },
  );
  it('records explicit selections and clears scope synchronously at turn end', async () => {
    const f = await fixture();
    expect((await f.controller.prepare({ ...f.context, skills: [f.ref] })).text).toContain(
      'update_plan',
    );
    expect((await f.store.read('s')).map((event) => event.type)).toEqual([
      'skill.content',
      'skill.catalog-applied',
      'skill.applied',
    ]);
    f.abort.abort();
    await expect(
      f.controller.read(
        { skill: f.ref },
        { signal: new AbortController().signal, sessionId: 's', turnId: 't', toolCallId: 'c' },
      ),
    ).rejects.toMatchObject({ code: 'skill-unavailable' });
    await f.controller.drain();
    await f.store.close();
  });
  it('activates only after successful outer audit and confines resources to the real turn', async () => {
    const f = await fixture();
    await f.controller.prepare(f.context);
    const context = { signal: f.abort.signal, sessionId: 's', turnId: 't', toolCallId: 'c' };
    await expect(
      f.controller.readResource({ skill: f.ref, path: 'references/planning.md' }, context),
    ).rejects.toMatchObject({ code: 'skill-not-invocable' });
    const pipeline = withSkillAuditPipeline(
      {
        async execute(request) {
          const page = await f.controller.read({ skill: f.ref }, context);
          return {
            name: request.name,
            toolCallId: request.toolCallId,
            content: JSON.stringify(page),
            truncated: false,
          };
        },
      },
      f.controller,
    );
    await pipeline.execute({
      name: 'read_skill',
      toolCallId: 'c',
      sessionId: 's',
      turnId: 't',
      arguments: '{}',
    });
    expect(
      (
        await f.controller.readResource(
          { skill: f.ref, path: 'references/planning.md' },
          { ...context, toolCallId: 'r' },
        )
      ).text,
    ).toContain('completed');
    expect(
      (await f.store.read('s')).filter((event) => event.type === 'skill.applied'),
    ).toHaveLength(1);
    await expect(
      f.controller.read({ skill: f.ref }, { ...context, turnId: 'other' }),
    ).rejects.toMatchObject({ code: 'skill-unavailable' });
    f.abort.abort();
    await f.controller.drain();
    await f.store.close();
  });

  it('rejects advancing past a page that middleware did not return and audit', async () => {
    const store = createInMemorySessionEventStore();
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      userDirectory: false,
      pluginSkills: [
        {
          pluginId: 'long',
          name: 'long',
          description: 'Long instructions',
          instructions: 'body '.repeat(4000),
        },
      ],
    });
    const observed = await catalog.observe('s');
    const { id, instructionSha256, bundleSha256 } = observed.catalog.entries[0]!;
    const ref = { id, instructionSha256, bundleSha256 };
    const controller = createTurnSkillController({
      catalog,
      store,
      generation: 1,
      maxToolResultBytes: 1000,
    });
    const abort = new AbortController();
    await controller.prepare({
      sessionId: 's',
      turnId: 't',
      signal: abort.signal,
      skills: [],
      permissionMode: 'ask',
      maxToolResultTokens: 8000,
    });
    const context = { sessionId: 's', turnId: 't', toolCallId: 'c', signal: abort.signal };
    const first = await controller.read({ skill: ref }, context);
    expect(first.eof).toBe(false);
    await expect(
      controller.read({ skill: ref, cursor: first.nextCursor }, context),
    ).rejects.toMatchObject({ code: 'skill-invalid-input' });
    expect((await store.read('s')).filter((event) => event.type === 'skill.applied')).toHaveLength(
      0,
    );
    abort.abort();
    await controller.drain();
    await store.close();
  });
  it('replays acknowledged cursors deterministically and activates only after contiguous EOF', async () => {
    const store = createInMemorySessionEventStore();
    const instructions = '中文😀 body\n'.repeat(800);
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      userDirectory: false,
      pluginSkills: [{ pluginId: 'pages', name: 'pages', description: 'Pages', instructions }],
    });
    const observed = await catalog.observe('s');
    const { id, instructionSha256, bundleSha256 } = observed.catalog.entries[0]!;
    const ref = { id, instructionSha256, bundleSha256 };
    const controller = createTurnSkillController({
      catalog,
      store,
      generation: 1,
      maxToolResultBytes: 1200,
    });
    const abort = new AbortController();
    await controller.prepare({
      sessionId: 's',
      turnId: 't',
      permissionMode: 'ask',
      signal: abort.signal,
      skills: [],
      maxToolResultTokens: 300,
    });
    let cursor: string | undefined;
    let content = '';
    let number = 0;
    do {
      const toolCallId = `page-${number++}`;
      const context = { sessionId: 's', turnId: 't', toolCallId, signal: abort.signal };
      const page = await controller.read(
        { skill: ref, ...(cursor === undefined ? {} : { cursor }) },
        context,
      );
      const result = {
        name: 'read_skill',
        toolCallId,
        content: JSON.stringify(page),
        truncated: false,
      };
      const receipt = controller.pendingReceipt(context)!;
      await controller.commitReceipt(receipt, result);
      if (cursor !== undefined)
        expect(
          await controller.read(
            { skill: ref, cursor },
            { ...context, toolCallId: `replay-${number}` },
          ),
        ).toEqual(page);
      content += page.text;
      cursor = page.nextCursor;
      if (!page.eof)
        expect(
          (await store.read('s')).filter((event) => event.type === 'skill.applied'),
        ).toHaveLength(0);
    } while (cursor !== undefined);
    expect(content).toBe(instructions);
    expect((await store.read('s')).filter((event) => event.type === 'skill.applied')).toHaveLength(
      1,
    );
    abort.abort();
    await controller.drain();
    await store.close();
  });
  it('separates user-only and model-only invocation policy and records safe failures', async () => {
    const store = createInMemorySessionEventStore();
    const catalog = createGenerationSkillCatalog({
      generation: 1,
      userDirectory: false,
      pluginSkills: [
        {
          pluginId: 'policy',
          name: 'user',
          description: 'User',
          instructions: 'user body',
          invocation: { user: true, model: false },
          resources: { 'ref.md': 'user resource' },
        },
        {
          pluginId: 'policy',
          name: 'model',
          description: 'Model',
          instructions: 'model body',
          invocation: { user: false, model: true },
        },
      ],
    });
    const observed = await catalog.observe('s');
    const refs = observed.catalog.entries
      .slice(0, 2)
      .map(({ id, instructionSha256, bundleSha256 }) => ({ id, instructionSha256, bundleSha256 }));
    const controller = createTurnSkillController({ catalog, store, generation: 1 });
    const abort = new AbortController();
    const base = {
      sessionId: 's',
      turnId: 't',
      signal: abort.signal,
      skills: [refs[0]!],
      permissionMode: 'ask' as const,
      maxToolResultTokens: 8000,
    };
    await controller.prepare(base);
    const context = { sessionId: 's', turnId: 't', signal: abort.signal, toolCallId: 'user-read' };
    await expect(controller.read({ skill: refs[0]! }, context)).rejects.toMatchObject({
      code: 'skill-not-invocable',
    });
    expect(
      (
        await controller.readResource(
          { skill: refs[0]!, path: 'ref.md' },
          { ...context, toolCallId: 'resource' },
        )
      ).text,
    ).toBe('user resource');
    await expect(
      controller.prepare({ ...base, turnId: 'other', skills: [refs[1]!] }),
    ).rejects.toMatchObject({ code: 'skill-not-invocable' });
    expect((await store.read('s')).filter((event) => event.type === 'skill.failed')).toHaveLength(
      2,
    );
    abort.abort();
    await controller.drain();
    await store.close();
  });
  it('awaits actual accepted resource settlement when a turn is cancelled', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const catalog = {
      ...f.catalog,
      async pin(...args: Parameters<typeof f.catalog.pin>) {
        const pinned = await f.catalog.pin(...args);
        return {
          ...pinned,
          async readResource() {
            entered.resolve();
            await release.promise;
            return { text: 'late', sha256: 'd'.repeat(64) };
          },
        };
      },
    };
    const controller = createTurnSkillController({ catalog, store: f.store, generation: 1 });
    await controller.prepare({ ...f.context, skills: [f.ref] });
    const reading = controller
      .readResource(
        { skill: f.ref, path: 'references/planning.md' },
        { sessionId: 's', turnId: 't', toolCallId: 'r', signal: f.abort.signal },
      )
      .then(
        () => 'resolved',
        () => 'rejected',
      );
    await entered.promise;
    f.abort.abort();
    let drained = false;
    const draining = controller.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    expect(await reading).toBe('rejected');
    await draining;
    expect(drained).toBe(true);
    await f.store.close();
  });
  it('does not accept an abandoned earlier result after a later loader execution fails', async () => {
    const f = await fixture();
    await f.controller.prepare(f.context);
    const context = { signal: f.abort.signal, sessionId: 's', turnId: 't', toolCallId: 'c' };
    const pipeline = withSkillAuditPipeline(
      {
        async execute(request) {
          const earlier = await f.controller.read({ skill: f.ref }, context);
          try {
            await f.controller.read({ skill: { ...f.ref, bundleSha256: 'c'.repeat(64) } }, context);
          } catch {
            /* middleware retries and suppresses failure */
          }
          return {
            name: request.name,
            toolCallId: request.toolCallId,
            content: JSON.stringify(earlier),
            truncated: false,
          };
        },
      },
      f.controller,
    );
    await expect(
      pipeline.execute({
        name: 'read_skill',
        toolCallId: 'c',
        sessionId: 's',
        turnId: 't',
        arguments: '{}',
      }),
    ).rejects.toMatchObject({ code: 'skill-audit-failed' });
    expect(
      (await f.store.read('s')).filter((event) => event.type === 'skill.applied'),
    ).toHaveLength(0);
    f.abort.abort();
    await f.controller.drain();
    await f.store.close();
  });
  it('rejects fabricated loader success and fails stop on required persistence failure', async () => {
    const f = await fixture();
    await f.controller.prepare(f.context);
    const fabricated = withSkillAuditPipeline(
      {
        async execute(request) {
          return {
            name: request.name,
            toolCallId: request.toolCallId,
            content: '{}',
            truncated: false,
          };
        },
      },
      f.controller,
    );
    await expect(
      fabricated.execute({
        name: 'read_skill',
        toolCallId: 'fake',
        sessionId: 's',
        turnId: 't',
        arguments: '{}',
      }),
    ).rejects.toMatchObject({ code: 'skill-audit-failed' });
    f.abort.abort();
    await f.controller.drain();
    await f.store.close();
    const failing = await fixture();
    await failing.controller.prepare(failing.context);
    const original = failing.store.append;
    failing.store.append = async () => {
      throw new Error('disk full');
    };
    const pipeline = withSkillAuditPipeline(
      {
        async execute(request) {
          const page = await failing.controller.read(
            { skill: failing.ref },
            { signal: failing.abort.signal, sessionId: 's', turnId: 't', toolCallId: 'c' },
          );
          return {
            name: request.name,
            toolCallId: request.toolCallId,
            content: JSON.stringify(page),
            truncated: false,
          };
        },
      },
      failing.controller,
    );
    await expect(
      pipeline.execute({
        name: 'read_skill',
        toolCallId: 'c',
        sessionId: 's',
        turnId: 't',
        arguments: '{}',
      }),
    ).rejects.toMatchObject({ code: 'skill-audit-failed' });
    failing.store.append = original;
    failing.abort.abort();
    await failing.controller.drain();
    await failing.store.close();
  });
});
