export type McpAuthorityErrorCode =
  | 'mcp-invalid'
  | 'mcp-not-found'
  | 'mcp-conflict'
  | 'mcp-authority-protocol'
  | 'mcp-authority-storage'
  | 'mcp-authority-busy'
  | 'mcp-closed'
  | 'mcp-content-changed'
  | 'mcp-content-too-large'
  | 'mcp-content-unreadable';

const messages: Readonly<Record<McpAuthorityErrorCode, string>> = {
  'mcp-invalid': 'MCP management input is invalid',
  'mcp-not-found': 'MCP server was not found',
  'mcp-conflict': 'MCP authority changed or the operation conflicts with current trust',
  'mcp-authority-protocol': 'MCP authority contains invalid persisted data',
  'mcp-authority-storage': 'MCP authority storage operation failed',
  'mcp-authority-busy': 'MCP authority database is temporarily busy',
  'mcp-closed': 'MCP authority is closed',
  'mcp-content-changed': '内容已变更，需要重新信任',
  'mcp-content-too-large':
    'MCP 绑定内容超出上限（最多 1000 个文件、20 MB），请缩小 contentPaths 范围',
  'mcp-content-unreadable':
    'MCP 绑定内容无法读取（含符号链接或特殊文件），请检查 command 与 contentPaths',
};

/** Fixed public errors never include launch configuration or resolved secrets. */
export class McpAuthorityError extends Error {
  constructor(
    readonly code: McpAuthorityErrorCode,
    message: string = messages[code],
  ) {
    super(message);
    this.name = 'McpAuthorityError';
  }
}
