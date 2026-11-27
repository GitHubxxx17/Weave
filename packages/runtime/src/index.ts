export {
  createRetrievalService,
  retrievalAgentRequestId,
  describeRetrievalQueryBatch,
} from './retrieval-service.js';
export { createRetrievalTools } from './retrieval-tools.js';
export type { RetrievalTools } from './retrieval-tools.js';
export { RetrievalError, isRetrievalError } from './retrieval-errors.js';
export {
  createRetrievalEgress,
  issueLocalRetrievalPermit,
  revokeRetrievalPermit,
} from './retrieval-egress.js';
export { describeRetrievalCaller, retrievalCallerAuthority } from './retrieval-caller.js';
export { createRetrievalWorkspaceCapture } from './retrieval-capture.js';
export type * from './retrieval-types.js';
export { createRuntime } from './runtime.js';
export { MemoryError } from './memory-errors.js';
export { createMemoryService } from './memory-service.js';
export type { MemoryService, MemoryWriteIntent, MemoryReadPage } from './memory-service.js';
export { createMemoryTools } from './memory-tools.js';
export type { MemoryTools } from './memory-tools.js';
export type { MemoryErrorCode } from './memory-errors.js';
export type {
  MemoryScopeEvidence,
  MemoryLocalScopeEvidence,
  MemorySessionMembership,
  MemoryStorePort,
  MemoryStoreWritePort,
  MemoryServiceOptions,
  MemoryInvalidation,
  BeforeMemoryCommit,
  ReviewedMemoryCapture,
  ReviewedMemoryAccessCapture,
  ReviewedMemorySource,
} from './memory-types.js';
export { memoryCallerAuthority, configureMemoryToolDefinition } from './memory-tool-attempt.js';
export { AgentTaskError, createAgentTaskService } from './agent-task-service.js';
export type {
  AgentTaskErrorCode,
  AgentTaskService,
  AgentTaskServiceOptions,
  AgentTaskSpawnReceipt,
} from './agent-task-service.js';
export { AgentTaskHostError } from './agent-task-host.js';
export type { AgentTaskHost, AgentTaskLifetime, AgentTaskReservation } from './agent-task-host.js';
export { createAgentExecutionService } from './agent-execution-service.js';
export {
  AgentExecutionError,
  agentExecutionInputSchema,
  agentExecutionLaunchSchema,
  agentExecutionStatusSchema,
  agentExecutionCursorSchema,
  agentExecutionSummarySchema,
  agentExecutionSnapshotSchema,
  agentExecutionFrameSchema,
  agentExecutionQueueEntrySchema,
  agentExecutionQueueSnapshotSchema,
  agentExecutionQueueCursorSchema,
  agentExecutionEffectiveSettingsSchema,
  agentExecutionQueueReorderSchema,
  agentExecutionQueuedCancelSchema,
} from './agent-execution-types.js';
export type {
  AgentExecutionInput,
  AgentExecutionLaunch,
  AgentExecutionStatus,
  AgentExecutionSummary,
  AgentExecutionSnapshot,
  AgentExecutionFrame,
  AgentExecutionQueueEntry,
  AgentExecutionQueueSnapshot,
  AgentExecutionEffectiveSettings,
  AgentExecutionQueueReorder,
  AgentExecutionQueuedCancel,
  AgentExecutionQueueSubscription,
  AgentExecutionSubscription,
  AgentExecutionService,
  AgentExecutionServiceOptions,
  CaptureContexts,
  CaptureContextsOptions,
  CaptureFiles,
  CaptureFilesOptions,
  AgentExecutionErrorCode,
} from './agent-execution-types.js';
export type {
  SkillRef,
  SkillSource,
  SkillSummary,
  SkillIssue,
  SkillCatalog,
  SkillPage,
  TurnRequestMetadata,
} from '@weave/protocol';
export { createSessionEventStoreService } from './session-service.js';
export type {
  Runtime,
  RuntimeContext,
  RuntimeOptions,
  RuntimeService,
  RuntimeStatus,
} from './types.js';
export type {
  SessionEventStoreFactory,
  SessionEventStoreServiceOptions,
} from './session-service.js';
// Re-exported so the plugin layer can type the session-store seam and the
// events that cross it without a direct @weave/session dependency (the plugin
// boundary allows llm + runtime). Types only: the plugin kernel carries no
// runtime dependency on a library.
export type {
  NewSessionEvent,
  PluginEventType,
  SessionEvent,
  SessionEventStore,
} from '@weave/session';
export { AgentRunError, agentRunRequestSchema, agentRuntimeEventSchema } from './agent-types.js';
export type {
  AgentInstructionsContext,
  AgentCompletionReason,
  AgentRunErrorCode,
  AgentRunner,
  AgentRunnerOptions,
  AgentContextOptions,
  AgentRunRequest,
  AgentRuntimeEvent,
  LlmCall,
  LlmMiddleware,
} from './agent-types.js';
export { defaultAgentMaxToolResultTokens, createAgentRunner } from './agent-runner.js';
export {
  ToolExecutionError,
  toolDefinitionSchema,
  toolExecutionRequestSchema,
  toolPermissionModeSchema,
} from './tool-types.js';
export type {
  ToolDefinition,
  ToolApprovalRequirement,
  ToolApprovalSummary,
  RegisteredToolDefinition,
  ToolExecutionContext,
  ToolExecutionErrorCode,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPermissionMode,
} from './tool-types.js';
export { createToolRegistry } from './tool-registry.js';
export type { ToolRegistry } from './tool-registry.js';
export {
  createRecallTool,
  createSessionRecallResolver,
  recallInputSchema,
} from './context/recall-tool.js';
export type { RecallInput, RecallResolver, RecallToolResult } from './context/recall-tool.js';
export {
  createUpdatePlanTool,
  parsePlanFromToolCall,
  updatePlanInputSchema,
  updatePlanToolName,
} from './update-plan-tool.js';
export type { UpdatePlanInput } from './update-plan-tool.js';
export { defaultToolResultMaxBytes, createToolPipeline } from './tool-pipeline.js';
export type {
  ToolAround,
  ToolPipeline,
  ToolPipelineOptions,
  ToolPolicy,
  ToolPolicyVote,
} from './tool-pipeline.js';
export {
  WorkspacePolicyError,
  workspacePathRequestSchema,
  workspacePolicyOptionsSchema,
} from './workspace-types.js';
export type {
  WorkspaceOperation,
  WorkspacePath,
  WorkspacePolicyErrorCode,
  WorkspacePolicyOptions,
} from './workspace-types.js';
export { createWorkspacePolicy } from './workspace-policy.js';
export type { WorkspacePolicy } from './workspace-policy.js';
export {
  WorkspaceFileError,
  defaultReadLineLimit,
  editFileInputSchema,
  readFileInputSchema,
  writeFileInputSchema,
} from './workspace-file-types.js';
export type {
  EditFileInput,
  EditFileResult,
  ReadFileInput,
  WriteFileInput,
  WriteFileResult,
  WorkspaceFileErrorCode,
  WorkspaceFileToolLimits,
  WorkspaceFileToolOptions,
  WorkspaceFileTools,
  WorkspaceResolver,
  WorkspaceSource,
  WorkspaceFileSnapshot,
  WorkspaceFileWriteIntent,
  WorkspaceFileWriteOutcome,
  WorkspaceFileSnapshotHook,
} from './workspace-file-types.js';
export { createWorkspaceFileTools } from './workspace-file-tools.js';
export { isSensitiveWritePath, type SensitivePathReason } from './sensitive-paths.js';
export { captureWorkspaceFiles } from './workspace-file-capture.js';
export {
  captureWorkspaceContexts,
  checkGitChangesAvailable,
  gitChangesUnavailableMessage,
} from './workspace-context-capture.js';
export type { CaptureWorkspaceContextsOptions } from './workspace-context-capture.js';
export { restoreFileSnapshot } from './file-undo.js';
export type { RestorableFileSnapshot, RestoreFileOutcome } from './file-undo.js';
export {
  createWorkspaceSearchTools,
  globInputSchema,
  grepInputSchema,
  listDirInputSchema,
} from './workspace-search-tools.js';
export type {
  GlobInput,
  GrepInput,
  ListDirInput,
  WorkspaceSearchToolOptions,
  WorkspaceSearchTools,
} from './workspace-search-tools.js';
export { listWorkspaceFiles, readWorkspaceFileContent } from './workspace-browse.js';
export type { WorkspaceFileContent, WorkspaceFileListing } from './workspace-browse.js';
export { readGitBaseContent } from './workspace-git.js';
export type { GitBaseContent } from './workspace-git.js';
export {
  createCommandTool,
  defaultCommandTimeoutMs,
  maxCommandTimeoutMs,
  runCommandInputSchema,
} from './command-tool.js';
export type { CommandToolOptions, RunCommandInput } from './command-tool.js';
export {
  defaultCommandShell,
  filterCommandEnvironment,
  resolveLoginShellEnvironment,
} from './shell-environment.js';
export {
  ApprovalError,
  approvalDecisionSchema,
  approvalRequestSchema,
  createApprovalRequestInputSchema,
} from './approval-types.js';
export type {
  ApprovalBroker,
  ApprovalDecision,
  ApprovalEvent,
  ApprovalErrorCode,
  ApprovalListener,
  ApprovalRequest,
  ApprovalRisk,
  ApprovalStatus,
  CreateApprovalRequestInput,
} from './approval-types.js';
export { createApprovalBroker } from './approval-broker.js';

export { estimateTokens } from './context/token-estimate.js';
export {
  createSkillTools,
  readSkillInputSchema,
  readSkillResourceInputSchema,
  readSkillToolName,
  readSkillResourceToolName,
} from './skill-tools.js';
export type {
  ReadSkillInput,
  ReadSkillResourceInput,
  SkillToolPorts,
  SkillTools,
} from './skill-tools.js';

export {
  workspaceRootIdentity,
  workspaceRootIdentitySync,
  workspaceFileIdentity,
  fileContentDigest,
  withWorkspaceMutation,
} from './workspace-mutation.js';
export { createFileUndoService, FileUndoError } from './file-undo-service.js';
export type { FileUndoInput, FileUndoReviewInput, FileUndoResponse } from './file-undo-service.js';

export {
  agentToolAuthorityParent,
  createAgentToolAuthority,
  deriveAgentToolAuthority,
  describeAgentToolAuthority,
  readAgentToolAuthority,
} from './agent-tool-authority.js';
export type {
  AgentToolAuthority,
  AgentToolRunIdentity,
  AgentToolAuthoritySettings,
  AgentToolAuthorityView,
  AgentToolInvocationAuthority,
  AgentToolAuthorityLifetime,
  CreateAgentToolAuthorityOptions,
  DeriveAgentToolAuthorityOptions,
} from './agent-tool-authority.js';
export {
  agentTaskExecutionIdentity,
  agentTaskExecutionInput,
  agentTaskFactDigest,
  agentTaskOrigin,
  agentTaskRequestDigest,
  reconcileAgentTask,
} from './agent-task-reconcile.js';
export type {
  AgentTaskParentPrefix,
  AgentTaskReconciliation,
  AgentTaskReconciliationBlock,
  BoundTaskIdentity,
  TaskExecutionCleanup,
  TaskProjectRelation,
} from './agent-task-types.js';
export {
  adaptTaskRunnerLease,
  getBoundTaskExecutionPort,
  mintTaskLaunchAuthority,
} from './agent-task-execution.js';
export type {
  AdaptTaskRunnerLeaseOptions,
  BoundTaskExecutionPort,
  BoundTaskLaunch,
  MintTaskLaunchAuthorityOptions,
  TaskLaunchAuthority,
  TaskRunnerLease,
} from './agent-task-execution.js';
export { createAgentTaskObserver } from './agent-task-observer.js';
export type { AgentTaskObserver, AgentTaskTreeSnapshot } from './agent-task-observer.js';
export { createAgentTaskTools } from './agent-task-tools.js';
export type { AgentTaskTools } from './agent-task-tools.js';
export { boundAgentTaskEnvelope } from './agent-task-result.js';
export type { AgentTaskEnvelope } from './agent-task-result.js';
