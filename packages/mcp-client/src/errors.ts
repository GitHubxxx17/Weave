export type McpClientErrorCode =
  | 'mcp-unsupported-schema'
  | 'mcp-invalid-input'
  | 'mcp-invalid-result'
  | 'mcp-catalog-limit'
  | 'mcp-invalid-catalog'
  | 'mcp-connect-failed'
  | 'mcp-call-failed'
  | 'mcp-busy'
  | 'mcp-cancelled'
  | 'mcp-timeout'
  | 'mcp-closed'
  | 'mcp-close-failed';

const messages: Record<McpClientErrorCode, string> = {
  'mcp-unsupported-schema': 'The MCP service uses an unsupported tool schema.',
  'mcp-invalid-input': 'MCP tool arguments do not match the declared schema.',
  'mcp-invalid-result': 'The MCP service returned an invalid tool result.',
  'mcp-catalog-limit': 'The MCP tool catalog exceeds the supported limits.',
  'mcp-invalid-catalog': 'The MCP service returned an invalid tool catalog.',
  'mcp-connect-failed': 'The MCP service could not be initialized.',
  'mcp-call-failed': 'The MCP tool call failed.',
  'mcp-busy': 'The MCP service has reached its concurrent call limit.',
  'mcp-cancelled': 'The MCP operation was cancelled.',
  'mcp-timeout': 'The MCP operation exceeded its time limit.',
  'mcp-closed': 'The MCP connection is closed.',
  'mcp-close-failed': 'The MCP connection could not be closed within its time limit.',
};

/** Intentionally does not retain arbitrary SDK errors or child process output. */
export class McpClientError extends Error {
  constructor(readonly code: McpClientErrorCode) {
    super(messages[code]);
    this.name = 'McpClientError';
  }
}
