import type { PluginDescriptor } from './descriptor.js';

export interface PluginArtifact {
  readonly digest: string;
  /** The concrete payload directory. */
  readonly directory: string;
  readonly descriptor: PluginDescriptor;
  readonly files: number;
  readonly bytes: number;
}

export interface PluginArtifactStoreOptions {
  /** The absolute path to the hidden managed store. */
  readonly directory: string;
  readonly hostVersion?: string | undefined;
  readonly reservedIds?: readonly string[] | undefined;
}

export interface StagePluginArtifactOptions {
  readonly sourceDirectory: string;
  readonly signal?: AbortSignal | undefined;
}

export interface ReadPluginArtifactOptions {
  readonly signal?: AbortSignal | undefined;
}

/** One instance serializes operations. The caller owns exclusive use of the directory. */
export interface PluginArtifactStore {
  stage(options: StagePluginArtifactOptions): Promise<PluginArtifact>;
  read(digest: string, options?: ReadPluginArtifactOptions): Promise<PluginArtifact>;
}

export type PluginArtifactErrorCode =
  | 'plugin-artifact-invalid'
  | 'plugin-artifact-source-changed'
  | 'plugin-artifact-unsupported-file'
  | 'plugin-artifact-too-large'
  | 'plugin-artifact-capacity'
  | 'plugin-artifact-conflict'
  | 'plugin-artifact-not-found'
  | 'plugin-artifact-corrupt'
  | 'plugin-artifact-io';

export class PluginArtifactError extends Error {
  constructor(
    readonly code: PluginArtifactErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'PluginArtifactError';
  }
}
