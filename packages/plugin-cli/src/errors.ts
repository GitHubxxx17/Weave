export type PluginCliErrorCode =
  | 'plugin-cli-usage'
  | 'plugin-cli-invalid-project'
  | 'plugin-cli-sdk-invalid'
  | 'plugin-cli-source-policy'
  | 'plugin-cli-typecheck'
  | 'plugin-cli-bundle'
  | 'plugin-cli-output-conflict'
  | 'plugin-cli-path-overlap'
  | 'plugin-cli-source-changed'
  | 'plugin-cli-cancelled'
  | 'plugin-cli-io';

export class PluginCliError extends Error {
  readonly code: PluginCliErrorCode;
  constructor(code: PluginCliErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PluginCliError';
    this.code = code;
  }
}
