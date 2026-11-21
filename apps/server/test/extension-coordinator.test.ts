import { PluginError, toolsExtensionPoint, type KernelPlugin } from '@weave/plugin';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { createExtensionCoordinator } from '../src/extension-coordinator.js';
import type {
  ExtensionAuthorityObserver,
  ExtensionSource,
  ExtensionSourceSnapshot,
} from '../src/extension-types.js';
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
  recheckFailure: Error | undefined;
  onPreparationAbort: (() => void) | undefined;
  onPreparedDispose: (() => void | Promise<void>) | undefined;
  onSnapshot: (() => void) | undefined;
  recheckValid = true;

  constructor(readonly id: string) {}

  private snapshot(): ExtensionSourceSnapshot {
    this.onSnapshot?.();
    return {
      stamp: { revision: this.revision, trustSequence: this.revision },
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
        this.attempts.push([...excluded]);
        const onPreparationAbort = this.onPreparationAbort;
        const onPreparedDispose = this.onPreparedDispose;
        if (onPreparationAbort)
          signal.addEventListener('abort', onPreparationAbort, { once: true });
        const recheck = async () => {
          if (this.recheckFailure) throw this.recheckFailure;
          this.onRecheck?.();
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
          items: [{ pluginId: this.id, identity, plugin, dispose }],
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
    this.identity = identity;
    this.revision += 1;
    this.observer?.(this.id, { snapshot: this.snapshot(), affectedIds: [this.id], immediate });
    await this.afterDecision?.();
  }

  onRecheck: (() => void) | undefined;
}

async function fixture(...sources: FixtureSource[]) {
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
