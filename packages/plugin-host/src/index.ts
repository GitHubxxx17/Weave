export { PluginHostError } from './errors.js';
export type { PluginHostErrorCode, PluginHostErrorOptions } from './errors.js';

export { createPluginArtifactStore } from './artifact-store.js';
export { PluginArtifactError } from './artifact-types.js';
export type {
  PluginArtifact,
  PluginArtifactErrorCode,
  PluginArtifactStore,
  PluginArtifactStoreOptions,
  ReadPluginArtifactOptions,
  StagePluginArtifactOptions,
} from './artifact-types.js';

export { descriptorFileName, maxDescriptorBytes, parseDescriptor } from './descriptor.js';
export type { PluginDescriptor } from './descriptor.js';

export { computeDirectoryDigest, defaultDigestLimits } from './digest.js';
export type { DigestLimits, DigestOptions, DirectoryDigest } from './digest.js';

export { discoverLocalPlugins } from './discovery.js';
export type {
  DiscoverOptions,
  DiscoveryResult,
  IncompatibleLocalPlugin,
  InvalidLocalPlugin,
  LocalPluginCandidate,
  LocalPluginIssue,
  ReadyLocalPlugin,
} from './discovery.js';

export {
  contributesKeys,
  createMemoryTrustStore,
  diffManifests,
  foldTrust,
  pluginTrustEventSchema,
  recordedPluginTrustEventSchema,
  resolveLocalPlugins,
} from './trust.js';
export type {
  ContributesKey,
  ListDiff,
  LocalPluginState,
  ManifestDiff,
  MemoryTrustStoreOptions,
  PluginTrustEvent,
  PluginTrustRecord,
  PluginTrustStore,
  RecordedPluginTrustEvent,
  ResolvedLocalPlugin,
} from './trust.js';

export { loadLocalPlugin } from './loader.js';
export type { LoadLocalPluginOptions, LocalPluginSource } from './loader.js';

export { createGenerationRunner } from './generation-runner.js';
export type {
  GenerationCommit,
  GenerationController,
  GenerationRequest,
  GenerationRunner,
  RunnerGeneration,
} from './generation-runner.js';

export { createPluginHost } from './host.js';
export { createLocalPluginSource } from './local-plugin-source.js';
export { projectLocalPluginSnapshot } from './host-state.js';
export type {
  LocalPluginSourceController,
  LocalPluginSourceMutation,
  LocalPluginSourceOptions,
  LocalPluginSourceSnapshot,
  LocalSourceAuthorityChange,
  LocalSourceAuthorityReason,
  LocalSourceMutationContext,
  LocalSourceProjectionOptions,
  LocalSourceRecheck,
  LocalSourceStamp,
  PreparedLocalPlugin,
  PreparedLocalPluginFailure,
  PreparedLocalPlugins,
} from './local-source-types.js';
export type {
  ActiveLocalPlugin,
  CreatePluginHostOptions,
  HostedLocalPluginState,
  LocalPluginIdentity,
  LocalPluginRecord,
  PluginGenerationPort,
  PluginHost,
  PluginHostSnapshot,
  PluginReloadFailure,
  ReloadResult,
} from './host-types.js';
