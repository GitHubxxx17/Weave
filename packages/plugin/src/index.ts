export {
  panelLimits,
  declarativePanelSchema,
  attributedPanelSchema,
  cloneDeclarativePanel,
} from './panels.js';
export type {
  DeclarativePanel,
  PanelBlock,
  FormField,
  Binding,
  Value,
  PanelSource,
  Scalar,
  DataPath,
  PanelsExtensionApi,
  AttributedPanel,
} from './panels.js';
export { pluginApiVersion } from './constants.js';
export { assertEngineSupported, assertHostVersion } from './declaration.js';

export {
  commandArgumentsPlaceholder,
  commandNamePattern,
  pluginCommandSchema,
} from './commands.js';
export type { PluginCommand } from './commands.js';
export {
  attributedSkillContributionSchema,
  skillContributionSchema,
  skillNamePattern,
  isSkillResourcePath,
} from './skills.js';
export type {
  SkillContribution,
  AttributedSkillContribution,
  SkillsExtensionApi,
} from './skills.js';
export type {
  SkillRef,
  SkillSummary,
  SkillSource,
  SkillCatalog,
  SkillPage,
  SkillIssue,
} from '@weave/runtime';
export { pluginManifestSchema } from './manifest.js';
export type {
  ContributedNameKey,
  PluginCapability,
  PluginContributes,
  PluginHost,
  PluginManifest,
  PluginPermission,
} from './manifest.js';
export { attributePluginError, PluginError } from './plugin-errors.js';
export type { PluginErrorCode, PluginErrorOptions } from './plugin-errors.js';
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
  ServiceConsumer,
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
export {
  confirmationRequiredHookIds,
  hookImpacts,
  requiresHookConfirmation,
} from './hook-risk.js';
export type { HookImpact, HookRiskLevel } from './hook-risk.js';
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
export {
  createPluginEventRegistry,
  createPluginEventReader,
  createPluginSessionStore,
} from './plugin-events.js';
export type {
  PluginEventInfo,
  PluginEventReader,
  PluginEventDefinition,
  PluginEventHandle,
  PluginEventProjection,
  PluginEventRecord,
  PluginEventRegistry,
  PluginEventSpec,
  PluginNewEvent,
  ProjectedPluginEventHandle,
  ProjectedPluginEventSpec,
} from './plugin-events.js';
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
export { createRestrictedApprovalBroker } from './approval-view.js';
export type { PluginApprovalBroker } from './approval-view.js';
export {
  agentRunnerRef,
  approvalBrokerRef,
  commandsExtensionPoint,
  eventsExtensionPoint,
  llmProviderRegistryRef,
  llmProvidersExtensionPoint,
  llmRequestHook,
  panelsExtensionPoint,
  pluginEventsRef,
  promptSectionsExtensionPoint,
  sessionStoreRef,
  skillsExtensionPoint,
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
  CommandsExtensionApi,
  LlmProvidersExtensionApi,
  PromptSection,
  PromptSectionsExtensionApi,
  SessionEventsExtensionApi,
  ToolsExtensionApi,
  TurnEndInfo,
  TurnInfo,
} from './seams.js';

// The SDK the host passes to a plugin it loads from disk (Stage 4).
export { createPluginSdk } from './sdk.js';
export type { PluginFactory, PluginModule, PluginSdk } from './sdk.js';
