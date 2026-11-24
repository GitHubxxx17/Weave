import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeMcpContentDigest,
  mcpConfigDigest,
  mcpConfigDigestV2,
  mcpServerConfigSchema,
  normalizeMcpServerConfig,
  type McpServerConfig,
} from '../src/mcp-environment.js';
import {
  createSqliteMcpAuthorityStore,
  validateMcpAuthorityLog,
  type RecordedMcpAuthorityEvent,
} from '../src/mcp-authority-store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function workspace() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'weave-mcp-content-')));
  directories.push(directory);
  const command = join(directory, 'server.sh');
  await writeFile(command, '#!/bin/sh\nexit 0\n');
  await chmod(command, 0o755);
  const config: McpServerConfig = {
    schemaVersion: 1,
    id: 'notes',
    label: 'Notes',
    transport: 'stdio',
    command,
    args: [],
    cwd: directory,
    env: {},
  };
  return { directory, command, config };
}

describe('MCP content digest', () => {
  it('changes with the command file and stays stable otherwise', async () => {
    const { command, config } = await workspace();
    const first = await computeMcpContentDigest(config);
    expect(await computeMcpContentDigest(config)).toBe(first);
    await writeFile(command, '#!/bin/sh\nexit 1\n');
    const second = await computeMcpContentDigest(config);
    expect(second).not.toBe(first);
    expect(mcpConfigDigestV2(config, second)).not.toBe(mcpConfigDigestV2(config, first));
  });

  it('changes with bound file and directory content, including new files', async () => {
    const { directory, config } = await workspace();
    const script = join(directory, 'main.js');
    const project = join(directory, 'project');
    await writeFile(script, 'a');
    await mkdir(project);
    await writeFile(join(project, 'index.js'), 'a');
    const bound = { ...config, contentPaths: [script, project] };
    const base = await computeMcpContentDigest(bound);
    await writeFile(script, 'b');
    const afterFile = await computeMcpContentDigest(bound);
    expect(afterFile).not.toBe(base);
    await writeFile(join(project, 'extra.js'), 'c');
    expect(await computeMcpContentDigest(bound)).not.toBe(afterFile);
  });

  it('puts the policy and bound paths into the config digest', async () => {
    const { directory, config } = await workspace();
    const content = await computeMcpContentDigest(config);
    expect(mcpConfigDigestV2(config, content)).not.toBe(mcpConfigDigest(config));
    const file = join(directory, 'main.js');
    await writeFile(file, 'a');
    expect(mcpConfigDigestV2({ ...config, contentPaths: [file] }, content)).not.toBe(
      mcpConfigDigestV2(config, content),
    );
  });

  it('fails with a clear error above 1000 files, and for symbolic links', async () => {
    const { directory, config } = await workspace();
    const many = join(directory, 'many');
    await mkdir(many);
    await Promise.all(
      Array.from({ length: 1001 }, (_, index) => writeFile(join(many, `${index}.txt`), 'x')),
    );
    await expect(
      computeMcpContentDigest({ ...config, contentPaths: [many] }),
    ).rejects.toMatchObject({ code: 'mcp-content-too-large' });

    const linked = join(directory, 'linked');
    await mkdir(linked);
    await symlink(config.command, join(linked, 'link'));
    await expect(
      computeMcpContentDigest({ ...config, contentPaths: [linked] }),
    ).rejects.toMatchObject({ code: 'mcp-content-unreadable' });
    await expect(
      computeMcpContentDigest({ ...config, contentPaths: [join(directory, 'missing')] }),
    ).rejects.toMatchObject({ code: 'mcp-content-unreadable' });
  });

  it('validates contentPaths: absolute, at most 16, resolved by normalization', async () => {
    const { directory, config } = await workspace();
    expect(mcpServerConfigSchema.safeParse({ ...config, contentPaths: ['relative'] }).success).toBe(
      false,
    );
    const seventeen = Array.from({ length: 17 }, (_, i) => join(directory, String(i)));
    expect(mcpServerConfigSchema.safeParse({ ...config, contentPaths: seventeen }).success).toBe(
      false,
    );
    const link = join(directory, 'link');
    await symlink(directory, link);
    const normalized = await normalizeMcpServerConfig({ ...config, contentPaths: [link] });
    expect(normalized.contentPaths).toEqual([directory]);
    await expect(
      normalizeMcpServerConfig({ ...config, contentPaths: [join(directory, 'missing')] }),
    ).rejects.toMatchObject({ code: 'mcp-invalid' });
  });
});

describe('MCP authority replay across policy versions', () => {
  const occurredAt = '2026-11-24T00:00:00.000Z';

  it('replays policy 1 events and rejects tampered policy 2 digests', async () => {
    const { config } = await workspace();
    const content = await computeMcpContentDigest(config);
    const v1: RecordedMcpAuthorityEvent = {
      kind: 'configured',
      config,
      configDigest: mcpConfigDigest(config),
      schemaVersion: 1,
      sequence: 1,
      occurredAt,
      scope: 'user',
    };
    const [legacy] = validateMcpAuthorityLog({
      sequence: 1,
      events: [v1],
      records: [
        {
          config,
          configDigest: v1.configDigest,
          policyVersion: 1,
          contentDigest: null,
          trustedDigest: null,
          trustState: 'untrusted',
          enabled: false,
          removed: false,
          reviewed: null,
        },
      ],
    }).records;
    expect(legacy?.policyVersion).toBe(1);

    const v2: RecordedMcpAuthorityEvent = {
      ...v1,
      configDigest: mcpConfigDigestV2(config, content),
      policyVersion: 2,
      contentDigest: content,
    };
    expect(() =>
      validateMcpAuthorityLog({
        sequence: 1,
        events: [{ ...v2, configDigest: mcpConfigDigest(config) }],
        records: [],
      }),
    ).toThrowError();
  });

  it('keeps authority append-only: a changed content digest appends, never rewrites', async () => {
    const { directory, command, config } = await workspace();
    const store = createSqliteMcpAuthorityStore({ filename: join(directory, 'a.sqlite') });
    try {
      const before = await computeMcpContentDigest(config);
      let log = await store.read();
      log = await store.mutate(
        { kind: 'create', config, contentDigest: before },
        { expectedSequence: 0, knownPrefix: log.events },
      );
      expect(log.records[0]).toMatchObject({ policyVersion: 2, contentDigest: before });
      const same = await store.mutate(
        { kind: 'update', config, contentDigest: before },
        { expectedSequence: 1, knownPrefix: log.events },
      );
      expect(same.appended).toBeNull();

      await writeFile(command, '#!/bin/sh\nexit 2\n');
      const after = await computeMcpContentDigest(config);
      const updated = await store.mutate(
        { kind: 'update', config, contentDigest: after },
        { expectedSequence: 1, knownPrefix: same.events },
      );
      expect(updated.sequence).toBe(2);
      expect(updated.events[0]).toEqual(same.events[0]);
      expect(updated.records[0]?.configDigest).toBe(mcpConfigDigestV2(config, after));
    } finally {
      await store.close();
    }
  });
});
