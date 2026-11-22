export { ExplicitLocalAuthorityError, PluginHostError } from './errors.js';
export type { PluginHostErrorCode, PluginHostErrorOptions } from './errors.js';

export { createPluginArtifactStore } from './artifact-store.js';
export { PluginArtifactError, pluginArtifactSourceIdentitySchema } from './artifact-types.js';
export type {
  PluginArtifact,
  PluginPayload,
  PluginArtifactErrorCode,
  PluginArtifactSourceIdentity,
  PluginArtifactStore,
  PluginArtifactStoreOptions,
  PreviewPluginArtifactOptions,
  ReadPluginArtifactOptions,
  StagePluginArtifactOptions,
} from './artifact-types.js';

export { descriptorFileName, maxDescriptorBytes, parseDescriptor } from './descriptor.js';
export type { PluginDescriptor } from './descriptor.js';
export { inspectPluginPayload } from './payload-inspector.js';
export type { InspectPluginPayloadOptions } from './payload-inspector.js';

export { computeDirectoryDigest, defaultDigestLimits } from './digest.js';
export type { DigestLimits, DigestOptions, DirectoryDigest } from './digest.js';

export { discoverLocalPlugins, inspectLocalPluginDeclarationClaims } from './discovery.js';
export type {
  DiscoverOptions,
  DiscoveryResult,
  IncompatibleLocalPlugin,
  InvalidLocalPlugin,
  LocalPluginCandidate,
  LocalPluginDeclarationClaims,
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
export {
  eligibleLocalSourceCandidates,
  localSourceCandidateIdentity,
} from './explicit-local-selection.js';
export { projectLocalPluginSnapshot } from './host-state.js';
export type {
  ExplicitLocalCandidateChecks,
  ExplicitLocalSelection,
  ExplicitLocalSelectionInput,
  LocalPluginSourceController,
  LocalPluginSourceMutation,
  LocalPluginSourceOptions,
  LocalPluginSourceSnapshot,
  LocalSourceAuthorityChange,
  LocalSourceAuthorityReason,
  LocalSourceCandidate,
  LocalSourceMutationContext,
  LocalSourceProjectionOptions,
  LocalSourceRecheck,
  LocalSourceStamp,
  ManagedLocalCandidate,
  PreparedLocalPlugin,
  ManagedPreparedIdentity,
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

export { createGithubPluginAcquirer } from './github-acquirer.js';
export { GithubAcquisitionError, githubPluginSourceSchema } from './github-source.js';
export type {
  GithubAcquisitionErrorCode,
  GithubPluginAcquirer,
  GithubPluginAcquirerOptions,
  GithubPluginSource,
} from './github-source.js';

export { parseSkillDocument } from './skill-document.js';
export { discoverSkillBundles, pinSkillBundle, readPinnedSkillResource } from './skills.js';
export { SkillHostError, createSkillScanBudget } from './skill-types.js';
export type {
  SkillHostErrorCode,
  SkillRootInput,
  DiskSkillHandle,
  DiscoveredSkillBundle,
  SkillResourceIdentity,
  SkillDiscoveryResult,
  PinnedSkillBundle,
  ParsedSkillDocument,
  SkillScanBudget,
  SkillIoOptions,
} from './skill-types.js';
