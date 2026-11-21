import type { McpConnection } from '@weave/mcp-client';
import {
  definePlugin,
  PluginError,
  pluginApiVersion,
  toolsExtensionPoint,
  type KernelPlugin,
} from '@weave/plugin';
import { createMcpTool, parseMcpPluginOptions } from './mcp-tool.js';
import { redactMcpText } from './mcp-result.js';

export interface McpPluginOptions {
  readonly serverId: string;
  readonly label: string;
  readonly cwd: string;
  readonly connection: McpConnection;
  readonly redactValues?: readonly string[];
}

/** Source/generation owns the already authorized connection, including disposal. */
export function createMcpPlugin(options: McpPluginOptions): KernelPlugin {
  const resolved = parseMcpPluginOptions(options);
  try {
    const tools = Object.freeze(
      resolved.connection.tools.map((snapshot) => createMcpTool(resolved, snapshot)),
    );
    const names = Object.freeze(tools.map((tool) => tool.name));
    if (new Set(names).size !== names.length) throw new Error();
    return definePlugin({
      manifest: Object.freeze({
        id: `mcp-${resolved.serverId}`,
        name: redactMcpText(resolved.label, resolved.redactValues),
        version: '1.0.0',
        apiVersion: pluginApiVersion,
        host: 'mcp',
        capabilities: Object.freeze(['tool'] as const),
        contributes: Object.freeze({ tools: names }),
      }),
      setup(env) {
        env.contribute(toolsExtensionPoint, (api) => {
          for (const tool of tools) api.addTool(tool);
        });
      },
    });
  } catch {
    throw new PluginError(
      'plugin-invalid-definition',
      'The MCP tool plugin definition is invalid.',
      { pluginId: `mcp-${resolved.serverId}` },
    );
  }
}
