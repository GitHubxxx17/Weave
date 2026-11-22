import { describe, expect, it, vi } from 'vitest';
import {
  createServerRuntime,
  createServerAgentRunner,
  assembleServerGeneration,
  disposeServerPlugins,
} from '../src/runtime.js';
import { createHostUiAuthority } from '../src/plugin-panel-authority.js';
import { createPanelService } from '../src/plugin-panel-service.js';
import { definePlugin, panelsExtensionPoint } from '@weave/plugin';
const plugin = definePlugin({
  manifest: {
    id: 'quality',
    name: 'Quality',
    version: '1.0.0',
    apiVersion: '1.0.0',
    capabilities: ['panel'],
    contributes: { panels: ['report'] },
  },
  setup(env) {
    env.contribute(panelsExtensionPoint, (api) =>
      api.addPanel({
        schemaVersion: 1,
        id: 'report',
        title: 'Report',
        icon: 'info',
        placement: 'right',
        sources: [],
        blocks: [{ id: 'heading', type: 'heading', text: 'Quality' }],
      }),
    );
  },
});
describe('current-only host publication authority', () => {
  it.each(['retirement', 'listener'] as const)(
    'does not overwrite C or notify later B observers after reentry from %s',
    async (mode) => {
      const runtime = createServerRuntime();
      await runtime.start();
      let authority: ReturnType<typeof createHostUiAuthority> | undefined;
      let service: ReturnType<typeof createPanelService> | undefined;
      try {
        await createServerAgentRunner(runtime, { kernelPlugins: [plugin] });
        const host = runtime.serverHost;
        authority = createHostUiAuthority(host, ['quality']);
        service = createPanelService({
          host,
          authority,
          sessionStore: runtime.get(host.sessionStoreService),
        });
        const a = host.controller()!.current();
        const old = service.catalog().panels[0]!.panelRef;
        const b = await assembleServerGeneration(runtime, { kernelPlugins: [plugin] });
        const c = await assembleServerGeneration(runtime, { kernelPlugins: [plugin] });
        const disposedB = vi.fn(b.dispose);
        const wrappedB = { ...b, dispose: disposedB };
        const notified: number[] = [];
        let inner: ReturnType<typeof host.commit> | undefined;
        let finish: (() => void) | undefined;
        let running: AsyncIterator<unknown> | undefined;
        if (mode === 'retirement') {
          const settled = Promise.withResolvers<IteratorResult<never>>();
          finish = () => settled.resolve({ done: true, value: undefined });
          a.runner.run = (request) => {
            request.signal!.addEventListener(
              'abort',
              () => {
                inner = host.commit(c);
                finish!();
              },
              { once: true },
            );
            return {
              [Symbol.asyncIterator]: () => ({
                next: () => settled.promise,
                return: async () => {
                  finish!();
                  return { done: true, value: undefined };
                },
              }),
            };
          };
          const iterable = host.controller()!.runner.run({
            sessionId: 'pinned',
            provider: 'mock',
            model: 'test',
            userMessage: { role: 'user', content: [{ type: 'text', text: 'test' }] },
          });
          running = iterable[Symbol.asyncIterator]();
          void running.next();
        } else
          host.subscribePublicationSync((snapshot) => {
            if (snapshot.generationId === b.id) inner = host.commit(c);
          });
        host.subscribePublicationSync((snapshot) => notified.push(snapshot.generationId));
        const outer = host.commit(wrappedB, { immediate: mode === 'retirement' });
        expect(host.controller()!.current().id).toBe(c.id);
        expect(host.currentPublicationSync()!.generationId).toBe(c.id);
        expect(notified).toEqual([c.id]);
        expect(service.catalog().generation).toBe(c.id);
        await expect(service.read('s', old, {})).rejects.toBeDefined();
        await running?.return?.();
        await outer.retirement;
        await inner?.retirement;
        await Promise.resolve();
        expect(disposedB).toHaveBeenCalledTimes(1);
      } finally {
        service?.closeSync();
        await service?.drain();
        authority?.closeSync();
        await disposeServerPlugins(runtime);
        await runtime.stop();
      }
    },
  );
  it('isolates throwing publication listeners and never implicitly trusts source-like later IDs', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    try {
      await createServerAgentRunner(runtime);
      const host = runtime.serverHost;
      const baseline = host.hostUiMembersSync();
      const candidate = await assembleServerGeneration(runtime, { kernelPlugins: [plugin] });
      host.subscribePublicationSync(() => {
        throw new Error('observer');
      });
      await host.publish(candidate);
      expect(host.currentPublicationSync()!.generationId).toBe(candidate.id);
      expect(host.hostUiMembersSync()).toBe(baseline);
      expect(() => createHostUiAuthority(host, ['quality'])).toThrow();
      const explicit = createHostUiAuthority(host, []);
      const observation = explicit.captureCurrentUiSync();
      expect(observation.members).toEqual([]);
      explicit.closeSync();
      expect(() => explicit.assertCurrentUiSync(observation)).toThrow();
    } finally {
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
  it('rejects obsolete refs during retirement before host observation', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    let service: ReturnType<typeof createPanelService> | undefined;
    let authority: ReturnType<typeof createHostUiAuthority> | undefined;
    try {
      await createServerAgentRunner(runtime, { kernelPlugins: [plugin] });
      const host = runtime.serverHost;
      authority = createHostUiAuthority(host, ['quality']);
      service = createPanelService({
        host,
        authority,
        sessionStore: runtime.get(host.sessionStoreService),
      });
      const a = host.controller()!.current();
      const observation = authority.captureCurrentUiSync();
      const old = service.catalog().panels[0]!.panelRef;
      const settled = Promise.withResolvers<IteratorResult<never>>();
      let available: boolean | undefined;
      a.runner.run = (request) => {
        request.signal!.addEventListener(
          'abort',
          () => {
            expect(() => authority!.assertCurrentUiSync(observation)).toThrow();
            available = service!.catalog().acceptingRuns;
            settled.resolve({ done: true, value: undefined });
          },
          { once: true },
        );
        return {
          [Symbol.asyncIterator]: () => ({
            next: () => settled.promise,
            return: async () => {
              settled.resolve({ done: true, value: undefined });
              return { done: true, value: undefined };
            },
          }),
        };
      };
      const iterable = host.controller()!.runner.run({
        sessionId: 'pinned',
        provider: 'mock',
        model: 'test',
        userMessage: { role: 'user', content: [{ type: 'text', text: 'test' }] },
      });
      const running = iterable[Symbol.asyncIterator]();
      void running.next();
      const b = await assembleServerGeneration(runtime, { kernelPlugins: [plugin] });
      await host.publish(b, { immediate: true });
      await running.return?.();
      expect(available).toBe(false);
      expect(service.catalog().acceptingRuns).toBe(true);
      await expect(service.read('s', old, {})).rejects.toBeDefined();
    } finally {
      service?.closeSync();
      await service?.drain();
      authority?.closeSync();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});

describe('reentrant current publication catalog', () => {
  it('keeps refs captured during epoch abort usable after duplicate publication notifications', async () => {
    const runtime = createServerRuntime();
    await runtime.start();
    let authority: ReturnType<typeof createHostUiAuthority> | undefined;
    let service: ReturnType<typeof createPanelService> | undefined;
    try {
      await createServerAgentRunner(runtime, { kernelPlugins: [plugin] });
      const host = runtime.serverHost;
      authority = createHostUiAuthority(host, ['quality']);
      const store = runtime.get(host.sessionStoreService);
      service = createPanelService({ host, authority, sessionStore: store });
      await store.append('s', [{ type: 'session.created', payload: {} }]);
      const old = authority.captureCurrentUiSync();
      const previous = service.catalog();
      let during: ReturnType<typeof service.catalog> | undefined;
      old.signal.addEventListener(
        'abort',
        () => {
          during = service!.catalog();
        },
        { once: true },
      );
      await host.publish(await assembleServerGeneration(runtime, { kernelPlugins: [plugin] }));
      const after = service.catalog();
      expect(during?.acceptingRuns).toBe(true);
      expect(during?.generation).toBe(after.generation);
      expect(during?.authorityEpoch).toBe(after.authorityEpoch);
      expect(during?.panels[0]?.panelRef).toBe(after.panels[0]?.panelRef);
      expect(after.panels[0]!.panelRef).not.toBe(previous.panels[0]!.panelRef);
      await expect(service.read('s', during!.panels[0]!.panelRef, {})).resolves.toMatchObject({
        lastSequence: 1,
      });
    } finally {
      service?.closeSync();
      await service?.drain();
      authority?.closeSync();
      await disposeServerPlugins(runtime);
      await runtime.stop();
    }
  });
});
