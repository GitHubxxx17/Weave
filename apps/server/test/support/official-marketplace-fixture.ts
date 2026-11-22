import type { PluginManifest } from '@weave/plugin';

/** Test-only identities; these never register a production release. */
export function officialRelease(version = '1.0.0') {
  const manifest: PluginManifest = {
    id: 'fixture-official-skills',
    name: 'Fixture payload',
    version,
    apiVersion: '1.0.0',
    description: 'A reviewed fixture manifest',
    capabilities: ['tool', 'command'],
    engines: { weave: '>=1.0.0' },
    contributes: { tools: ['read-note', 'write-note'], commands: ['notes'] },
    permissions: ['workspace:read', 'workspace:write'],
  };
  return {
    manifest,
    source: {
      repository: 'https://github.com/fixture/official-skills',
      commit: 'a'.repeat(40),
      subdirectory: 'plugins/skills',
    },
  };
}

export function officialFamily() {
  return {
    id: 'fixture-official-skills',
    name: 'Host-owned Skills',
    description: 'Host-owned description',
    publisher: 'Weave',
    tags: ['host-owned'],
    releases: [officialRelease(), officialRelease('2.0.0')],
  };
}

export function officialEntry() {
  return {
    id: 'fixture-official-skills',
    name: 'Untrusted index name',
    description: 'Untrusted index description',
    publisher: 'Untrusted index publisher',
    tags: ['untrusted'],
    releases: [officialRelease(), officialRelease('2.0.0')],
  };
}
