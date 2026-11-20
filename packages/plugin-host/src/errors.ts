/** Stable error categories the plugin host reports about a plugin on disk. */
export type PluginHostErrorCode =
  // The plugin directory is not usable.
  | 'plugin-invalid-descriptor'
  | 'plugin-entry-invalid'
  | 'plugin-unsupported-file'
  | 'plugin-too-large'
  | 'plugin-unreadable'
  | 'plugin-duplicate-id'
  | 'plugin-id-reserved'
  // The plugin cannot run on this host.
  | 'plugin-host-unsupported'
  // Loading a trusted plugin.
  | 'plugin-digest-mismatch'
  | 'plugin-load-failed'
  | 'plugin-invalid-module'
  | 'plugin-manifest-mismatch';

/** Options of a {@link PluginHostError}. */
export interface PluginHostErrorOptions extends ErrorOptions {
  /** The plugin the failure belongs to, once its id is known. */
  readonly pluginId?: string | undefined;
}

/** Error raised when a plugin on disk cannot be read, checked or loaded. */
export class PluginHostError extends Error {
  readonly code: PluginHostErrorCode;
  /** The plugin the failure belongs to; undefined while the id is still unknown. */
  readonly pluginId: string | undefined;

  constructor(code: PluginHostErrorCode, message: string, options?: PluginHostErrorOptions) {
    super(message, options);
    this.name = 'PluginHostError';
    this.code = code;
    this.pluginId = options?.pluginId;
  }
}

/** The text of an error, for a message that wraps it. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
