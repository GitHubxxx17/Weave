export interface McpToolSnapshot {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface McpValidationResult {
  readonly valid: boolean;
  readonly issue?: string;
}

export interface McpContentBlock {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface McpCallResult {
  readonly content: readonly McpContentBlock[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface McpConnection {
  readonly tools: readonly McpToolSnapshot[];
  readonly stderrBytes: number;
  validateInput(toolName: string, input: unknown): McpValidationResult;
  callTool(
    name: string,
    input: Readonly<Record<string, unknown>>,
    options: { readonly signal: AbortSignal },
  ): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** Resolved launch parameters; the host must authorize these before calling. */
export interface ConnectMcpOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly onStale?: () => void;
  readonly onClosed?: () => void;
}
