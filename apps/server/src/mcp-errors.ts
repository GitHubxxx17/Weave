export type McpAuthorityErrorCode =
  | 'mcp-invalid'
  | 'mcp-not-found'
  | 'mcp-conflict'
  | 'mcp-authority-protocol'
  | 'mcp-authority-storage'
  | 'mcp-closed';

const messages: Readonly<Record<McpAuthorityErrorCode, string>> = {
  'mcp-invalid': 'MCP management input is invalid',
  'mcp-not-found': 'MCP server was not found',
  'mcp-conflict': 'MCP authority changed or the operation conflicts with current trust',
  'mcp-authority-protocol': 'MCP authority contains invalid persisted data',
  'mcp-authority-storage': 'MCP authority storage operation failed',
  'mcp-closed': 'MCP authority is closed',
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
