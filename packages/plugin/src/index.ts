export { pluginApiVersion } from './constants.js';

export { pluginManifestSchema } from './manifest.js';
export type { PluginCapability, PluginManifest } from './manifest.js';
export { PluginError } from './plugin-errors.js';
export type { PluginErrorCode } from './plugin-errors.js';
export type {
  PluginContext,
  PluginSnapshot,
  StagedPluginContext,
  WeavePlugin,
} from './plugin-types.js';
export { createPluginRegistry } from './plugin-registry.js';
export type { PluginRegistry, PluginRegistryOptions } from './plugin-registry.js';
