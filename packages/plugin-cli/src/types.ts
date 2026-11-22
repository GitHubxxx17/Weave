import type { PluginManifest } from '@weave/plugin';
import type { PluginArtifact } from '@weave/plugin-host';

export type PluginTemplate = 'tool' | 'command' | 'skills';
export type PluginVariant = 'entry' | 'skills';
export interface OperationOptions {
  readonly signal?: AbortSignal | undefined;
}
export interface SdkOptions {
  readonly sdkDirectory?: string | undefined;
}
export interface HostOptions {
  readonly hostVersion?: string | undefined;
}
export interface CreatePluginProjectOptions extends OperationOptions, SdkOptions {
  readonly template: PluginTemplate;
  readonly id: string;
  readonly directory: string;
  readonly name?: string | undefined;
}
export interface CreatedPluginProject {
  readonly command: 'create';
  readonly projectDirectory: string;
  readonly variant: PluginVariant;
  readonly files: readonly string[];
}
export type ValidatePluginOptions = OperationOptions &
  HostOptions &
  (
    | ({ readonly sourceDirectory: string; readonly artifactDirectory?: never } & SdkOptions)
    | {
        readonly artifactDirectory: string;
        readonly sourceDirectory?: never;
        readonly sdkDirectory?: never;
      }
  );
export type ValidatedPlugin =
  | {
      readonly mode: 'source';
      readonly variant: 'entry';
      readonly sourceDirectory: string;
      readonly manifest: PluginManifest;
      readonly sdkDirectory: string;
    }
  | { readonly mode: 'artifact'; readonly artifact: PluginArtifact };
export interface BuildPluginOptions extends OperationOptions, SdkOptions, HostOptions {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
}
export interface BuiltPlugin {
  readonly command: 'build';
  readonly outputDirectory: string;
  readonly payloadDirectory: string;
  readonly artifact: PluginArtifact;
}
export interface PackPluginOptions extends OperationOptions, HostOptions {
  readonly artifactDirectory: string;
  readonly outputDirectory: string;
}
export interface PluginPackReceipt {
  readonly schemaVersion: 1;
  readonly manifest: PluginManifest;
  readonly variant: PluginVariant;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly outputPath: string;
}
export interface PackedPlugin {
  readonly command: 'pack';
  readonly outputDirectory: string;
  readonly payloadDirectory: string;
  readonly receiptPath: string;
  readonly receipt: PluginPackReceipt;
}

// Internal seams. All callbacks below are authored by the CLI, never author configs.
export interface DirectorySnapshot {
  readonly directory: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly directories: readonly string[];
}
export interface SnapshotOptions extends OperationOptions {
  readonly maxFiles?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly maxFileBytes?: number | undefined;
  readonly maxDepth?: number | undefined;
  readonly maxEntries?: number | undefined;
}
export interface ResolvedPluginSdk {
  readonly directory: string;
  readonly typesPath: string;
  readonly typeRoots: readonly string[];
}
export interface PublishOutputOptions<T> extends OperationOptions {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly verifyInput: () => Promise<void>;
  readonly validatePayload: (directory: string) => Promise<T>;
  readonly receipt?: ((value: T, payloadDirectory: string) => unknown) | undefined;
}
export interface PublishedOutput<T> {
  readonly value: T;
  readonly payloadDirectory: string;
  readonly receiptPath?: string | undefined;
}
