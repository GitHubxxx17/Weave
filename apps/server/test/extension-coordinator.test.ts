import { createServer } from 'node:http';
import { PluginError, toolsExtensionPoint, type KernelPlugin } from '@weave/plugin';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import {
  createExtensionCoordinator,
  type ExtensionMutationContext,
} from '../src/extension-coordinator.js';
import type {
  ExtensionAuthorityChange,
  ExtensionAuthorityObserver,
  ExtensionSource,
  ExtensionSourceFactory,
  ExtensionSourceSnapshot,
} from '../src/extension-types.js';
import { ExtensionPreparationError } from '../src/extension-types.js';
import { createManagedAuthorityObserverBuffer } from '../src/managed-plugin-composition.js';
import { createServerShutdown } from '../src/server-shutdown.js';
import {
  assembleServerGeneration,
  createServerAgentRunner,
  createServerRuntime,
  disposeServerPlugins,
  getServerSessionStore,
  listServerPlugins,
} from '../src/runtime.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class FixtureSource {
  private revision = 0;
  private trustSequence = 0;
  private identity: string | undefined = 'first';
  private observer: ExtensionAuthorityObserver | undefined;
  readonly close = vi.fn(async () => {});
  readonly attempts: string[][] = [];
  readonly disposers: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = [];
  onSetup: (() => void | Promise<void>) | undefined;
  onTool: ((signal: AbortSignal) => void | Promise<void>) | undefined;
  onDispose: (() => void | Promise<void>) | undefined;
  onRefresh: (() => void | Promise<void>) | undefined;
  afterDecision: (() => Promise<void>) | undefined;
  appendFailure: Error | undefined;
  prepareFailure: Error | undefined;
  recheckFailure: Error | undefined;
  onPreparationAbort: (() => void) | undefined;
  onPreparedDispose: (() => void | Promise<void>) | undefined;
  onSnapshot: (() => void) | undefined;
  recheckValid = true;
  ready = true;
  includeInstanceId = false;

  constructor(readonly id: string) {}

  snapshot(): ExtensionSourceSnapshot {
    this.onSnapshot?.();
    return {
      stamp: { revision: this.revision, trustSequence: this.trustSequence },
      eligible: this.identity === undefined ? [] : [{ pluginId: this.id, identity: this.identity }],
    };
  }

  register = (observer: ExtensionAuthorityObserver): ExtensionSource => {
    this.observer = observer;
    return {
      id: this.id,
      snapshot: () => this.snapshot(),
      refresh: async () => {
        await this.onRefresh?.();
      },
      prepare: async (stamp, { excluded, signal }) => {
        if (this.prepareFailure !== undefined) throw this.prepareFailure;
        this.attempts.push([...excluded]);
        const onPreparationAbort = this.onPreparationAbort;
        const onPreparedDispose = this.onPreparedDispose;
        if (onPreparationAbort)
          signal.addEventListener('abort', onPreparationAbort, { once: true });
        const recheck = async () => {
          if (this.recheckFailure) throw this.recheckFailure;
          await this.onRecheck?.();
          return this.recheckValid;
        };
        const disposePrepared = async () => {
          if (onPreparationAbort) signal.removeEventListener('abort', onPreparationAbort);
          await onPreparedDispose?.();
        };
        const identity = this.identity;
        if (identity === undefined || excluded.has(identity)) {
          return {
            stamp,
            items: [],
            failures: [],
            recheck,
            dispose: disposePrepared,
          };
        }
        const onSetup = this.onSetup;
        const onTool = this.onTool;
        const onDispose = this.onDispose;
        const resourceDisposer = vi.fn(async () => {
          await onDispose?.();
        });
        this.disposers.push(resourceDisposer);
        let disposal: Promise<void> | undefined;
        const dispose = () => (disposal ??= resourceDisposer());
        const toolName = this.id.replaceAll('-', '_');
        const plugin: KernelPlugin = {
          manifest: {
            id: this.id,
            name: this.id,
            version: '1.0.0',
            apiVersion: '1.0.0',
            capabilities: ['tool'],
            contributes: { tools: [toolName] },
          },
          async setup(env) {
            await onSetup?.();
            env.contribute(toolsExtensionPoint, (api) =>
              api.addTool({
                name: toolName,
                description: 'Read the fixture generation',
                parameters: { type: 'object' },
                inputSchema: z.object({}),
                async execute(_input, context) {
                  await onTool?.(context.signal);
                  return identity;
                },
              }),
            );
          },
          dispose,
        };
        return {
          stamp,
          items: [
            {
              pluginId: this.id,
              identity,
              plugin,
              dispose,
              isReady: () => this.ready,
              ...(this.includeInstanceId
                ? { instanceId: `${this.id}:attempt-${this.attempts.length}` }
                : {}),
            },
          ],
          failures: [],
          recheck,
          async dispose() {
            await dispose();
            await disposePrepared();
          },
        };
      },
      close: this.close,
    };
  };

  async decide(identity: string | undefined, immediate = false): Promise<void> {
    if (this.appendFailure) throw this.appendFailure;
    this.publish(this.stageDecision(identity, immediate));
    await this.afterDecision?.();
  }

  stageDecision(identity: string | undefined, immediate = false): ExtensionAuthorityChange {
    this.identity = identity;
    this.revision += 1;
    this.trustSequence += 1;
    return { snapshot: this.snapshot(), affectedIds: [this.id], immediate };
  }

  stageValidatedSequence(): ExtensionAuthorityChange {
    this.trustSequence += 1;
    return { snapshot: this.snapshot(), affectedIds: [], immediate: false };
  }

  publish(change: ExtensionAuthorityChange): void {
    this.observer?.(this.id, change);
  }

  onRecheck: (() => void | Promise<void>) | undefined;
}

async function fixture(...sources: Array<{ readonly register: ExtensionSourceFactory }>) {
  return fixtureWithAuthorityOrder(false, ...sources);
}

async function fixtureWithAuthorityOrder(
  mcpFirstAuthority: boolean,
  ...sources: Array<{ readonly register: ExtensionSourceFactory }>
) {
  const runtime = createServerRuntime();
  await runtime.start();
  const runner = await createServerAgentRunner(runtime);
  for (const sessionId of ['old-turn', 'new-turn']) {
    await getServerSessionStore(runtime).append(sessionId, [
      { type: 'session.created', payload: { title: sessionId } },
    ]);
  }
  let failAssembly = false;
  const coordinator = createExtensionCoordinator({
    host: runtime.serverHost,
    sources: sources.map((source) => source.register),
    mcpFirstAuthority,
    assemble: async (kernelPlugins) => {
      if (failAssembly) throw new Error('Shared assembly failed');
      return assembleServerGeneration(runtime, { kernelPlugins });
    },
  });
  const app = createApp(runtime, {
    pluginCatalog: () => listServerPlugins(runtime),
    generationSnapshot: coordinator.generationSnapshot,
  });
  return {
    coordinator,
    runtime,
    runner,
    failAssembly(value: boolean) {
      failAssembly = value;
    },
    ids: () => listServerPlugins(runtime).map((plugin) => plugin.id),
    async getPlugins() {
      return (await app.request('/plugins')).json();
    },
    async turn(id: string, sessionId = 'new-turn') {
      const events = [];
      for await (const event of runner.run({
        sessionId,
        provider: 'mock',
        model: 'test',
        userMessage: {
          role: 'user',
          content: [{ type: 'text', text: `/tool ${id.replaceAll('-', '_')} {}` }],
        },
      })) {
        events.push(event);
      }
      return events;
    },
    async close() {
      try {
        await coordinator.dispose();
      } finally {
        await disposeServerPlugins(runtime);
        await runtime.stop();
      }
    },
  };
}

function toolContent(content: string) {
  return expect.objectContaining({
    type: 'tool-result',
    result: expect.objectContaining({ content }),
  });
}

describe('Server extension coordination', () => {
  it('discards pending changes and stamps after a paired callback throws', async () => {
    const local = new FixtureSource('local-esm');
    const mcp = new FixtureSource('mcp');
    const publish = vi.fn();
    const buffer = createManagedAuthorityObserverBuffer(publish);
    const f = await fixture(
      { register: buffer.wrapSource(local.register) },
      { register: buffer.wrapSource(mcp.register) },
    );
    try {
      const localChange = local.stageDecision(undefined);
      const mcpChange = mcp.stageDecision(undefined);
      expect(() =>
        buffer.runSync(() => {
          local.publish(localChange);
          mcp.publish(mcpChange);
          throw new Error('Authority reconciliation failed');
        }),
      ).toThrow('Authority reconciliation failed');
      expect(publish).not.toHaveBeenCalled();
      buffer.runSync(() => {
        local.publish(localChange);
        mcp.publish(mcpChange);
      });
      expect(publish).toHaveBeenCalledExactlyOnceWith(
        new Map([
          [local.id, localChange],
          [mcp.id, mcpChange],
        ]),
      );
    } finally {
      await f.close();
    }
  });

  it.each(['setup', 'readiness'])(
    'validates MCP before the next local preparation after an attributed %s failure',
    async (failure) => {
      const local = new FixtureSource('local-esm');
      const mcp = new FixtureSource('mcp');
      const calls: string[] = [];
      local.onRefresh = () => {
        calls.push('local refresh');
      };
      mcp.onRefresh = () => {
        calls.push('mcp refresh');
      };
      local.onRecheck = () => {
        calls.push('local recheck');
      };
      mcp.onRecheck = () => {
        calls.push('mcp recheck');
      };
      const f = await fixtureWithAuthorityOrder(
        true,
        {
          register(observe) {
            const source = local.register(observe);
            return {
              ...source,
              prepare(stamp, options) {
                calls.push('local prepare');
                return source.prepare(stamp, options);
              },
            };
          },
        },
        mcp,
      );
      if (failure === 'setup') {
        mcp.onSetup = () => {
          throw new Error('MCP setup failed');
        };
      } else {
        mcp.ready = false;
      }
      try {
        const result = await f.coordinator.reload();
        expect(result.failed).toHaveLength(1);
        expect(result.members.map(({ pluginId }) => pluginId)).toEqual([local.id]);
        expect(calls.slice(0, 2)).toEqual(['mcp refresh', 'local refresh']);
        const firstPrepare = calls.indexOf('local prepare');
        const lastPrepare = calls.lastIndexOf('local prepare');
        expect(calls.slice(firstPrepare + 1, lastPrepare)).toContain('mcp refresh');
        expect(calls.slice(-2)).toEqual(['mcp recheck', 'local recheck']);
      } finally {
        await f.close();
      }
    },
  );

  it('discards unchanged-stamp metadata and retains a change from an earlier stamp in a pair', async () => {
    const local = new FixtureSource('local-esm');
    const mcp = new FixtureSource('mcp');
    const batches: Array<ReadonlyMap<string, ExtensionAuthorityChange>> = [];
    const buffer = createManagedAuthorityObserverBuffer((changes) => {
      batches.push(changes);
      f.coordinator.observeAuthorityBatchSync(changes);
    });
    const f = await fixture(
      { register: buffer.wrapSource(local.register) },
      { register: buffer.wrapSource(mcp.register) },
    );
    const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
    const started = deferred();
    const released = deferred();
    const observed: unknown[] = [];
    local.onTool = (signal) => {
      signal.addEventListener(
        'abort',
        () => {
          observed.push({
            local: local.snapshot().eligible,
            mcp: mcp.snapshot().eligible,
            acceptingRuns: f.coordinator.generationSnapshot().acceptingRuns,
          });
          buffer.runSync(() => local.publish(local.stageValidatedSequence()));
          released.resolve();
        },
        { once: true },
      );
      started.resolve();
      return released.promise;
    };
    try {
      await f.coordinator.reload();
      local.publish({ snapshot: local.snapshot(), affectedIds: [local.id], immediate: true });
      buffer.runSync(() => {
        local.publish({ snapshot: local.snapshot(), affectedIds: [local.id], immediate: true });
        local.publish(local.stageValidatedSequence());
      });
      expect(abort).not.toHaveBeenCalled();
      expect(f.coordinator.generationSnapshot().acceptingRuns).toBe(true);
      expect(batches[0]?.get(local.id)).toEqual({
        snapshot: local.snapshot(),
        affectedIds: [],
        immediate: false,
      });
      const turn = f.turn(local.id);
      await started.promise;
      buffer.runSync(() => {
        local.publish(local.stageDecision('first', true));
        local.publish(local.stageValidatedSequence());
        mcp.publish(mcp.stageDecision(undefined));
      });
      expect(observed).toEqual([
        {
          local: [{ pluginId: 'local-esm', identity: 'first' }],
          mcp: [],
          acceptingRuns: false,
        },
      ]);
      expect(abort).toHaveBeenCalledOnce();
      expect(batches[1]?.get(local.id)).toEqual({
        snapshot: {
          stamp: { revision: 1, trustSequence: 3 },
          eligible: [{ pluginId: 'local-esm', identity: 'first' }],
        },
        affectedIds: [local.id],
        immediate: true,
      });
      expect(batches[2]?.get(local.id)?.snapshot.stamp).toEqual({
        revision: 1,
        trustSequence: 4,
      });
      await turn;
    } finally {
      released.resolve();
      abort.mockRestore();
      await f.close();
    }
  });

  it('blocks admission for the entire authority batch before synchronously aborting runs', async () => {
    const local = new FixtureSource('local-esm');
    const mcp = new FixtureSource('mcp');
    const started = deferred();
    const released = deferred();
    const observed: unknown[] = [];
    const f = await fixture(local, mcp);
    const abort = vi.spyOn(f.runtime.serverHost.controller()!, 'abortActiveRuns');
    local.onTool = (signal) => {
      signal.addEventListener(
        'abort',
        () => {
          observed.push({
            local: local.snapshot().eligible,
            mcp: mcp.snapshot().eligible,
            acceptingRuns: f.coordinator.generationSnapshot().acceptingRuns,
          });
          released.resolve();
        },
        { once: true },
      );
      started.resolve();
      return released.promise;
    };
    try {
      await f.coordinator.reload();
      const turn = f.turn(local.id);
      await started.promise;
      const localChange = local.stageDecision('first', true);
      const mcpChange = mcp.stageDecision(undefined, true);
      f.coordinator.observeAuthorityBatchSync(
        new Map([
          [local.id, localChange],
          [mcp.id, mcpChange],
        ]),
      );
      expect(observed).toEqual([
        {
          local: [{ pluginId: 'local-esm', identity: 'first' }],
          mcp: [],
          acceptingRuns: false,
        },
      ]);
      expect(abort).toHaveBeenCalledOnce();
      await turn;
    } finally {
      released.resolve();
      abort.mockRestore();
      await f.close();
    }
  });

  it('rebuilds identical membership only when reload or mutation explicitly forces it', async () => {
    const a = new FixtureSource('source-a');
    const f = await fixture(a);
    try {
      const first = await f.coordinator.reload();
      expect((await f.coordinator.reload()).unchanged).toBe(true);
      expect(a.attempts).toHaveLength(1);
      const reloaded = await f.coordinator.reload({ force: true });
      expect(reloaded.unchanged).toBe(false);
      expect(reloaded.generation.id).toBeGreaterThan(first.generation.id);
      const mutated = await f.coordinator.mutate(a.id, async () => {}, { force: true });
      expect(mutated.generation.id).toBeGreaterThan(reloaded.generation.id);
      expect(a.attempts).toHaveLength(3);
      expect(await f.turn(a.id)).toContainEqual(toolContent('first'));
    } finally {
      await f.close();
    }
  });

  it.each([true, false])(
    'preserves forced intent when pending reloads coalesce (%s first)',
    async (forceFirst) => {
      const a = new FixtureSource('source-a');
      const f = await fixture(a);
      try {
        const first = await f.coordinator.reload();
        const pending = f.coordinator.reload({ force: forceFirst });
        const coalesced = f.coordinator.reload({ force: !forceFirst });
        expect(coalesced).toBe(pending);
        const result = await pending;
        expect(result.unchanged).toBe(false);
        expect(result.generation.id).toBeGreaterThan(first.generation.id);
        expect(a.attempts).toHaveLength(2);
      } finally {
        await f.close();
      }
    },
  );

  it('queues a forced reload separately when an ordinary reload has already started', async () => {
    const a = new FixtureSource('source-a');
    const entered = deferred();
    const release = deferred();
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      a.onRefresh = async () => {
        entered.resolve();
        await release.promise;
      };
      const ordinary = f.coordinator.reload();
      await entered.promise;
      const forced = f.coordinator.reload({ force: true });
      expect(forced).not.toBe(ordinary);
      release.resolve();
      expect((await ordinary).unchanged).toBe(true);
      expect((await forced).unchanged).toBe(false);
      expect(a.attempts).toHaveLength(2);
    } finally {
      release.resolve();
      await f.close();
    }
  });

  it('excludes a connection closed while another source rechecks and freshly prepares survivors', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const recheckEntered = deferred();
    const recheckRelease = deferred();
    const f = await fixture(a, b);
    try {
      await f.coordinator.reload();
      b.onRecheck = async () => {
        recheckEntered.resolve();
        await recheckRelease.promise;
      };
      const updating = f.coordinator.reload({ force: true });
      await recheckEntered.promise;
      a.ready = false;
      recheckRelease.resolve();
      const result = await updating;
      expect(result.failed).toEqual([
        {
          sourceId: a.id,
          pluginId: a.id,
          identity: 'first',
          error: {
            code: 'plugin-load-failed',
            message: 'Extension resource became unavailable before publication',
          },
        },
      ]);
      expect(f.ids()).not.toContain(a.id);
      expect(await f.turn(b.id)).toContainEqual(toolContent('first'));
      expect(a.attempts).toEqual([[], [], ['first']]);
      expect(b.attempts).toEqual([[], [], []]);
      expect(b.disposers[1]).toHaveBeenCalledOnce();
      expect(b.disposers[2]).not.toHaveBeenCalled();
    } finally {
      recheckRelease.resolve();
      await f.close();
    }
  });

  it('retains exact current and pinned generation instances until preparation cleanup settles', async () => {
    const a = new FixtureSource('source-a');
    a.includeInstanceId = true;
    const turnEntered = deferred();
    const turnRelease = deferred();
    a.onTool = async () => {
      turnEntered.resolve();
      await turnRelease.promise;
    };
    const f = await fixture(a);
    try {
      const first = await f.coordinator.reload();
      const oldTurn = f.turn(a.id, 'old-turn');
      await turnEntered.promise;
      a.onTool = undefined;
      const second = await f.coordinator.reload({ force: true });
      expect(f.coordinator.retainedGenerations()).toEqual([
        {
          generationId: first.generation.id,
          current: false,
          members: [expect.objectContaining({ instanceId: 'source-a:attempt-1' })],
        },
        {
          generationId: second.generation.id,
          current: true,
          members: [expect.objectContaining({ instanceId: 'source-a:attempt-2' })],
        },
      ]);
      const external = f.coordinator.retainedGenerations();
      (external[0]!.members as unknown[]).splice(0);
      expect(f.coordinator.retainedGenerations()[0]!.members).toHaveLength(1);
      turnRelease.resolve();
      await oldTurn;
      await vi.waitFor(() => expect(f.coordinator.retainedGenerations()).toHaveLength(1));
      expect(f.coordinator.retainedGenerations()[0]!.generationId).toBe(second.generation.id);
    } finally {
      turnRelease.resolve();
      await f.close();
    }
  });

  it('keeps generation ownership metadata when preparation cleanup fails', async () => {
    const a = new FixtureSource('source-a');
    a.includeInstanceId = true;
    a.onPreparedDispose = async () => {
      throw new Error('resource close failed');
    };
    const f = await fixture(a);
    try {
      const first = await f.coordinator.reload();
      a.onPreparedDispose = undefined;
      const second = await f.coordinator.reload({ force: true });
      expect(f.coordinator.retainedGenerations()).toMatchObject([
        { generationId: first.generation.id, current: false },
        { generationId: second.generation.id, current: true },
      ]);
    } finally {
      await expect(f.close()).rejects.toBeInstanceOf(AggregateError);
    }
  });

  it('returns a resource preparation failure while preserving the current pointer and admission', async () => {
    const a = new FixtureSource('source-a');
    const f = await fixture(a);
    try {
      const initial = await f.coordinator.reload();
      a.prepareFailure = new ExtensionPreparationError();
      const result = await f.coordinator.reload({ force: true });
      expect(result.generation).toEqual(initial.generation);
      expect(result.members).toEqual(initial.members);
      expect(result.error).toEqual({
        code: 'plugin-reload-failed',
        message: 'Extension resources are unavailable for this generation',
      });
      expect(await f.turn(a.id)).toContainEqual(toolContent('first'));
      const revoked = await f.coordinator.mutate(a.id, () => a.decide('replacement'), {
        force: true,
      });
      expect(revoked.generation).toMatchObject({
        id: initial.generation.id,
        acceptingRuns: false,
        blocked: { code: 'plugin-generation-blocked' },
      });
      expect(revoked.error?.code).toBe('plugin-reload-failed');
      a.prepareFailure = new Error('authority read failed');
      await expect(f.coordinator.reload({ force: true })).rejects.toBe(a.prepareFailure);
      expect(f.coordinator.generationSnapshot()).toEqual(revoked.generation);
    } finally {
      await f.close();
    }
  });

  it('queues two sources through one publisher while a pinned turn keeps its original tool', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const oldTurnEntered = deferred();
    const oldTurnRelease = deferred();
    a.onTool = async () => {
      oldTurnEntered.resolve();
      await oldTurnRelease.promise;
    };
    const setupEntered = deferred();
    const setupRelease = deferred();
    const f = await fixture(a, b);
    try {
      await f.coordinator.reload();
      const oldTurn = f.turn(a.id, 'old-turn');
      await oldTurnEntered.promise;
      a.onTool = undefined;
      a.onSetup = async () => {
        setupEntered.resolve();
        await setupRelease.promise;
      };
      const first = f.coordinator.mutate(a.id, () => a.decide('updated-a'));
      await setupEntered.promise;
      const second = f.coordinator.mutate(b.id, () => b.decide('updated-b'));
      expect(f.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      expect(f.ids()).toEqual(expect.arrayContaining([a.id, b.id]));
      setupRelease.resolve();
      await first;
      await second;
      expect(f.coordinator.runner).toBe(f.runner);
      expect(await f.turn(a.id)).toContainEqual(toolContent('updated-a'));
      expect(await f.turn(b.id)).toContainEqual(toolContent('updated-b'));
      expect(a.disposers[0]).not.toHaveBeenCalled();
      oldTurnRelease.resolve();
      expect(await oldTurn).toContainEqual(toolContent('first'));
    } finally {
      setupRelease.resolve();
      oldTurnRelease.resolve();
      await f.close();
    }
    expect(a.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(b.disposers.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
  });

  it('blocks synchronously after a durable revoke and keeps it applied across failure and another source mutation', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const decisionRecorded = deferred();
    const afterDecision = deferred();
    const f = await fixture(a, b);
    try {
      await f.coordinator.reload();
      const generation = f.coordinator.generationSnapshot().id;
      b.afterDecision = async () => {
        decisionRecorded.resolve();
        await afterDecision.promise;
      };
      f.failAssembly(true);
      const revoking = f.coordinator.mutate(b.id, () => b.decide(undefined));
      await decisionRecorded.promise;
      await expect(f.turn(b.id)).rejects.toMatchObject({ code: 'plugin-generation-blocked' });
      expect(await f.getPlugins()).toMatchObject({
        generation: {
          id: generation,
          acceptingRuns: false,
          blocked: { code: 'plugin-generation-blocked' },
        },
      });
      afterDecision.resolve();
      await expect(revoking).resolves.toMatchObject({
        generation: { id: generation, acceptingRuns: false },
        error: { code: 'plugin-reload-failed' },
      });
      expect(f.ids()).toContain(b.id);
      f.failAssembly(false);
      await f.coordinator.mutate(a.id, () => a.decide('updated-a'));
      expect(f.ids()).not.toContain(b.id);
      expect(await f.turn(a.id)).toContainEqual(toolContent('updated-a'));
    } finally {
      afterDecision.resolve();
      await f.close();
    }
  });

  it('keeps admission open when a durable append fails', async () => {
    const a = new FixtureSource('source-a');
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      const generation = f.coordinator.generationSnapshot();
      a.appendFailure = new Error('append failed');
      await expect(f.coordinator.mutate(a.id, () => a.decide(undefined, true))).rejects.toBe(
        a.appendFailure,
      );
      expect(f.coordinator.generationSnapshot()).toEqual(generation);
      expect(await f.turn(a.id)).toContainEqual(toolContent('first'));
    } finally {
      await f.close();
    }
  });

  it('retains the block when a source observes external revocation before discovery fails', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const f = await fixture(a, b);
    try {
      await f.coordinator.reload();
      const generation = f.coordinator.generationSnapshot().id;
      const failure = new Error('directory unreadable');
      b.onRefresh = async () => {
        await b.decide(undefined);
        throw failure;
      };
      await expect(f.coordinator.reload()).rejects.toBe(failure);
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: generation,
        acceptingRuns: false,
      });
      b.onRefresh = undefined;
      b.recheckFailure = new Error('authority could not be rechecked');
      await expect(f.coordinator.reload()).rejects.toBe(b.recheckFailure);
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: generation,
        acceptingRuns: false,
      });
      b.recheckFailure = undefined;
      b.recheckValid = false;
      await f.coordinator.reload();
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: generation,
        acceptingRuns: false,
      });
      b.recheckValid = true;
      await f.coordinator.reload();
      expect(f.ids()).not.toContain(b.id);
      expect(f.coordinator.generationSnapshot().acceptingRuns).toBe(true);
    } finally {
      await f.close();
    }
  });

  it('cancels the in-flight candidate and turns before waiting for cleanup, then closes the source', async () => {
    const a = new FixtureSource('source-a');
    const onTurnAbort = deferred();
    const turnStarted = deferred();
    a.onTool = (signal) => {
      signal.addEventListener('abort', onTurnAbort.resolve, { once: true });
      turnStarted.resolve();
      return onTurnAbort.promise;
    };
    const setupStarted = deferred();
    const setupRelease = deferred();
    const onCandidateAbort = vi.fn();
    const disposePrepared = vi.fn();
    a.onPreparedDispose = disposePrepared;
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      const original = (await f.getPlugins()) as { generation: { id: number } };
      const turn = f.turn(a.id, 'old-turn');
      await turnStarted.promise;
      a.onPreparationAbort = onCandidateAbort;
      a.onSetup = () => {
        setupStarted.resolve();
        return setupRelease.promise;
      };
      const mutating = f.coordinator
        .mutate(a.id, () => a.decide('next'))
        .catch((error: unknown) => error);
      await setupStarted.promise;
      const queued = f.coordinator.reload().catch((error: unknown) => error);
      const stopping = f.coordinator.dispose();
      expect(onCandidateAbort).toHaveBeenCalledOnce();
      await onTurnAbort.promise;
      await expect(queued).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await expect(f.turn(a.id)).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      expect(a.close).not.toHaveBeenCalled();
      setupRelease.resolve();
      await expect(mutating).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await turn;
      await stopping;
      expect(disposePrepared).toHaveBeenCalledTimes(2);
      expect(a.close).toHaveBeenCalledOnce();
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: original.generation.id,
        acceptingRuns: false,
      });
    } finally {
      setupRelease.resolve();
      await f.close();
    }
  });

  it('keeps consumers live through an incomplete owned barrier and drains before release on retry', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const turnStarted = deferred();
    const turnAborted = deferred();
    const operationStarted = deferred();
    const operationRelease = deferred();
    const firstQuiesce = deferred();
    const secondQuiesce = deferred();
    const terminalStarted = deferred();
    const terminalRelease = deferred();
    const calls: string[] = [];
    const server = createServer();
    vi.spyOn(server, 'closeAllConnections').mockImplementation(() => {
      calls.push('idle-sse');
    });
    const quiescenceFailure = new Error('Could not confirm quiescence');
    a.onTool = (signal) => {
      signal.addEventListener('abort', turnAborted.resolve, { once: true });
      turnStarted.resolve();
      return turnAborted.promise;
    };
    a.onDispose = () => {
      calls.push('generation');
    };
    a.close.mockImplementation(async () => {
      calls.push('source-a');
    });
    b.close.mockImplementation(async () => {
      calls.push('source-b');
    });
    const f = await fixture(a, b);
    const store = getServerSessionStore(f.runtime);
    const append = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (id, events) => {
      if (events.some((event) => event.type === 'turn.completed')) {
        terminalStarted.resolve();
        await terminalRelease.promise;
        const result = await append(id, events);
        calls.push('terminal');
        return result;
      }
      return append(id, events);
    });
    let context: ExtensionMutationContext | undefined;
    let reentered: Promise<void> | undefined;
    let attempts = 0;
    let stopped = false;
    try {
      const shutdown = createServerShutdown({
        resources: () => ({
          server,
          coordinator: f.coordinator,
          owned: {
            async quiesce() {
              calls.push('quiesce');
              attempts += 1;
              if (attempts === 1) {
                await firstQuiesce.promise;
                throw quiescenceFailure;
              }
              await secondQuiesce.promise;
            },
            async close() {
              calls.push('release');
            },
          },
          authority: {
            async close() {
              calls.push('authority');
            },
          },
        }),
        async disposeHost() {
          calls.push('host');
          await disposeServerPlugins(f.runtime);
        },
        async stopRuntime() {
          calls.push('runtime');
          await f.runtime.stop();
        },
        closeProjectStore() {
          calls.push('project');
        },
        closeProviderSettingsStore() {
          calls.push('provider');
        },
        closeManualTrustStore() {},
        closeMcpAuthorityStore() {
          calls.push('mcp');
        },
      });
      await f.coordinator.reload();
      const turn = f.turn(a.id, 'old-turn');
      await turnStarted.promise;
      const running = f.coordinator
        .mutate(a.id, async (mutationContext) => {
          context = mutationContext;
          context.assertOpenSync();
          context.signal.addEventListener(
            'abort',
            () => {
              reentered = shutdown.stop();
            },
            { once: true },
          );
          operationStarted.resolve();
          await operationRelease.promise;
          context.assertOpenSync();
        })
        .catch((cause: unknown) => cause);
      await operationStarted.promise;
      const queued = f.coordinator.reload().catch((cause: unknown) => cause);

      const first = shutdown.stop();
      const failedStop = first.catch((cause: unknown) => cause);
      expect(shutdown.stop()).toBe(first);
      expect(reentered).toBe(first);
      expect(context?.signal.aborted).toBe(true);
      expect(f.coordinator.generationSnapshot().acceptingRuns).toBe(false);
      await expect(queued).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await expect(f.turn(a.id)).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      expect(calls).toEqual(['quiesce']);
      firstQuiesce.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(shutdown.stop()).toBe(first);
      expect(calls).toEqual(['quiesce']);
      expect(a.disposers[0]).not.toHaveBeenCalled();
      operationRelease.resolve();
      await expect(running).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      const failure = await failedStop;
      expect(failure).toBe(quiescenceFailure);
      expect(calls).toEqual(['quiesce']);
      expect(f.runtime.status).toBe('running');

      const second = shutdown.stop();
      expect(second).not.toBe(first);
      expect(calls).toEqual(['quiesce', 'quiesce']);
      secondQuiesce.resolve();
      await terminalStarted.promise;
      expect(calls).toEqual(['quiesce', 'quiesce']);
      expect(f.runtime.status).toBe('running');
      terminalRelease.resolve();
      await turn;
      await second;
      stopped = true;
      expect(calls).toEqual([
        'quiesce',
        'quiesce',
        'terminal',
        'generation',
        'source-b',
        'source-a',
        'host',
        'idle-sse',
        'runtime',
        'project',
        'provider',
        'mcp',
        'release',
        'authority',
      ]);
    } finally {
      operationRelease.resolve();
      firstQuiesce.resolve();
      secondQuiesce.resolve();
      terminalRelease.resolve();
      turnAborted.resolve();
      if (!stopped) await f.close();
    }
  });

  it('aborts pending setup immediately and awaits its settlement before draining active turns', async () => {
    const a = new FixtureSource('source-a');
    const turnStarted = deferred();
    const turnAborted = deferred();
    const setupStarted = deferred();
    const setupRelease = deferred();
    const generationDisposal = new Error('Generation disposition failed');
    const onCandidateAbort = vi.fn();
    const f = await fixture(a);
    a.onTool = (signal) => {
      signal.addEventListener('abort', turnAborted.resolve, { once: true });
      turnStarted.resolve();
      return turnAborted.promise;
    };
    try {
      await expect(f.coordinator.drainOwnedConsumers(async () => {})).rejects.toThrow();
      await f.coordinator.reload();
      const turn = f.turn(a.id, 'old-turn');
      await turnStarted.promise;
      a.onPreparationAbort = onCandidateAbort;
      a.onSetup = () => {
        setupStarted.resolve();
        return setupRelease.promise;
      };
      a.onDispose = () => {
        throw generationDisposal;
      };
      const changing = f.coordinator
        .mutate(a.id, () => a.decide('next'))
        .catch((cause: unknown) => cause);
      await setupStarted.promise;
      f.coordinator.beginOwnedDrainSync();
      f.coordinator.beginOwnedDrainSync();
      expect(onCandidateAbort).toHaveBeenCalledOnce();

      const preDrain = vi.fn(async () => {});
      let reentered: Promise<unknown> | undefined;
      const draining = f.coordinator.drainOwnedConsumers(async () => {
        reentered = f.coordinator.drainOwnedConsumers(preDrain);
      });
      expect(reentered).toBe(draining);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(a.disposers[0]).not.toHaveBeenCalled();
      expect(a.close).not.toHaveBeenCalled();
      setupRelease.resolve();
      await expect(changing).resolves.toMatchObject({ code: 'plugin-host-disposed' });
      await turn;
      const result = await draining;
      expect(result).toMatchObject({
        kind: 'drained',
        cleanupCauses: expect.arrayContaining([generationDisposal]),
      });
      expect(f.coordinator.drainOwnedConsumers(preDrain)).toBe(draining);
      expect(preDrain).not.toHaveBeenCalled();
      expect(a.close).toHaveBeenCalledOnce();
    } finally {
      setupRelease.resolve();
      turnAborted.resolve();
      await f.runtime.stop();
    }
  });

  it('cancels turns pinned to retired generations on an immediate revocation', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    const oldToolStarted = deferred();
    const oldToolAborted = deferred();
    a.onTool = (signal) => {
      signal.addEventListener('abort', oldToolAborted.resolve, { once: true });
      oldToolStarted.resolve();
      return oldToolAborted.promise;
    };
    const f = await fixture(a, b);
    try {
      await f.coordinator.reload();
      const turn = f.turn(a.id, 'old-turn');
      await oldToolStarted.promise;
      await f.coordinator.mutate(b.id, () => b.decide('next'));
      expect(a.disposers[0]).not.toHaveBeenCalled();
      const revoking = f.coordinator.mutate(b.id, () => b.decide(undefined, true));
      await oldToolAborted.promise;
      await turn;
      await revoking;
      expect(a.disposers[0]).toHaveBeenCalledOnce();
      expect(f.ids()).not.toContain(b.id);
    } finally {
      oldToolAborted.resolve();
      await f.close();
    }
  });

  it('keeps the previous generation if a source snapshot synchronously closes the coordinator', async () => {
    const a = new FixtureSource('source-a');
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      const generation = f.coordinator.generationSnapshot().id;
      a.onRecheck = () => {
        a.onSnapshot = () => {
          void f.coordinator.dispose();
        };
      };
      await expect(f.coordinator.mutate(a.id, () => a.decide('next'))).rejects.toMatchObject({
        code: 'plugin-host-disposed',
      });
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: generation,
        acceptingRuns: false,
      });
    } finally {
      await f.close();
    }
  });

  it('excludes only the attributable failure, re-preparing healthy sources with fresh instances', async () => {
    const a = new FixtureSource('source-a');
    const b = new FixtureSource('source-b');
    a.onSetup = () => {
      throw new Error('source A setup failed');
    };
    const f = await fixture(a, b);
    try {
      const result = await f.coordinator.reload();
      expect(result.failed).toEqual([
        {
          sourceId: a.id,
          pluginId: a.id,
          identity: 'first',
          error: expect.objectContaining({ code: 'plugin-setup-failed' }),
        },
      ]);
      expect(a.attempts).toEqual([[], ['first']]);
      expect(b.attempts).toEqual([[], []]);
      expect(f.ids()).not.toContain(a.id);
      expect(await f.turn(b.id)).toContainEqual(toolContent('first'));
      expect(b.disposers[0]).toHaveBeenCalledOnce();
      expect(b.disposers[1]).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
    expect(b.disposers[1]).toHaveBeenCalledOnce();
  });

  it('retains the current pointer and membership when synchronous commit throws', async () => {
    const a = new FixtureSource('source-a');
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      const current = f.runtime.serverHost.controller()!.current();
      const commit = vi.spyOn(f.runtime.serverHost, 'commit').mockImplementationOnce(() => {
        throw new PluginError('plugin-registration-conflict', 'commit rejected');
      });
      const result = await f.coordinator.mutate(a.id, () => a.decide('next'));
      expect(commit).toHaveBeenCalledOnce();
      expect(result.error?.code).toBe('plugin-reload-failed');
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: current.id,
        acceptingRuns: false,
      });
      expect(f.runtime.serverHost.controller()!.current()).toBe(current);
      expect(a.disposers[0]).not.toHaveBeenCalled();
      expect(a.disposers[1]).toHaveBeenCalledOnce();
    } finally {
      await f.close();
    }
  });

  it('projects the new generation during slow retirement and keeps shutdown admission blocked', async () => {
    const a = new FixtureSource('source-a');
    const retired = deferred();
    const retireRelease = deferred();
    a.onDispose = async () => {
      retired.resolve();
      await retireRelease.promise;
    };
    const f = await fixture(a);
    try {
      await f.coordinator.reload();
      const previous = f.coordinator.generationSnapshot().id;
      a.onDispose = undefined;
      const updating = f.coordinator.mutate(a.id, () => a.decide('next'));
      await retired.promise;
      const current = f.runtime.serverHost.controller()!.current().id;
      expect(current).toBeGreaterThan(previous);
      expect(f.coordinator.retainedGenerations()).toMatchObject([
        { generationId: previous, current: false },
        { generationId: current, current: true },
      ]);
      expect(await f.getPlugins()).toMatchObject({
        generation: { id: current, acceptingRuns: true },
      });
      expect(await f.turn(a.id)).toContainEqual(toolContent('next'));
      const closing = f.coordinator.dispose();
      expect(f.coordinator.dispose()).toBe(closing);
      expect(await f.getPlugins()).toMatchObject({
        generation: {
          id: current,
          acceptingRuns: false,
          blocked: { code: 'plugin-host-disposed' },
        },
      });
      await expect(f.coordinator.reload()).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      expect(a.close).not.toHaveBeenCalled();
      retireRelease.resolve();
      await updating;
      await closing;
      expect(f.coordinator.generationSnapshot()).toMatchObject({
        id: current,
        acceptingRuns: false,
      });
      expect(a.close).toHaveBeenCalledOnce();
    } finally {
      retireRelease.resolve();
      await f.close();
    }
  });
});
