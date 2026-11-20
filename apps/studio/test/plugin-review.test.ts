// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import type { PluginListItem } from '../src/features/plugins/plugin-types.js';
import {
  createPluginReview,
  diffManifestDeclarations,
  pluginImpact,
} from '../src/features/plugins/plugin-review.js';

function plugin(over: Record<string, unknown> = {}): PluginListItem {
  return {
    id: 'local.demo',
    name: 'Demo',
    version: '1.0.0',
    origin: 'local',
    host: 'in-process',
    capabilities: ['tool'],
    provides: {
      tools: [],
      providers: [],
      promptSections: [],
      events: [],
      commands: [],
      hooks: [],
      services: [],
    },
    ...over,
  } as PluginListItem;
}

const manifest = {
  id: 'local.demo',
  name: 'Demo',
  version: '1.0.0',
  apiVersion: '1',
  capabilities: ['tool', 'tool', 'prompt'],
  contributes: {
    tools: ['echo'],
    providers: ['demo'],
    promptSections: ['tone'],
    events: ['entry'],
    commands: ['hello'],
    hooks: ['weave.tools.result'],
    services: ['demo.service'],
  },
  permissions: ['workspace:read'],
};

describe('createPluginReview', () => {
  it('captures a valid local digest and manifest as a detached review', () => {
    const capturedManifest = structuredClone(manifest);
    const item = plugin({
      local: {
        directory: '/tmp/demo',
        digest: 'a'.repeat(64),
        enabled: true,
        manifest: capturedManifest,
        trusted: {
          digest: 'b'.repeat(64),
          trustedAt: '2026-11-21T00:00:00Z',
          manifest: capturedManifest,
        },
      },
    });

    const review = createPluginReview(item);
    expect(review).toMatchObject({
      id: 'local.demo',
      directory: '/tmp/demo',
      digest: 'a'.repeat(64),
      previousTrusted: { digest: 'b'.repeat(64) },
    });
    expect(review?.manifest).not.toBe(capturedManifest);

    capturedManifest.contributes.tools.push('mutated');
    expect(review?.manifest.contributes?.tools).toEqual(['echo']);
  });

  it('rejects missing, malformed, or non-local review metadata', () => {
    expect(createPluginReview(plugin())).toBeUndefined();
    expect(
      createPluginReview(
        plugin({
          local: { directory: '/tmp/demo', digest: 'A'.repeat(64), enabled: true, manifest },
        }),
      ),
    ).toBeUndefined();
    expect(
      createPluginReview(
        plugin({
          origin: 'registered',
          local: { directory: '/tmp/demo', digest: 'a'.repeat(64), enabled: true, manifest },
        }),
      ),
    ).toBeUndefined();
    expect(
      createPluginReview(
        plugin({
          local: {
            directory: '/tmp/demo',
            digest: 'a'.repeat(64),
            enabled: true,
            manifest: { ...manifest, id: 'someone.else' },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      createPluginReview(
        plugin({
          local: {
            directory: '/tmp/demo',
            digest: 'a'.repeat(64),
            enabled: true,
            manifest: { ...manifest, permissions: [7] },
          },
        }),
      ),
    ).toBeUndefined();
    expect(
      createPluginReview(
        plugin({
          local: { directory: '', digest: 'a'.repeat(64), enabled: true, manifest },
        }),
      ),
    ).toBeUndefined();
  });
});

describe('diffManifestDeclarations', () => {
  it('diffs capabilities, every contributes key, and permissions with stable unique order', () => {
    const previous = {
      ...manifest,
      capabilities: ['tool', 'event'],
      contributes: {
        tools: ['old', 'shared'],
        providers: ['p'],
        promptSections: ['old-prompt'],
        events: ['old-event'],
        commands: ['old-command'],
        hooks: ['weave.tools.policy'],
        services: ['old-service'],
      },
      permissions: ['workspace:read', 'workspace:read', 'workspace:write'],
    };
    const changes = diffManifestDeclarations(previous, manifest);
    expect(changes).toEqual([
      { category: 'capabilities', added: ['prompt'], removed: ['event'] },
      { category: 'tools', added: ['echo'], removed: ['old', 'shared'] },
      { category: 'providers', added: ['demo'], removed: ['p'] },
      { category: 'promptSections', added: ['tone'], removed: ['old-prompt'] },
      { category: 'events', added: ['entry'], removed: ['old-event'] },
      { category: 'commands', added: ['hello'], removed: ['old-command'] },
      { category: 'hooks', added: ['weave.tools.result'], removed: ['weave.tools.policy'] },
      { category: 'services', added: ['demo.service'], removed: ['old-service'] },
      { category: 'permissions', added: [], removed: ['workspace:write'] },
    ]);
  });

  it('treats omitted arrays as empty and omits unchanged categories', () => {
    expect(
      diffManifestDeclarations(
        { id: 'x', name: 'x', version: '1', apiVersion: '1', capabilities: [] },
        { id: 'x', name: 'x', version: '2', apiVersion: '1', capabilities: [] },
      ),
    ).toEqual([]);
  });
});

describe('pluginImpact', () => {
  it('uses the exact hook and permission impact table and marks unknown values high', () => {
    expect(pluginImpact('hook', 'weave.llm.request')).toMatchObject({
      level: 'high',
      recognized: true,
      description: '能看到并改写发给模型的全部内容',
    });
    expect(pluginImpact('hook', 'weave.tools.policy').level).toBe('low');
    expect(pluginImpact('permission', 'workspace:read').level).toBe('medium');
    expect(pluginImpact('permission', 'service:weave.session.store').level).toBe('high');
    expect(pluginImpact('permission', 'future:thing')).toMatchObject({
      level: 'high',
      recognized: false,
    });
  });

  it('does not treat inherited object keys as recognized hook or permission ids', () => {
    expect(pluginImpact('hook', 'toString')).toMatchObject({ level: 'high', recognized: false });
    expect(pluginImpact('permission', '__proto__')).toMatchObject({
      level: 'high',
      recognized: false,
    });
  });

  it.each([
    ['hook', 'weave.tools.around', 'high', '能改写工具调用的参数和结果'],
    ['hook', 'weave.tools.result', 'medium', '能读到每次工具调用的结果'],
    ['hook', 'weave.tools.policy', 'low', '只能拒绝或要求确认工具调用，不能放行'],
    ['hook', 'weave.turn.start', 'low', '知道回合何时开始和结束'],
    ['hook', 'weave.turn.end', 'low', '知道回合何时开始和结束'],
    ['permission', 'process:spawn', 'high', '运行进程'],
    ['permission', 'workspace:write', 'high', '写入工作区'],
    ['permission', 'network:request', 'high', '访问网络'],
    ['permission', 'workspace:read', 'medium', '读取工作区'],
    ['permission', 'service:weave.session.store', 'high', '读取全部会话内容'],
    ['permission', 'service:future.service', 'medium', '使用宿主服务'],
  ] as const)('describes %s %s from the built-in table', (kind, value, level, description) => {
    expect(pluginImpact(kind, value)).toEqual({ level, description, recognized: true });
  });
});
