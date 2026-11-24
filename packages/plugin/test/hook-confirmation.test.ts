import { describe, expect, it, vi } from 'vitest';

import {
  confirmationRequiredHookIds,
  hookImpacts,
  requiresHookConfirmation,
} from '../src/index.js';
import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { toolAroundHook, toolPolicyHook, toolResultHook } from '../src/seams.js';

function manifest(id: string, over: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['tool'], ...over };
}

const request = { toolName: 'x' } as never;

function subscribingPlugin(id: string, over: Partial<PluginManifest> = {}) {
  return definePlugin({
    manifest: manifest(id, over),
    setup(env) {
      env.onHook(toolAroundHook, async (input, next) => next(input));
      env.onHook(toolPolicyHook, () => 'abstain');
      env.onHook(toolResultHook, () => undefined);
    },
  });
}

describe('hook risk metadata', () => {
  it('classifies every confirmation-required hook as high risk', () => {
    expect(confirmationRequiredHookIds).toEqual(['weave.llm.request', 'weave.tools.around']);
    for (const id of confirmationRequiredHookIds) expect(hookImpacts[id]?.level).toBe('high');
    expect(requiresHookConfirmation('weave.tools.result')).toBe(false);
    expect(hookImpacts['weave.tools.result']?.level).toBe('medium');
  });
});

describe('undeclared high-risk hook confirmation', () => {
  it('does not gate anything without a confirmation option', async () => {
    const kernel = createPluginKernel();
    await kernel.register(subscribingPlugin('p'));
    expect(kernel.hooks.count(toolAroundHook)).toBe(1);
    expect(kernel.plugins()[0]?.pendingHooks).toEqual([]);
    await kernel.dispose();
  });

  it('keeps an unconfirmed undeclared high-risk hook registered but undispatched', async () => {
    const kernel = createPluginKernel({ hookConfirmation: { isConfirmed: () => false } });
    await kernel.register(subscribingPlugin('p'));
    expect(kernel.plugins()[0]?.pendingHooks).toEqual(['weave.tools.around']);
    expect(kernel.plugins()[0]?.contributed.hooks).toContain('weave.tools.around');
    expect(kernel.hooks.count(toolAroundHook)).toBe(0);
    const base = vi.fn(async () => 'base' as never);
    await kernel.hooks.runWrap(toolAroundHook, request, base);
    expect(base).toHaveBeenCalledTimes(1);
    // Low and medium hooks are unaffected.
    expect(kernel.hooks.count(toolPolicyHook)).toBe(1);
    expect(kernel.hooks.count(toolResultHook)).toBe(1);
    await kernel.dispose();
  });

  it('dispatches once the hook is confirmed', async () => {
    const isConfirmed = vi.fn((pluginId: string, hookId: string) => {
      return pluginId === 'p' && hookId === 'weave.tools.around';
    });
    const kernel = createPluginKernel({ hookConfirmation: { isConfirmed } });
    const handler = vi.fn(async (input: never, next: (input: never) => Promise<never>) =>
      next(input),
    );
    await kernel.register(
      definePlugin({
        manifest: manifest('p'),
        setup(env) {
          env.onHook(toolAroundHook, handler as never);
        },
      }),
    );
    expect(kernel.plugins()[0]?.pendingHooks).toEqual([]);
    expect(kernel.hooks.count(toolAroundHook)).toBe(1);
    await kernel.hooks.runWrap(toolAroundHook, request, async () => 'ok' as never);
    expect(handler).toHaveBeenCalledTimes(1);
    await kernel.dispose();
  });

  it('confirms per plugin, so another plugin stays held', async () => {
    const kernel = createPluginKernel({
      hookConfirmation: { isConfirmed: (pluginId) => pluginId === 'a' },
    });
    await kernel.register(subscribingPlugin('a'));
    await kernel.register(subscribingPlugin('b'));
    expect(kernel.hooks.count(toolAroundHook)).toBe(1);
    const byId = new Map(kernel.plugins().map((info) => [info.manifest.id, info.pendingHooks]));
    expect(byId.get('a')).toEqual([]);
    expect(byId.get('b')).toEqual(['weave.tools.around']);
    await kernel.dispose();
  });

  it('dispatches declared hooks without asking for confirmation', async () => {
    const isConfirmed = vi.fn(() => false);
    const kernel = createPluginKernel({ hookConfirmation: { isConfirmed } });
    await kernel.register(
      definePlugin({
        manifest: manifest('p', { contributes: { hooks: ['weave.tools.around'] } }),
        setup(env) {
          env.onHook(toolAroundHook, async (input, next) => next(input));
        },
      }),
    );
    expect(isConfirmed).not.toHaveBeenCalled();
    expect(kernel.plugins()[0]?.pendingHooks).toEqual([]);
    expect(kernel.hooks.count(toolAroundHook)).toBe(1);
    await kernel.dispose();
  });

  it('holds an undeclared high-risk hook of a governed plugin that declares contributes', async () => {
    const kernel = createPluginKernel({ hookConfirmation: { isConfirmed: () => false } });
    await kernel.register(
      definePlugin({
        manifest: manifest('p', { contributes: { tools: [] } }),
        setup(env) {
          env.onHook(toolAroundHook, async (input, next) => next(input));
        },
      }),
    );
    expect(kernel.plugins()[0]?.pendingHooks).toEqual(['weave.tools.around']);
    expect(kernel.hooks.count(toolAroundHook)).toBe(0);
    await kernel.dispose();
  });

  it('still rejects an undeclared low-risk hook when contributes is declared', async () => {
    const kernel = createPluginKernel({ hookConfirmation: { isConfirmed: () => false } });
    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('p', { contributes: { tools: [] } }),
          setup(env) {
            env.onHook(toolResultHook, () => undefined);
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
    await kernel.dispose();
  });

  it('leaves ungoverned plugins on the plain declaration check', async () => {
    const kernel = createPluginKernel({
      hookConfirmation: { governs: (id) => id === 'local', isConfirmed: () => false },
    });
    await kernel.register(subscribingPlugin('host'));
    expect(kernel.plugins()[0]?.pendingHooks).toEqual([]);
    expect(kernel.hooks.count(toolAroundHook)).toBe(1);
    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('host-declared', { contributes: { tools: [] } }),
          setup(env) {
            env.onHook(toolAroundHook, async (input, next) => next(input));
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
    await kernel.dispose();
  });
});
