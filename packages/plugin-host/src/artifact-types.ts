import path from 'node:path';

import { pluginManifestSchema, type PluginManifest } from '@weave/plugin';
import { z } from 'zod';

import type { PluginDescriptor } from './descriptor.js';

export interface PluginArtifact {
  readonly digest: string;
  /** The concrete payload directory. */
  readonly directory: string;
  /** The absolute path to the validated payload entry. */
  readonly entry: string;
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

export interface PluginArtifactSourceIdentity {
  /** The normalized directory inspected for this review. */
  readonly sourceDirectory: string;
  readonly digest: string;
  readonly manifest: PluginManifest;
  readonly files: number;
  readonly bytes: number;
}

export const artifactDirectorySchema = z
  .string()
  .refine((directory) => path.isAbsolute(directory) && !directory.includes('\0'));
export const artifactDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const pluginArtifactSourceIdentitySchema: z.ZodType<PluginArtifactSourceIdentity> =
  z.strictObject({
    sourceDirectory: artifactDirectorySchema,
    digest: artifactDigestSchema,
    manifest: pluginManifestSchema.refine(
      (manifest) => manifest.contributes !== undefined && manifest.permissions !== undefined,
      { message: 'Plugin artifacts require contributes and permissions declarations' },
    ),
    files: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
  });

export interface PreviewPluginArtifactOptions {
  readonly sourceDirectory: string;
  readonly signal?: AbortSignal | undefined;
}

export interface StagePluginArtifactOptions extends PreviewPluginArtifactOptions {
  readonly expectedSource?: PluginArtifactSourceIdentity | undefined;
}

export interface ReadPluginArtifactOptions {
  readonly signal?: AbortSignal | undefined;
}

/** One instance serializes operations. The caller owns exclusive use of the directory. */
export interface PluginArtifactStore {
  preview(options: PreviewPluginArtifactOptions): Promise<PluginArtifactSourceIdentity>;
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
