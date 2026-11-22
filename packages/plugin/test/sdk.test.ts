import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { pluginApiVersion } from '../src/constants.js';
import { createPluginKernel, definePlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { createPluginSdk, type PluginFactory } from '../src/sdk.js';
import * as seams from '../src/seams.js';

function manifest(id: string, over: Partial<PluginManifest> = {}): PluginManifest {
  return { id, name: id, version: '0.1.0', apiVersion: '1.0.0', capabilities: ['tool'], ...over };
}

/** What a plugin author may rely on; changing this list changes the plugin API. */
const sdkNames = [
  'apiVersion',
  'approvalBrokerRef',
  'commandsExtensionPoint',
  'defineExtensionPoint',
  'defineHook',
  'defineServiceRef',
  'llmProvidersExtensionPoint',
  'llmRequestHook',
  'pluginEventsRef',
  'promptSectionsExtensionPoint',
  'sessionStoreRef',
  'skillsExtensionPoint',
  'toolAroundHook',
  'toolPolicyHook',
  'toolResultHook',
  'toolsExtensionPoint',
  'turnEndHook',
  'turnStartHook',
  'z',
];

describe('createPluginSdk', () => {
  it('offers exactly the documented names', () => {
    expect(Object.keys(createPluginSdk()).sort()).toEqual(sdkNames);
  });

  it('is frozen, so a plugin cannot change what the next plugin sees', () => {
    const sdk = createPluginSdk();

    expect(Object.isFrozen(sdk)).toBe(true);
    expect(Reflect.set(sdk, 'apiVersion', '9.9.9')).toBe(false);
    expect(Reflect.set(sdk, 'toolsExtensionPoint', {})).toBe(false);
    expect(Reflect.deleteProperty(sdk, 'z')).toBe(false);
    expect(sdk.apiVersion).toBe(pluginApiVersion);
  });

  it("hands out the host's own seams, not copies, so ids match across plugins", () => {
    const sdk = createPluginSdk();

    expect(sdk.toolsExtensionPoint).toBe(seams.toolsExtensionPoint);
    expect(sdk.commandsExtensionPoint).toBe(seams.commandsExtensionPoint);
    expect(sdk.skillsExtensionPoint).toBe(seams.skillsExtensionPoint);
    expect(sdk.llmProvidersExtensionPoint).toBe(seams.llmProvidersExtensionPoint);
    expect(sdk.promptSectionsExtensionPoint).toBe(seams.promptSectionsExtensionPoint);
    expect(sdk.toolPolicyHook).toBe(seams.toolPolicyHook);
    expect(sdk.toolAroundHook).toBe(seams.toolAroundHook);
    expect(sdk.toolResultHook).toBe(seams.toolResultHook);
    expect(sdk.llmRequestHook).toBe(seams.llmRequestHook);
    expect(sdk.turnStartHook).toBe(seams.turnStartHook);
    expect(sdk.turnEndHook).toBe(seams.turnEndHook);
    expect(sdk.approvalBrokerRef).toBe(seams.approvalBrokerRef);
    expect(sdk.sessionStoreRef).toBe(seams.sessionStoreRef);
    expect(sdk.pluginEventsRef).toBe(seams.pluginEventsRef);
  });

  it("shares the host's zod, so schemas a plugin builds are the host's schemas", () => {
    const sdk = createPluginSdk();

    expect(sdk.z).toBe(z);
    expect(sdk.z.object({ text: sdk.z.string() }).safeParse({ text: 'hi' }).success).toBe(true);
  });

  it('speaks the API version a kernel expects of a manifest', () => {
    expect(createPluginSdk().apiVersion).toBe(pluginApiVersion);
  });

  it.each([
    'toolRegistryRef',
    'toolPipelineRef',
    'agentRunnerRef',
    'llmProviderRegistryRef',
    'eventsExtensionPoint',
    'createPluginKernel',
    'createPluginEnv',
    'createPluginSessionStore',
    'createRestrictedApprovalBroker',
    'createPluginRegistry',
    'ServiceContainer',
    'ExtensionRegistry',
    'HookRegistry',
  ])('leaves out %s, which only the host assembles', (name) => {
    expect(createPluginSdk()).not.toHaveProperty(name);
  });

  it('lets an entry module written as a factory contribute and listen through the SDK', async () => {
    const factory: PluginFactory = (sdk) => ({
      setup(env) {
        env.contribute(sdk.commandsExtensionPoint, (api) =>
          api.addCommand({ name: 'hello', title: 'Hello', prompt: 'Say hello to $ARGUMENTS' }),
        );
        env.onHook(sdk.turnEndHook, () => undefined);
      },
    });
    const kernel = createPluginKernel();

    const module = await factory(createPluginSdk());
    await kernel.register(
      definePlugin({
        manifest: manifest('hello-commands', {
          capabilities: ['command'],
          contributes: { commands: ['hello'], hooks: ['weave.turn.end'] },
          permissions: [],
        }),
        setup: module.setup,
      }),
    );
    const names: string[] = [];
    kernel.extensions.collect(seams.commandsExtensionPoint, {
      addCommand: (command) => {
        names.push(command.name);
      },
    });

    expect(names).toEqual(['hello']);
    expect(kernel.hooks.count(seams.turnEndHook)).toBe(1);
    expect(kernel.plugins()[0]?.contributed).toMatchObject({
      commands: ['hello'],
      hooks: ['weave.turn.end'],
    });
  });

  it('lets a plugin define its own service, extension point and hook through the SDK', async () => {
    const sdk = createPluginSdk();
    const counterRef = sdk.defineServiceRef<{ next(): number }>({ id: 'example.counter' });
    const point = sdk.defineExtensionPoint<{ add(name: string): void }>({ id: 'example.names' });
    const hook = sdk.defineHook<string>({ id: 'example.named', mode: 'observe' });
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('own-seams'),
        setup(env) {
          let count = 0;
          env.provide(counterRef, { factory: () => ({ next: () => (count += 1) }) });
          env.contribute(point, (api) => api.add('one'));
          env.onHook(hook, () => undefined);
        },
      }),
    );
    const generation = await kernel.seal();
    const names: string[] = [];
    kernel.extensions.collect(point, { add: (name) => names.push(name) });

    expect((await generation.resolve(counterRef)).next()).toBe(1);
    expect(names).toEqual(['one']);
    expect(kernel.hooks.count(hook)).toBe(1);
  });
});
