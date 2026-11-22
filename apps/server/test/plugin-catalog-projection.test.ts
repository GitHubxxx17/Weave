import { describe, expect, it } from 'vitest';
import { projectPluginCatalog } from '../src/plugin-catalog.js';
import type { PluginHostSnapshot } from '@weave/plugin-host';

describe('projectPluginCatalog', () => {
  it('replaces local catalog rows with desired records and only exposes matching loaded provides', () => {
    const manifest = {
      id: 'local-kit',
      name: 'Local Kit',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'] as const,
      contributes: { tools: ['declared'] },
      permissions: [],
    };
    const snapshot = {
      directory: '/plugins',
      exists: true,
      truncated: false,
      trustSequence: 2,
      plugins: [
        {
          id: 'local-kit',
          state: 'loaded',
          candidate: {
            status: 'ready',
            id: 'local-kit',
            directory: '/plugins/local-kit',
            digest: 'a'.repeat(64),
            entry: '/plugins/local-kit/index.mjs',
            manifest,
          },
          trusted: {
            pluginId: 'local-kit',
            digest: 'a'.repeat(64),
            manifest,
            trustedAt: '2026-01-01T00:00:00.000Z',
            enabled: true,
          },
          active: { generation: 4, digest: 'a'.repeat(64), manifest },
        },
      ],
      generation: {
        id: 4,
        plugins: [{ id: 'local-kit', digest: 'a'.repeat(64), manifest }],
        acceptingRuns: true,
      },
    } satisfies PluginHostSnapshot;
    const result = projectPluginCatalog(
      [
        {
          id: 'builtin',
          name: 'Builtin',
          version: '1.0.0',
          origin: 'builtin',
          host: 'in-process',
          capabilities: ['tool'],
          state: 'loaded',
          provides: {
            tools: ['builtin'],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
        },
        {
          id: 'local-kit',
          name: 'stale',
          version: '9.9.9',
          origin: 'local',
          host: 'in-process',
          capabilities: ['tool'],
          state: 'loaded',
          provides: {
            tools: ['actual'],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
        },
      ],
      snapshot,
    );
    expect(result).toEqual([
      expect.objectContaining({ id: 'builtin', state: 'loaded' }),
      expect.objectContaining({
        id: 'local-kit',
        name: 'Local Kit',
        version: '1.0.0',
        origin: 'local',
        state: 'loaded',
        provides: {
          tools: ['actual'],
          providers: [],
          promptSections: [],
          events: [],
          commands: [],
          skills: [],
          hooks: [],
          services: [],
        },
        local: expect.objectContaining({
          directory: '/plugins/local-kit',
          digest: 'a'.repeat(64),
          enabled: true,
          active: { generation: 4, digest: 'a'.repeat(64), manifest },
        }),
      }),
    ]);
  });

  it.each(['pending-trust', 'changed', 'disabled', 'failed', 'invalid', 'incompatible'] as const)(
    'keeps old active metadata but no actual contributions for %s',
    (state) => {
      const manifest = {
        id: 'local-kit',
        name: 'Local Kit',
        version: '2.0.0',
        apiVersion: '1.0.0',
        capabilities: ['tool'] as const,
        contributes: { tools: ['new-tool'] },
        permissions: [],
      };
      const previous = { ...manifest, version: '1.0.0', contributes: { tools: ['old-tool'] } };
      const record = {
        id: 'local-kit',
        state,
        candidate: {
          status: 'ready' as const,
          id: 'local-kit',
          directory: '/plugins/local-kit',
          digest: 'b'.repeat(64),
          entry: '/plugins/local-kit/private-entry.mjs',
          manifest,
        },
        trusted: {
          pluginId: 'local-kit',
          digest: 'a'.repeat(64),
          manifest: previous,
          trustedAt: '2026-01-01',
          enabled: state !== 'disabled',
        },
        active: { generation: 4, digest: 'a'.repeat(64), manifest: previous },
        error: {
          code: 'plugin-load-failed',
          message: 'Public setup error',
          cause: 'private exception',
        },
      };
      const result = projectPluginCatalog(
        [
          {
            id: 'local-kit',
            name: 'old',
            version: '1.0.0',
            origin: 'kernel',
            state: 'loaded',
            host: 'in-process',
            capabilities: ['tool'],
            provides: {
              tools: ['old-tool'],
              providers: [],
              promptSections: [],
              events: [],
              commands: [],
              skills: [],
              hooks: [],
              services: [],
            },
          },
        ],
        {
          directory: '/plugins',
          exists: true,
          truncated: false,
          trustSequence: 4,
          plugins: [record],
          generation: {
            id: 4,
            plugins: [{ id: 'local-kit', digest: 'a'.repeat(64), manifest: previous }],
            acceptingRuns: true,
          },
        },
      );
      expect(result).toEqual([
        expect.objectContaining({
          id: 'local-kit',
          state,
          version: '2.0.0',
          contributes: { tools: ['new-tool'] },
          provides: {
            tools: [],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
          error: { code: 'plugin-load-failed', message: 'Public setup error' },
          local: {
            directory: '/plugins/local-kit',
            digest: 'b'.repeat(64),
            enabled: state !== 'disabled',
            manifest,
            trusted: { digest: 'a'.repeat(64), trustedAt: '2026-01-01', manifest: previous },
            active: { generation: 4, digest: 'a'.repeat(64), manifest: previous },
          },
        }),
      ]);
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  it('hides stale local contributions even when the desired record claims loaded with a new digest', () => {
    const manifest = {
      id: 'local-kit',
      name: 'Local',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'] as const,
    };
    const projected = projectPluginCatalog(
      [
        {
          id: 'local-kit',
          name: 'Old',
          version: '1.0.0',
          origin: 'local',
          state: 'loaded',
          host: 'in-process',
          capabilities: ['tool'],
          provides: {
            tools: ['old-tool'],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
        },
      ],
      {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 0,
        plugins: [
          {
            id: 'local-kit',
            state: 'loaded',
            candidate: {
              id: 'local-kit',
              status: 'ready',
              directory: '/plugins/local-kit',
              digest: 'b'.repeat(64),
              entry: '/plugins/local-kit/index.mjs',
              manifest,
            },
            trusted: undefined,
          },
        ],
        generation: {
          id: 1,
          plugins: [{ id: 'local-kit', digest: 'a'.repeat(64), manifest }],
          acceptingRuns: true,
        },
      },
    );
    expect(projected[0]?.provides.tools).toEqual([]);
  });

  it('omits disappeared local catalog rows while retaining nonlocal rows', () => {
    const manifest = {
      id: 'gone',
      name: 'Gone',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'] as const,
    };
    const provides = {
      tools: [],
      providers: [],
      promptSections: [],
      events: [],
      commands: [],
      skills: [],
      hooks: [],
      services: [],
    };
    const result = projectPluginCatalog(
      [
        {
          id: 'gone',
          name: 'Gone',
          version: '1.0.0',
          origin: 'kernel',
          state: 'loaded',
          host: 'in-process',
          capabilities: ['tool'],
          provides,
        },
        {
          id: 'host',
          name: 'Host',
          version: '1.0.0',
          origin: 'registered',
          state: 'loaded',
          host: 'in-process',
          capabilities: ['tool'],
          provides,
        },
      ],
      {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 0,
        plugins: [],
        generation: {
          id: 1,
          plugins: [{ id: 'gone', digest: 'a'.repeat(64), manifest }],
          acceptingRuns: true,
        },
      },
    );
    expect(result.map((row) => [row.id, row.origin, row.state])).toEqual([
      ['host', 'registered', 'loaded'],
    ]);
  });

  it('requires active record membership in the current generation before exposing provides', () => {
    const manifest = {
      id: 'local-kit',
      name: 'Local',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'] as const,
    };
    const projected = projectPluginCatalog(
      [
        {
          id: 'local-kit',
          name: 'Old',
          version: '1.0.0',
          origin: 'local',
          state: 'loaded',
          host: 'in-process',
          capabilities: ['tool'],
          provides: {
            tools: ['old-tool'],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
        },
      ],
      {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 0,
        plugins: [
          {
            id: 'local-kit',
            state: 'loaded',
            candidate: {
              id: 'local-kit',
              status: 'ready',
              directory: '/plugins/local-kit',
              digest: 'a'.repeat(64),
              entry: '/plugins/local-kit/index.mjs',
              manifest,
            },
            trusted: undefined,
            active: { generation: 1, digest: 'a'.repeat(64), manifest },
          },
        ],
        generation: {
          id: 2,
          plugins: [{ id: 'local-kit', digest: 'a'.repeat(64), manifest }],
          acceptingRuns: true,
        },
      },
    );
    expect(projected[0]?.provides.tools).toEqual([]);
  });

  it('keeps published base rows and the first surviving manual row for each ID', () => {
    const issue = { code: 'plugin-duplicate-id', message: 'Duplicate plugin id' };
    const projected = projectPluginCatalog(
      [
        {
          id: 'selected',
          name: 'Published plugin',
          version: '1.0.0',
          origin: 'kernel',
          state: 'loaded',
          host: 'in-process',
          capabilities: ['tool'],
          provides: {
            tools: ['host-tool'],
            providers: [],
            promptSections: [],
            events: [],
            commands: [],
            skills: [],
            hooks: [],
            services: [],
          },
        },
      ],
      {
        directory: '/plugins',
        exists: true,
        truncated: false,
        trustSequence: 0,
        plugins: [
          {
            id: 'selected',
            state: 'invalid',
            candidate: {
              id: 'selected',
              directory: '/plugins/collision',
              status: 'invalid',
              issue,
            },
            trusted: undefined,
          },
          {
            id: 'duplicate',
            state: 'invalid',
            candidate: { id: 'duplicate', directory: '/plugins/first', status: 'invalid', issue },
            trusted: undefined,
          },
          {
            id: 'duplicate',
            state: 'invalid',
            candidate: { id: 'duplicate', directory: '/plugins/second', status: 'invalid', issue },
            trusted: undefined,
          },
        ],
        generation: { id: 1, plugins: [], acceptingRuns: true },
      },
    );
    expect(
      projected.map((row) => [row.id, row.origin, row.local?.directory, row.provides.tools]),
    ).toEqual([
      ['selected', 'kernel', undefined, ['host-tool']],
      ['duplicate', 'local', '/plugins/first', []],
    ]);
    expect(projected.slice(1).map((row) => row.error)).toEqual([
      { code: 'plugin-duplicate-id', message: 'Duplicate plugin id' },
    ]);
  });

  it('uses unknown metadata and empty provides for malformed or inactive local records', () => {
    const snapshot = {
      directory: '/plugins',
      exists: false,
      truncated: false,
      trustSequence: 0,
      plugins: [
        {
          id: 'broken',
          state: 'invalid',
          candidate: {
            status: 'invalid',
            id: 'broken',
            directory: '/plugins/broken',
            issue: { code: 'plugin-invalid-descriptor', message: 'bad' },
          },
          trusted: undefined,
        },
      ],
      generation: { id: 1, plugins: [], acceptingRuns: true },
    } satisfies PluginHostSnapshot;
    expect(projectPluginCatalog([], snapshot)).toEqual([
      expect.objectContaining({
        id: 'broken',
        version: 'unknown',
        capabilities: [],
        state: 'invalid',
        error: { code: 'plugin-invalid-descriptor', message: 'bad' },
        provides: {
          tools: [],
          providers: [],
          promptSections: [],
          events: [],
          commands: [],
          skills: [],
          hooks: [],
          services: [],
        },
        local: expect.objectContaining({ directory: '/plugins/broken', enabled: false }),
      }),
    ]);
  });
});
