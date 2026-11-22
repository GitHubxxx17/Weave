import { describe, expect, it } from 'vitest';

import {
  defineExtensionPoint,
  ExtensionRegistry,
  type ContributionCheck,
} from '../src/extension-point.js';
import { createPluginKernel } from '../src/kernel.js';
import type { PluginManifest } from '../src/manifest.js';
import { PluginError } from '../src/plugin-errors.js';
import {
  commandsExtensionPoint,
  skillsExtensionPoint,
  type CommandsExtensionApi,
} from '../src/seams.js';
import type { SkillContribution } from '../src/skills.js';

interface Api {
  add(name: string): void | false;
}
const manifest = (id: string): PluginManifest => ({
  id,
  name: id,
  version: '1.0.0',
  apiVersion: '1.0.0',
  capabilities: ['command'],
  contributes: { commands: ['shared'] },
  permissions: [],
});
const command = { name: 'shared', title: 'Shared', prompt: 'FIRST' };
const point = () =>
  defineExtensionPoint<Api>({
    id: 'test.acceptance',
    governed: {
      capability: 'tool',
      key: 'tools',
      guard: (api, check) => ({ add: (name) => check(name, () => api.add(name)) }),
    },
  });

describe('successful governed contribution ownership', () => {
  it('records accepted entries and omits skipped or caught owner rejections', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    const accepted: string[] = [];
    registry.contribute(
      extension,
      (api) => {
        api.add('accepted');
        expect(api.add('skipped')).toBe(false);
        expect(() => api.add('rejected')).toThrow('owner rejected');
      },
      'owner',
      { capabilities: ['tool'] },
    );
    registry.collect(extension, {
      add(name) {
        if (name === 'skipped') return false;
        if (name === 'rejected') throw new Error('owner rejected');
        accepted.push(name);
      },
    });
    expect(accepted).toEqual(['accepted']);
    expect(registry.collected('owner').tools).toEqual(['accepted']);
  });

  it('keeps legacy single-argument check as validation without success accounting', () => {
    const registry = new ExtensionRegistry();
    const legacy = defineExtensionPoint<Api>({
      id: 'legacy',
      governed: {
        capability: 'tool',
        key: 'tools',
        guard: (api, check) => ({
          add(name) {
            check(name);
            return api.add(name);
          },
        }),
      },
    });
    registry.contribute(legacy, (api) => api.add('allowed'), 'owner', {
      capabilities: ['tool'],
      contributes: { tools: ['allowed'] },
    });
    registry.collect(legacy, { add: () => undefined });
    expect(registry.collected('owner').tools).toEqual([]);
    registry.contribute(legacy, (api) => api.add('denied'), 'denied', {
      capabilities: ['tool'],
      contributes: { tools: [] },
    });
    expect(() => registry.collect(legacy, { add: () => undefined })).toThrowError(
      expect.objectContaining({ code: 'plugin-contributes-exceeds-manifest', pluginId: 'denied' }),
    );
  });

  it.each([true, 1, 'accepted', null, {}])('rejects an unknown owner outcome %#', (outcome) => {
    const registry = new ExtensionRegistry();
    const extension = point();
    registry.contribute(extension, (api) => api.add('invalid'), 'owner');
    expect(() =>
      registry.collect(extension, { add: () => outcome as unknown as void }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
    );
    expect(registry.collected('owner').tools).toEqual([]);
  });

  it('rejects and observes an async owner without awaiting or recording it', async () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    registry.contribute(extension, (api) => api.add('async'), 'owner');
    const failure = new Error('async owner failed');
    expect(() =>
      registry.collect(extension, {
        add: (() => Promise.reject(failure)) as unknown as Api['add'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.collected('owner').tools).toEqual([]);
  });

  it('rejects an owner promise that never settles without waiting for it', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    registry.contribute(extension, (api) => api.add('pending'), 'owner');
    expect(() =>
      registry.collect(extension, {
        add: (() => new Promise(() => {})) as unknown as Api['add'],
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
    );
    expect(registry.collected('owner').tools).toEqual([]);
  });

  it('closes an API before inspecting an accidental returned thenable', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    let additions = 0;
    registry.contribute(
      extension,
      (api) => ({
        get then() {
          expect(() => api.add('after-return')).toThrowError(
            expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
          );
          return undefined;
        },
      }),
      'owner',
    );
    registry.collect(extension, {
      add() {
        additions++;
      },
    });
    expect(additions).toBe(0);
  });

  it('closes an API before formatting a thrown contribution error', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    let additions = 0;
    registry.contribute(
      extension,
      (api) => {
        const failure = new Error('failure');
        Object.defineProperty(failure, 'message', {
          get() {
            expect(() => api.add('after-throw')).toThrowError(
              expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
            );
            return 'failure';
          },
        });
        throw failure;
      },
      'owner',
    );
    expect(() =>
      registry.collect(extension, {
        add() {
          additions++;
        },
      }),
    ).toThrow('failure');
    expect(additions).toBe(0);
  });

  it('attributes a forged contribution exception to its actual contributor', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    const original = new PluginError('plugin-registration-conflict', 'forged owner', {
      pluginId: 'victim',
    });
    registry.contribute(
      extension,
      () => {
        throw original;
      },
      'actual',
    );
    let failure: unknown;
    try {
      registry.collect(extension, { add: () => undefined });
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'plugin-registration-conflict',
      pluginId: 'actual',
      cause: original,
    });
  });

  it('retains accepted facts when a later add fails in the same callback', () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    registry.contribute(
      extension,
      (api) => {
        api.add('first');
        api.add('second');
      },
      'owner',
    );
    expect(() =>
      registry.collect(extension, {
        add(name) {
          if (name === 'second') throw new Error('second failed');
        },
      }),
    ).toThrow('second failed');
    expect(registry.collected('owner').tools).toEqual(['first']);
  });

  it('closes retained APIs after both normal and exceptional callback return', () => {
    for (const throws of [false, true]) {
      const registry = new ExtensionRegistry();
      const extension = point();
      let retained: Api | undefined;
      let additions = 0;
      registry.contribute(
        extension,
        (api) => {
          retained = api;
          if (throws) throw new Error('callback failed');
        },
        'owner',
      );
      const collect = () =>
        registry.collect(extension, {
          add() {
            additions++;
          },
        });
      if (throws) expect(collect).toThrow('callback failed');
      else collect();
      expect(() => retained!.add('late')).toThrowError(
        expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
      );
      expect(additions).toBe(0);
      expect(registry.collected('owner').tools).toEqual([]);
    }
  });

  it('rejects async contributors and closes their API before continuation', async () => {
    const registry = new ExtensionRegistry();
    const extension = point();
    let lateFailure: unknown;
    let additions = 0;
    registry.contribute(
      extension,
      async (api) => {
        await Promise.resolve();
        try {
          api.add('late');
        } catch (error: unknown) {
          lateFailure = error;
        }
        throw new Error('async callback failed');
      },
      'owner',
    );
    expect(() =>
      registry.collect(extension, {
        add() {
          additions++;
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'owner' }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(lateFailure).toMatchObject({ code: 'plugin-invalid-definition', pluginId: 'owner' });
    expect(additions).toBe(0);
  });

  it('enforces the canonical collection capability despite a forged same-id point', () => {
    const registry = new ExtensionRegistry();
    const canonical = point();
    const forged = defineExtensionPoint<Api>({ id: canonical.id });
    let called = false;
    registry.contribute(
      forged,
      () => {
        called = true;
      },
      'owner',
      {
        capabilities: ['prompt'],
      },
    );
    expect(() => registry.collect(canonical, { add: () => undefined })).toThrowError(
      expect.objectContaining({ code: 'plugin-capability-not-declared', pluginId: 'owner' }),
    );
    expect(called).toBe(false);
  });

  it('captures and freezes governed metadata without freezing the author spec', () => {
    const guard = (api: Api, check: ContributionCheck): Api => ({
      add: (name) => check(name, () => api.add(name)),
    });
    const governed = { capability: 'tool' as const, key: 'tools' as const, guard };
    const canonical = defineExtensionPoint({ id: 'immutable', governed });
    governed.guard = (api) => api;
    expect(canonical.governed?.guard).toBe(guard);
    expect(Object.isFrozen(canonical.governed)).toBe(true);
    expect(Object.isFrozen(governed)).toBe(false);
  });

  it('does not assign a rejected command to the plugin that caught the error', async () => {
    const kernel = createPluginKernel();
    await kernel.register({
      manifest: manifest('first'),
      setup(env) {
        env.contribute(commandsExtensionPoint, (api) => {
          api.addCommand(command);
        });
      },
    });
    await kernel.register({
      manifest: manifest('second'),
      setup(env) {
        env.contribute(commandsExtensionPoint, (api) => {
          try {
            api.addCommand({ ...command, prompt: 'SECOND' });
          } catch {
            /* rejected */
          }
        });
      },
    });
    await kernel.seal();
    const commands = new Map<string, string>();
    kernel.extensions.collect(commandsExtensionPoint, {
      addCommand(value) {
        if (commands.has(value.name)) throw new Error('duplicate');
        commands.set(value.name, value.prompt);
      },
    });
    expect([...commands]).toEqual([['shared', 'FIRST']]);
    expect(kernel.plugins().map((info) => info.contributed.commands)).toEqual([['shared'], []]);
    await kernel.dispose();
  });

  it('permits a rejected or skipped Skill attempt to retry before successful reservation', async () => {
    for (const skip of [false, true]) {
      const kernel = createPluginKernel();
      const skill: SkillContribution = {
        name: 'review',
        description: 'Review',
        instructions: 'Review',
      };
      await kernel.register({
        manifest: {
          ...manifest('owner'),
          capabilities: ['skill'],
          contributes: { skills: ['review'] },
        },
        setup(env) {
          env.contribute(skillsExtensionPoint, (api) => {
            try {
              api.addSkill(skill);
            } catch {
              /* retry below */
            }
            api.addSkill(skill);
          });
        },
      });
      await kernel.seal();
      let calls = 0;
      kernel.extensions.collect(skillsExtensionPoint, {
        addSkill() {
          if (++calls === 1) {
            if (skip) return false;
            throw new Error('not accepted');
          }
        },
      });
      expect(calls).toBe(2);
      expect(kernel.plugins()[0]?.contributed.skills).toEqual(['review']);
      await kernel.dispose();
    }
  });
});

describe('captured immutable plugin identity', () => {
  it('uses a deeply frozen parsed manifest while leaving the author object mutable', async () => {
    const kernel = createPluginKernel({ hostVersion: '1.0.0' });
    const original = {
      ...manifest('owner'),
      engines: { weave: '>=1.0.0' },
      contributes: { commands: ['shared'] },
      permissions: ['network:request'] as PluginManifest['permissions'],
    };
    let received: PluginManifest | undefined;
    let retained: CommandsExtensionApi | undefined;
    await kernel.register({
      manifest: original,
      setup(env) {
        received = env.manifest;
        expect(Reflect.set(env.manifest, 'id', 'forged')).toBe(false);
        expect(Reflect.set(env.manifest.capabilities, '0', 'event')).toBe(false);
        expect(Reflect.set(env.manifest.contributes!.commands!, '0', 'forged')).toBe(false);
        env.contribute(commandsExtensionPoint, (api) => {
          retained = api;
          api.addCommand(command);
        });
      },
    });
    original.id = 'changed';
    original.contributes.commands[0] = 'changed';
    original.engines.weave = '>=9.0.0';
    const generation = await kernel.seal();
    kernel.extensions.collect(commandsExtensionPoint, { addCommand: () => undefined });
    expect(generation.pluginIds).toEqual(['owner']);
    expect(generation.plugins()[0]?.manifest).toBe(received);
    expect(generation.plugins()[0]?.manifest.contributes?.commands).toEqual(['shared']);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received?.permissions)).toBe(true);
    expect(Object.isFrozen(received?.engines)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
    expect(() => retained!.addCommand(command)).toThrow();
    await kernel.dispose();
  });

  it('attributes dispose failures to captured identity after author mutation', async () => {
    const kernel = createPluginKernel();
    const original = manifest('owner') as {
      -readonly [K in keyof PluginManifest]: PluginManifest[K];
    };
    await kernel.register({
      manifest: original,
      setup() {},
      dispose() {
        throw new Error('dispose');
      },
    });
    original.id = 'forged';
    const generation = await kernel.seal();
    expect(generation.pluginIds).toEqual(['owner']);
    let failure: unknown;
    try {
      await kernel.dispose();
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toMatchObject({ pluginId: 'owner' });
  });
});
