export { pluginApiVersion } from './constants.js';

export { pluginManifestSchema } from './manifest.js';
export type {
  ContributedNameKey,
  PluginCapability,
  PluginContributes,
  PluginHost,
  PluginManifest,
  PluginPermission,
} from './manifest.js';
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
export { adaptLegacyPlugin } from './legacy-plugin.js';
export type { AdaptedLegacyPlugin, AdaptLegacyPluginOptions } from './legacy-plugin.js';

// Typed plugin kernel (Stage 1).
export { defineServiceRef, ServiceContainer, rootScopeKey } from './service.js';
export type {
  DepMap,
  Disposer,
  Resolved,
  ScopeContext,
  ServiceImpl,
  ServiceInitContext,
  ServiceRef,
  ServiceScope,
} from './service.js';
export { defineExtensionPoint, ExtensionRegistry } from './extension-point.js';
export type {
  ContributionCheck,
  ExtensionCollector,
  ExtensionPoint,
  GovernedContribution,
  PluginDeclaration,
} from './extension-point.js';
export { defineHook, HookRegistry } from './hook.js';
export type {
  DecideHandler,
  Hook,
  HookMode,
  ObserveHandler,
  PolicyVote,
  WrapHandler,
} from './hook.js';
export { createPluginEnv } from './plugin-env.js';
export type { PluginEnv, PluginEnvDeps, ServiceHandle } from './plugin-env.js';
export { createPluginKernel, definePlugin } from './kernel.js';
export type {
  Generation,
  KernelPlugin,
  PluginContributed,
  PluginInfo,
  PluginKernel,
  PluginKernelOptions,
} from './kernel.js';

// Weave seams (Stage 2): typed service refs, extension points and hooks for
// Weave's own subsystems, typed against the real library contracts.
export {
  agentRunnerRef,
  approvalBrokerRef,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  llmRequestHook,
  promptSectionsExtensionPoint,
  sessionStoreRef,
  toolAroundHook,
  toolPipelineRef,
  toolPolicyHook,
  toolRegistryRef,
  toolResultHook,
  toolsExtensionPoint,
  turnEndHook,
  turnStartHook,
} from './seams.js';
export type {
  LlmProvidersExtensionApi,
  PromptSection,
  PromptSectionsExtensionApi,
  ToolsExtensionApi,
  TurnEndInfo,
  TurnInfo,
} from './seams.js';
