/** Stable error categories exposed by the Plugin boundary. */
export type PluginErrorCode =
  | 'plugin-invalid-manifest'
  | 'plugin-invalid-definition'
  | 'plugin-api-version-unsupported'
  | 'plugin-duplicate-id'
  | 'plugin-capability-not-declared'
  | 'plugin-setup-failed'
  | 'plugin-registration-conflict'
  | 'plugin-dispose-failed'
  // Kernel: typed services
  | 'plugin-service-missing-dependency'
  | 'plugin-service-cycle'
  | 'plugin-service-duplicate'
  | 'plugin-service-scope-violation'
  // Kernel: extension points
  | 'plugin-extension-single-slot'
  // Kernel: manifest declarations
  | 'plugin-contributes-exceeds-manifest'
  | 'plugin-permission-denied'
  | 'plugin-engine-unsupported'
  // Kernel: a plugin's contribution or service failed while the host used it
  | 'plugin-contribution-failed'
  // Kernel: hooks
  | 'plugin-hook-invalid-vote'
  // Kernel: session events
  | 'plugin-event-unknown'
  | 'plugin-event-invalid';

/** Options of a {@link PluginError}. */
export interface PluginErrorOptions extends ErrorOptions {
  /** The plugin the failure belongs to, when one plugin is to blame. */
  readonly pluginId?: string | undefined;
}

/** Error raised when a Plugin cannot be validated, registered or disposed. */
export class PluginError extends Error {
  readonly code: PluginErrorCode;
  /**
   * The plugin that caused the failure, when it is known. A host uses it to drop
   * that one plugin and carry on with the rest. Failures that no single plugin
   * caused, such as a dependency cycle, leave it undefined.
   */
  readonly pluginId: string | undefined;

  constructor(code: PluginErrorCode, message: string, options?: PluginErrorOptions) {
    super(message, options);
    this.name = 'PluginError';
    this.code = code;
    this.pluginId = options?.pluginId;
  }
}

/**
 * Returns `error` as a {@link PluginError} that names `pluginId`. An error that
 * already names a plugin comes back as it is. A plugin error without one is
 * copied with the name added. Any other error is wrapped in a
 * `plugin-contribution-failed` error that keeps it as `cause` and begins its
 * message with `context`.
 */
export function attributePluginError(
  error: unknown,
  pluginId: string,
  context: string,
): PluginError {
  if (error instanceof PluginError) {
    if (error.pluginId !== undefined) {
      return error;
    }
    const copy = new PluginError(error.code, error.message, {
      ...(error.cause === undefined ? {} : { cause: error.cause }),
      pluginId,
    });
    if (error.stack !== undefined) {
      copy.stack = error.stack;
    }
    return copy;
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PluginError('plugin-contribution-failed', `${context}: ${detail}`, {
    cause: error,
    pluginId,
  });
}
