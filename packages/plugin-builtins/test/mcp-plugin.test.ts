import type { McpConnection, McpToolSnapshot } from '@weave/mcp-client';
import { createPluginKernel, definePlugin, toolRegistryRef } from '@weave/plugin';
import { createToolRegistry } from '@weave/runtime';
import { describe, expect, it, vi } from 'vitest';
import { createMcpPlugin } from '../src/mcp-plugin.js';
import { createMcpTool, mcpToolName } from '../src/mcp-tool.js';
import { createToolRegistryPlugin } from '../src/tool-registry.js';

const snapshot: McpToolSnapshot = {
  name: 'echo',
  description: 'Echo',
  inputSchema: { type: 'object' },
};
function options(tools: readonly McpToolSnapshot[] = [snapshot]) {
  const close = vi.fn(async () => {});
  const connection: McpConnection = {
    tools,
    stderrBytes: 0,
    validateInput: () => ({ valid: true }),
    callTool: async () => ({ content: [] }),
    close,
  };
  return { serverId: 'test', label: 'Test server', cwd: '/fixed', connection };
}

describe('MCP kernel plugin', () => {
  it('contributes a closed host:mcp tool catalog and leaves connection ownership to the source', async () => {
    const opts = options();
    const plugin = createMcpPlugin(opts);
    expect(plugin.manifest).toMatchObject({
      id: 'mcp-test',
      name: 'Test server',
      version: '1.0.0',
      apiVersion: '1.0.0',
      host: 'mcp',
      capabilities: ['tool'],
      contributes: { tools: [mcpToolName('test', 'echo')] },
    });
    const kernel = createPluginKernel();
    await kernel.register(createToolRegistryPlugin());
    await kernel.register(plugin);
    const generation = await kernel.seal();
    const registry = await generation.resolve(toolRegistryRef);
    expect(registry.list().map((tool) => tool.name)).toEqual([mcpToolName('test', 'echo')]);
    expect(
      generation.plugins().find((item) => item.manifest.id === 'mcp-test')?.contributed,
    ).toMatchObject({
      tools: [mcpToolName('test', 'echo')],
      services: [],
      hooks: [],
      providers: [],
      commands: [],
    });
    await kernel.dispose();
    expect(opts.connection.close).not.toHaveBeenCalled();
  });

  it('freezes the catalog before setup so later caller changes add no undeclared tools', async () => {
    const tools = [snapshot];
    const plugin = createMcpPlugin(options(tools));
    tools.push({ ...snapshot, name: 'later' });
    const kernel = createPluginKernel();
    await kernel.register(createToolRegistryPlugin());
    await kernel.register(plugin);
    const generation = await kernel.seal();
    const registry = await generation.resolve(toolRegistryRef);
    expect(registry.list()).toHaveLength(1);
    await kernel.dispose();
  });

  it('rejects duplicate mapped names without silently dropping a tool', () => {
    expect(() => createMcpPlugin(options([snapshot, snapshot]))).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition', pluginId: 'mcp-test' }),
    );
  });

  it('attributes a tool collision to this MCP plugin without replacing the existing tool', async () => {
    const opts = options();
    const existing = createMcpTool(opts, snapshot);
    const registry = createToolRegistry();
    registry.register(existing);
    const kernel = createPluginKernel();
    await kernel.register(createToolRegistryPlugin({ registry }));
    await kernel.register(createMcpPlugin(opts));
    const generation = await kernel.seal();
    await expect(generation.resolve(toolRegistryRef)).rejects.toMatchObject({
      pluginId: 'mcp-test',
    });
    expect(registry.get(existing.name)).toBe(existing);
    await kernel.dispose();
  });

  it('rejects an existing plugin identity without renaming it', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: {
          id: 'mcp-test',
          name: 'existing',
          version: '1.0.0',
          apiVersion: '1.0.0',
          capabilities: ['tool'],
        },
        setup() {},
      }),
    );
    await expect(kernel.register(createMcpPlugin(options()))).rejects.toMatchObject({
      code: 'plugin-duplicate-id',
      pluginId: 'mcp-test',
    });
    await kernel.dispose();
  });

  it.each([
    { serverId: 'Bad_ID' },
    { label: '' },
    { cwd: 2 },
    { connection: {} },
    { redactValues: [2] },
  ])('rejects invalid external factory shape', (invalid) => {
    expect(() => createMcpPlugin({ ...options(), ...invalid } as never)).toThrowError(
      expect.objectContaining({ code: 'plugin-invalid-definition' }),
    );
  });

  it('does not expose a throwing factory getter or retain its raw cause', () => {
    const input = options();
    Object.defineProperty(input, 'label', {
      get() {
        throw new Error('private factory detail');
      },
    });
    let caught: unknown;
    try {
      createMcpPlugin(input);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'plugin-invalid-definition' });
    expect((caught as Error).message).not.toContain('private factory detail');
    expect((caught as Error).cause).toBeUndefined();
  });
});
