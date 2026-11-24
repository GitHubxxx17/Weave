import type { AgentRunRequestInput, AgentRuntimeEvent } from '../agent/agent-types.js';
import type {
  AgentExecutionSnapshot,
  AgentExecutionStatusFrame,
} from '../agent/agent-execution-types.js';
import type { FileAttachmentSummary } from '../file-context/file-context-types.js';
import type { SkillSummary } from '../skills/skill-types.js';
import type { SessionDetail, TurnSummary } from '../workspace/workspace-types.js';
import type { ToolStepData } from './tool-step.js';

export type ConversationRunStatus = 'idle' | 'streaming' | 'completed' | 'cancelled' | 'error';
export type CapturedSubmission = Readonly<
  AgentRunRequestInput & { readonly skills: NonNullable<AgentRunRequestInput['skills']> }
>;
export interface ConversationRow {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly reasoning: string;
  readonly tools: readonly ToolStepData[];
  readonly occurredAt: string;
  readonly submission?: CapturedSubmission | undefined;
  readonly originalUserMessage?: AgentRunRequestInput['userMessage'] | undefined;
  readonly selectedSkills?: readonly SkillSummary[] | undefined;
  readonly fileAttachments?: readonly FileAttachmentSummary[] | undefined;
  readonly images?: readonly { readonly mediaType: string; readonly data: string }[] | undefined;
  readonly turnId?: string | undefined;
  readonly durableMessageIds?: readonly string[];
}
export interface ToolIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly toolCallId: string;
}
export interface DurableMessageIdentity {
  readonly sessionId: string;
  readonly turnId: string;
  readonly messageId: string;
}
export type ConversationTarget =
  | { readonly kind: 'row'; readonly sessionId: string; readonly rowId: string }
  | ({ readonly kind: 'durable-message' } & DurableMessageIdentity)
  | ({ readonly kind: 'tool' } & ToolIdentity);
export type ConversationAction =
  | { readonly type: 'quote'; readonly sessionId: string; readonly rowId: string }
  | { readonly type: 'retry'; readonly sessionId: string; readonly turnId: string }
  | {
      readonly type: 'image';
      readonly image: { readonly mediaType: string; readonly data: string };
    };
export interface LiveOwner {
  readonly sessionId: string;
  readonly executionId: string;
  readonly turnId: string;
  readonly userMessageId: string;
  readonly runId: string;
  readonly epoch: number;
}
export interface ConversationViewInput {
  readonly sessionId: string;
  readonly messages: readonly ConversationRow[];
  readonly turns: readonly TurnSummary[];
  readonly detailKnown: boolean;
  readonly durableSequence?: number;
}
export interface ConversationProjection {
  readonly sessionId: string;
  readonly rowIds: readonly string[];
  readonly rowsById: ReadonlyMap<string, ConversationRow>;
  readonly turnById: ReadonlyMap<string, TurnSummary>;
  readonly userByTurn: ReadonlyMap<string, ConversationRow>;
  readonly lastReplyIdByTurn: ReadonlyMap<string, string>;
  readonly retryByTurn: ReadonlyMap<string, CapturedSubmission>;
  readonly toolOwnerByKey: ReadonlyMap<string, string>;
  readonly durableOwnerByKey: ReadonlyMap<string, string>;
  readonly latestAssistantId: string | null;
}
export interface LiveConversationOverlay extends ConversationProjection {
  readonly owner: LiveOwner;
}
export interface ConversationSnapshot extends ConversationProjection {
  readonly revision: number;
  readonly liveOverlays: ReadonlyMap<string, LiveConversationOverlay>;
  readonly durableSequence: number;
}
export interface ConversationStore {
  getSnapshot(sessionId: string): ConversationSnapshot;
  subscribeSession(sessionId: string, listener: () => void): () => void;
  hydrateView(input: ConversationViewInput): boolean;
  hydrate(detail: SessionDetail): boolean;
  replaceLive(owner: LiveOwner, snapshot: AgentExecutionSnapshot): void;
  appendLive(owner: LiveOwner, event: AgentRuntimeEvent): void;
  updateLiveStatus(owner: LiveOwner, frame: AgentExecutionStatusFrame): void;
  detachLive(owner: LiveOwner): void;
  flush(owner: LiveOwner): void;
  settle(
    owner: LiveOwner,
    detail: SessionDetail,
  ): {
    readonly confirmed: boolean;
    readonly historyApplied: boolean;
  };
  removeSession(sessionId: string): void;
  dispose(): void;
}
export interface TimelineHandle {
  reveal(target: ConversationTarget): Promise<'revealed' | 'missing' | 'stale'>;
  scrollToBottom(): void;
}
