import type { AgentExecutionSnapshot } from '../features/agent/agent-execution-types.js';
import type {
  CapturedSubmission,
  ConversationRow,
} from '../features/conversation/conversation-types.js';
import type { AgentTaskResultPointer } from '../features/tasks/task-types.js';
import type { SessionDetail, TurnSummary } from '../features/workspace/workspace-types.js';

export type RunStatus = 'idle' | 'streaming' | 'completed' | 'error' | 'cancelled';

/** Reactive run state kept per session so switching sessions never disturbs a run. */
export type SessionRunState = {
  readonly status: RunStatus;
  readonly errorMessage: string | null;
  readonly connection?: 'connecting' | 'connected' | 'reconnecting' | undefined;
  readonly stopping?: boolean | undefined;
};

/** Non-reactive bookkeeping for the single in-flight run of one session. */
export type SessionRunHandle = {
  runId: string;
  observationEpoch: number;
  controller: AbortController;
  assistantId: string;
  tools: readonly ToolActivity[];
  projectId?: string;
  sessionId?: string;
  observing?: boolean;
  reconciling?: boolean;
  execution?: AgentExecutionSnapshot;
  requestId?: string;
  pendingCancel?: boolean;
  cancelInFlight?: boolean;
};

export const idleRunState: SessionRunState = { status: 'idle', errorMessage: null };

export type ProductView =
  | 'studio'
  | 'projects'
  | 'history'
  | 'archived'
  | 'settings'
  | 'marketplace'
  | 'memory'
  | 'retrieval';
export type OpenMenu = 'project' | 'more' | 'context' | 'permission' | 'model' | null;

export type AgentSubmissionSnapshot = CapturedSubmission;
export type ChatMessage = ConversationRow;

export type StudioSession = {
  readonly id: string;
  readonly title: string;
  readonly lastUsedLabel: string;
  readonly archivedAt: string | null;
  readonly messages: readonly ChatMessage[];
  readonly turns: readonly TurnSummary[];
  readonly detailKnown: boolean;
  readonly durableSequence?: number;
  readonly taskOrigin?: SessionDetail['taskOrigin'];
};

export type TaskTranscriptTarget =
  | { readonly sessionId: string; readonly result: AgentTaskResultPointer }
  | { readonly sessionId: string; readonly toolCallId: string; readonly turnId: string };

export type StudioProject = {
  readonly id: string;
  readonly name: string;
  readonly folderName: string;
  readonly folderPath?: string | undefined;
  readonly sessions: readonly StudioSession[];
};

export type ProjectDirectory = {
  readonly name: string;
};

/** An image staged in the composer before it is sent, base64-encoded. */
export type PendingImage = {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly data: string;
};

export type DirectoryPickerWindow = Window &
  typeof globalThis & {
    readonly showDirectoryPicker?: () => Promise<ProjectDirectory>;
  };

export type ToolActivity = {
  readonly toolCallId: string;
  readonly name: string;
  readonly arguments: string;
  readonly status: 'called' | 'executing' | 'completed' | 'failed';
  readonly result?: string;
};

export type ProviderFormState = {
  readonly mode: 'create' | 'edit';
  readonly editingId: string | null;
  readonly providerPresetId: string;
  readonly modelPresetId: string;
  readonly id: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly defaultModel: string;
  readonly makeDefault: boolean;
  readonly clearApiKey: boolean;
  readonly contextWindowTokens: string;
  readonly temperature: string;
  readonly maxTokens: string;
};
