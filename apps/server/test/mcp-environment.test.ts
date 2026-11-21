import { createHash } from 'node:crypto';
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMcpServerConfigSchema,
  mcpConfigDigest,
  mcpServerConfigSchema,
  normalizeMcpServerConfig,
  recheckMcpLaunchPaths,
  resolveMcpEnvironment,
  type McpServerConfig,
} from '../src/mcp-environment.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    schemaVersion: 1,
    id: 'notes',
    label: 'Notes',
    transport: 'stdio',
    command: process.execPath,
    args: [],
    cwd: tmpdir(),
    env: {},
    ...overrides,
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'weave-mcp-env-'));
  directories.push(directory);
  const executable = join(directory, 'program');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o755);
  return { directory, executable };
}

describe('MCP launch configuration', () => {
  it('normalizes saved executable and working directory paths without spawning', async () => {
    const { directory, executable } = await fixture();
    const commandLink = join(directory, 'program-link');
    const directoryLink = join(directory, 'directory-link');
    await symlink(executable, commandLink);
    await symlink(directory, directoryLink);
    const normalized = await normalizeMcpServerConfig(
      config({ command: commandLink, cwd: directoryLink }),
    );
    expect(normalized.command).toBe(await realpath(executable));
    expect(normalized.cwd).toBe(await realpath(directory));
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.args)).toBe(true);
    await expect(recheckMcpLaunchPaths(normalized)).resolves.toBeUndefined();
  });

  it('rejects missing, nonexecutable and wrong-type paths with fixed errors', async () => {
    const { directory, executable } = await fixture();
    await chmod(executable, 0o644);
    for (const input of [
      config({ command: executable }),
      config({ command: directory }),
      config({ cwd: executable }),
      config({ command: join(directory, 'secret-value-missing') }),
      config({ command: 'relative' }),
    ]) {
      await expect(normalizeMcpServerConfig(input)).rejects.toMatchObject({
        code: 'mcp-invalid',
        message: 'MCP launch configuration is invalid',
      });
    }
  });

  it('rejects canonical paths that disappear or become a new symlink before launch', async () => {
    const { directory, executable } = await fixture();
    const normalized = await normalizeMcpServerConfig(
      config({ command: executable, cwd: directory }),
    );
    await rm(executable);
    await expect(recheckMcpLaunchPaths(normalized)).rejects.toMatchObject({ code: 'mcp-invalid' });
    const other = join(directory, 'other');
    await writeFile(other, '#!/bin/sh\n');
    await chmod(other, 0o755);
    await symlink(other, executable);
    await expect(recheckMcpLaunchPaths(normalized)).rejects.toMatchObject({ code: 'mcp-invalid' });
  });

  it('hashes canonical launch fields and policy while excluding label and secret values', () => {
    const value = config({
      env: { B: { fromHostEnv: 'SECOND' }, A: { fromHostEnv: 'FIRST' } },
      args: ['one', 'two'],
    });
    const sorted = {
      args: ['one', 'two'],
      command: value.command,
      cwd: value.cwd,
      env: { A: { fromHostEnv: 'FIRST' }, B: { fromHostEnv: 'SECOND' } },
      id: 'notes',
      policyVersion: 1,
      schemaVersion: 1,
      transport: 'stdio',
    };
    expect(mcpConfigDigest(value)).toBe(
      createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex'),
    );
    expect(
      mcpConfigDigest({
        ...value,
        label: 'Renamed',
        env: { A: { fromHostEnv: 'FIRST' }, B: { fromHostEnv: 'SECOND' } },
      }),
    ).toBe(mcpConfigDigest(value));
    expect(mcpConfigDigest({ ...value, args: ['two', 'one'] })).not.toBe(mcpConfigDigest(value));
    expect(mcpConfigDigest({ ...value, env: { A: { fromHostEnv: 'OTHER' } } })).not.toBe(
      mcpConfigDigest(value),
    );
  });

  it.each([
    { id: 'Bad' },
    { id: 'a'.repeat(25) },
    { label: '' },
    { label: 'a'.repeat(81) },
    { schemaVersion: 2 },
    { transport: 'http' },
    { args: Array.from({ length: 65 }, () => '') },
    { args: ['好'.repeat(1366)] },
    { env: { BAD: { value: 'plaintext-secret' } } },
    { env: { 'NOT-NAME': { fromHostEnv: 'GOOD' } } },
    { env: { weave_SECRET: { fromHostEnv: 'GOOD' } } },
    { env: { GOOD: { fromHostEnv: 'WeAvE_SECRET' } } },
    {
      env: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`A${index}`, { fromHostEnv: `B${index}` }]),
      ),
    },
    { args: Array.from({ length: 64 }, () => 'x'.repeat(4096)) },
    { extra: true },
    { command: '/bad\0program' },
    { cwd: '/bad\0directory' },
    { args: ['bad\0argument'] },
  ])('strictly rejects malformed or oversized configuration %#', (overrides) => {
    expect(mcpServerConfigSchema.safeParse({ ...config(), ...overrides }).success).toBe(false);
  });

  it('canonicalizes Windows aliases and rejects shell wrappers', () => {
    const schema = createMcpServerConfigSchema('win32');
    const windows = config({
      command: 'C:\\tools\\node.exe',
      cwd: 'C:\\tools',
      env: { Path: { fromHostEnv: 'my_Path' } },
    });
    expect(schema.parse(windows).env).toEqual({ PATH: { fromHostEnv: 'MY_PATH' } });
    expect(
      schema.parse({
        ...windows,
        env: { FIRST: { fromHostEnv: 'TOKEN' }, SECOND: { fromHostEnv: 'TOKEN' } },
      }).env,
    ).toEqual({ FIRST: { fromHostEnv: 'TOKEN' }, SECOND: { fromHostEnv: 'TOKEN' } });
    for (const env of [
      { Path: { fromHostEnv: 'ONE' }, PATH: { fromHostEnv: 'TWO' } },
      { ONE: { fromHostEnv: 'Path' }, TWO: { fromHostEnv: 'PATH' } },
    ]) {
      expect(schema.safeParse({ ...windows, env }).success).toBe(false);
    }
    expect(schema.safeParse({ ...windows, command: 'C:\\tools\\launch.CMD' }).success).toBe(false);
    expect(schema.safeParse({ ...windows, command: 'C:\\tools\\launch.bat' }).success).toBe(false);
  });

  it('preserves own __proto__ environment mappings through schema and digest', () => {
    const env = JSON.parse('{"__proto__":{"fromHostEnv":"TOKEN"}}') as McpServerConfig['env'];
    const parsed = mcpServerConfigSchema.parse(config({ env }));
    expect(Object.keys(parsed.env)).toEqual(['__proto__']);
    expect(mcpConfigDigest(parsed)).not.toBe(mcpConfigDigest(config()));
    expect(Object.getPrototypeOf(parsed.env)).toBe(Object.prototype);
  });
});

describe('MCP explicit environment resolution', () => {
  it('reads only explicit references once and freezes each connection environment', () => {
    const reads: string[] = [];
    let secret = 'first-secret';
    const input = config({
      env: {
        A: { fromHostEnv: 'TOKEN' },
        B: { fromHostEnv: 'TOKEN' },
        EMPTY: { fromHostEnv: 'EMPTY_TOKEN' },
      },
    });
    const resolved = resolveMcpEnvironment(input, {
      readHostVariable(name) {
        reads.push(name);
        return name === 'EMPTY_TOKEN' ? '' : secret;
      },
    });
    secret = 'rotated-secret';
    expect(reads).toEqual(['TOKEN', 'EMPTY_TOKEN']);
    expect(resolved.env).toEqual({ A: 'first-secret', B: 'first-secret', EMPTY: '' });
    expect(resolved.redactValues).toEqual(['first-secret']);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.env)).toBe(true);
    expect(Object.isFrozen(resolved.redactValues)).toBe(true);
  });

  it('preserves __proto__ targets without changing the resolved environment prototype', () => {
    const env = JSON.parse('{"__proto__":{"fromHostEnv":"TOKEN"}}') as McpServerConfig['env'];
    const resolved = resolveMcpEnvironment(config({ env }), {
      readHostVariable: () => 'secret-token',
    });
    expect(Object.keys(resolved.env)).toEqual(['__proto__']);
    expect(Object.getOwnPropertyDescriptor(resolved.env, '__proto__')?.value).toBe('secret-token');
    expect(Object.getPrototypeOf(resolved.env)).toBe(Object.prototype);
    expect(resolved.redactValues).toEqual(['secret-token']);
  });

  it('rejects accessors in environment mappings without invoking them', () => {
    let reads = 0;
    const env = Object.defineProperty({}, 'TOKEN', {
      enumerable: true,
      get() {
        reads++;
        return { fromHostEnv: 'TOKEN' };
      },
    });
    expect(mcpServerConfigSchema.safeParse(config({ env })).success).toBe(false);
    expect(reads).toBe(0);
  });

  it('does not read host variables for empty mappings and safely rejects missing or throwing readers', () => {
    expect(
      resolveMcpEnvironment(config(), {
        readHostVariable() {
          throw new Error('must not read');
        },
      }),
    ).toEqual({ env: {}, redactValues: [] });
    for (const readHostVariable of [
      () => undefined,
      () => {
        throw new Error('raw-secret-value');
      },
    ]) {
      expect(() =>
        resolveMcpEnvironment(config({ env: { TOKEN: { fromHostEnv: 'HOST_TOKEN' } } }), {
          readHostVariable,
        }),
      ).toThrow(
        expect.objectContaining({
          code: 'mcp-invalid',
          message: 'MCP environment references could not be resolved',
        }),
      );
    }
  });
});
