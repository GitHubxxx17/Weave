/** Stable error categories exposed by the Plugin boundary. */
export type PluginErrorCode =
  | 'plugin-invalid-manifest'
  | 'plugin-invalid-definition'
  | 'plugin-api-version-unsupported'
  | 'plugin-duplicate-id'
  | 'plugin-capability-not-declared'
  | 'plugin-setup-failed'
  | 'plugin-registration-conflict'
  | 'plugin-dispose-failed';

/** Error raised when a Plugin cannot be validated, registered or disposed. */
export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PluginError';
    this.code = code;
  }
}
