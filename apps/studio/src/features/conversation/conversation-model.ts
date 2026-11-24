import type { SessionDetail, TurnSummary, WorkspaceMessage } from '../workspace/workspace-types.js';
import type {
  CapturedSubmission,
  ConversationRow,
  ConversationSnapshot,
  ConversationTarget,
  ConversationViewInput,
  DurableMessageIdentity,
  ToolIdentity,
} from './conversation-types.js';
import type { ToolStepData } from './tool-step.js';

export const toolIdentityKey = (identity: ToolIdentity): string =>
  JSON.stringify([identity.sessionId, identity.turnId, identity.toolCallId]);
export const durableMessageKey = (identity: DurableMessageIdentity): string =>
  JSON.stringify([identity.sessionId, identity.turnId, identity.messageId]);

function equalValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function messageText(message: WorkspaceMessage, type: 'text' | 'reasoning' = 'text'): string {
  return message.content
    .filter((part) => part.type === type)
    .map((part) => ('text' in part ? part.text : ''))
    .join('');
}

function retrySubmission(
  sessionId: string,
  row: ConversationRow | undefined,
  turn: TurnSummary,
): CapturedSubmission | undefined {
  if (row?.submission !== undefined) return row.submission;
  if (row === undefined || turn.request?.useProviderDefaults !== false) return undefined;
  return {
    sessionId,
    ...turn.request,
    userMessage: row.originalUserMessage ?? { role: 'user', content: [] },
    skills: (turn.skills?.requested ?? []).map(({ id, instructionSha256, bundleSha256 }) => ({
      id,
      instructionSha256,
      bundleSha256,
    })),
    ...(row.fileAttachments === undefined
      ? {}
      : { files: row.fileAttachments.map(({ path }) => ({ path })) }),
  };
}

/** Builds each durable index once. Live token publication never calls this function. */
export function projectConversationView(
  input: ConversationViewInput,
  previous?: ConversationSnapshot,
): ConversationSnapshot {
  const rowsById = new Map<string, ConversationRow>();
  const userByTurn = new Map<string, ConversationRow>();
  const lastReplyIdByTurn = new Map<string, string>();
  const toolOwnerByKey = new Map<string, string>();
  const durableOwnerByKey = new Map<string, string>();
  const turnById = new Map<string, TurnSummary>();
  const retryByTurn = new Map<string, CapturedSubmission>();
  let latestAssistantId: string | null = null;
  for (const incoming of input.messages) {
    const old =
      previous?.sessionId === input.sessionId
        ? getConversationRow(previous, incoming.id)
        : undefined;
    const withExtras: ConversationRow =
      old === undefined
        ? incoming
        : {
            ...incoming,
            ...(incoming.submission === undefined && old.submission !== undefined
              ? { submission: old.submission }
              : {}),
            ...(incoming.selectedSkills === undefined && old.selectedSkills !== undefined
              ? { selectedSkills: old.selectedSkills }
              : {}),
            ...(incoming.originalUserMessage === undefined && old.originalUserMessage !== undefined
              ? { originalUserMessage: old.originalUserMessage }
              : {}),
            ...(incoming.fileAttachments === undefined && old.fileAttachments !== undefined
              ? { fileAttachments: old.fileAttachments }
              : {}),
            ...(incoming.images === undefined && old.images !== undefined
              ? { images: old.images }
              : {}),
          };
    const row = old !== undefined && equalValue(old, withExtras) ? old : withExtras;
    rowsById.set(row.id, row);
    if (row.role === 'assistant') latestAssistantId = row.id;
    if (row.turnId === undefined) continue;
    if (row.role === 'user') userByTurn.set(row.turnId, row);
    else lastReplyIdByTurn.set(row.turnId, row.id);
    for (const tool of row.tools)
      toolOwnerByKey.set(
        toolIdentityKey({
          sessionId: input.sessionId,
          turnId: row.turnId,
          toolCallId: tool.toolCallId,
        }),
        row.id,
      );
    for (const messageId of row.durableMessageIds ?? [row.id])
      durableOwnerByKey.set(
        durableMessageKey({ sessionId: input.sessionId, turnId: row.turnId, messageId }),
        row.id,
      );
  }
  for (const incoming of input.turns) {
    const old = previous?.turnById.get(incoming.turnId);
    const turn = old !== undefined && equalValue(old, incoming) ? old : incoming;
    turnById.set(turn.turnId, turn);
    const user =
      userByTurn.get(turn.turnId) ??
      (turn.userMessageId === undefined ? undefined : rowsById.get(turn.userMessageId));
    if (user !== undefined) userByTurn.set(turn.turnId, user);
    const retry = retrySubmission(input.sessionId, user, turn);
    if (retry !== undefined) {
      const oldRetry = previous?.retryByTurn.get(turn.turnId);
      retryByTurn.set(
        turn.turnId,
        equalValue(oldRetry, retry) ? (oldRetry as CapturedSubmission) : retry,
      );
    }
  }
  const rowIds = [...rowsById.keys()];
  return {
    sessionId: input.sessionId,
    revision: (previous?.revision ?? -1) + 1,
    rowIds:
      previous !== undefined && equalValue(previous.rowIds, rowIds) ? previous.rowIds : rowIds,
    rowsById,
    userByTurn,
    turnById,
    retryByTurn,
    lastReplyIdByTurn,
    toolOwnerByKey,
    durableOwnerByKey,
    latestAssistantId,
    liveOverlays: new Map(),
    durableSequence: input.durableSequence ?? previous?.durableSequence ?? 0,
  };
}

/** Full Session projection is linear in messages, content and tool facts. */
export function projectConversation(
  detail: SessionDetail,
  previous?: ConversationSnapshot,
): ConversationSnapshot {
  const results = new Map<string, string>();
  const statuses = new Map<string, 'completed' | 'failed'>();
  for (const turn of detail.turns)
    for (const result of turn.toolResults)
      statuses.set(
        toolIdentityKey({
          sessionId: detail.id,
          turnId: turn.turnId,
          toolCallId: result.toolCallId,
        }),
        result.status,
      );
  for (const message of detail.messages)
    if (message.role === 'tool' && message.turnId !== undefined)
      results.set(
        toolIdentityKey({
          sessionId: detail.id,
          turnId: message.turnId,
          toolCallId: message.toolCallId,
        }),
        messageText(message),
      );
  type MutableCard = {
    id: string;
    turnId?: string;
    role: 'assistant';
    text: string;
    reasoning: string;
    tools: ToolStepData[];
    occurredAt: string;
    durableMessageIds: string[];
  };
  const rows: (ConversationRow | MutableCard)[] = [];
  const cardByTurn = new Map<string, MutableCard>();
  detail.messages.forEach((message, index) => {
    const id = message.messageId ?? `${detail.id}-message-${index + 1}`;
    if (message.role === 'user') {
      rows.push({
        id,
        role: 'user',
        text: messageText(message),
        reasoning: '',
        tools: [],
        occurredAt: message.occurredAt ?? '',
        images: message.content
          .filter((part) => part.type === 'image')
          .map(({ mediaType, data }) => ({ mediaType, data })),
        fileAttachments: message.fileAttachments,
        originalUserMessage: {
          role: 'user',
          content: message.content.filter(
            (part): part is Extract<typeof part, { type: 'text' | 'image' }> =>
              part.type === 'text' || part.type === 'image',
          ),
        },
        ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
      });
    } else if (message.role === 'assistant') {
      let card = message.turnId === undefined ? undefined : cardByTurn.get(message.turnId);
      if (card === undefined) {
        card = {
          id: message.turnId ?? id,
          role: 'assistant',
          text: '',
          reasoning: '',
          tools: [],
          occurredAt: message.occurredAt ?? '',
          durableMessageIds: [],
          ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
        };
        rows.push(card);
        if (message.turnId !== undefined) cardByTurn.set(message.turnId, card);
      }
      card.text += messageText(message);
      card.reasoning += messageText(message, 'reasoning');
      if (message.messageId !== undefined) card.durableMessageIds.push(message.messageId);
      for (const call of message.toolCalls ?? []) {
        const key =
          message.turnId === undefined
            ? undefined
            : toolIdentityKey({
                sessionId: detail.id,
                turnId: message.turnId,
                toolCallId: call.id,
              });
        const result = key === undefined ? undefined : results.get(key);
        card.tools.push({
          toolCallId: call.id,
          name: call.name,
          arguments: call.arguments,
          status:
            (key === undefined ? undefined : statuses.get(key)) ??
            (result === undefined ? 'called' : 'completed'),
          ...(result === undefined ? {} : { result }),
        });
      }
    }
  });
  return projectConversationView(
    {
      sessionId: detail.id,
      messages: rows,
      turns: detail.turns,
      detailKnown: true,
      durableSequence: detail.lastSequence,
    },
    previous,
  );
}

export function getConversationRow(
  snapshot: ConversationSnapshot,
  id: string,
): ConversationRow | undefined {
  for (const overlay of snapshot.liveOverlays.values()) {
    const row = overlay.rowsById.get(id);
    if (row !== undefined) return row;
  }
  return snapshot.rowsById.get(id);
}

export function getConversationTurn(
  snapshot: ConversationSnapshot,
  id: string,
): TurnSummary | undefined {
  for (const overlay of snapshot.liveOverlays.values()) {
    const turn = overlay.turnById.get(id);
    if (turn !== undefined) return turn;
  }
  return snapshot.turnById.get(id);
}

export function getConversationRetry(
  snapshot: ConversationSnapshot,
  turnId: string,
): CapturedSubmission | undefined {
  for (const overlay of snapshot.liveOverlays.values()) {
    if (overlay.owner.turnId !== turnId) continue;
    const retry = overlay.retryByTurn.get(turnId);
    if (retry !== undefined) return retry;
  }
  return snapshot.retryByTurn.get(turnId);
}

const rowsCache = new WeakMap<ConversationSnapshot, readonly ConversationRow[]>();
export function conversationRows(snapshot: ConversationSnapshot): readonly ConversationRow[] {
  let rows = rowsCache.get(snapshot);
  if (rows === undefined) {
    rows = snapshot.rowIds.flatMap((id) => {
      const row = getConversationRow(snapshot, id);
      return row === undefined ? [] : [row];
    });
    rowsCache.set(snapshot, rows);
  }
  return rows;
}

interface FacetCache {
  readonly sources: readonly unknown[];
  readonly value: readonly TurnSummary[];
}
const turnsCache = new WeakMap<ConversationSnapshot, FacetCache>();
const lastTurnsByBase = new WeakMap<ReadonlyMap<string, TurnSummary>, FacetCache>();
export function conversationTurns(snapshot: ConversationSnapshot): readonly TurnSummary[] {
  const cached = turnsCache.get(snapshot);
  if (cached !== undefined) return cached.value;
  const sources = [
    snapshot.turnById,
    ...[...snapshot.liveOverlays.values()].map((overlay) => overlay.turnById),
  ];
  const previous = lastTurnsByBase.get(snapshot.turnById);
  if (
    previous !== undefined &&
    sources.length === previous.sources.length &&
    sources.every((source, index) => source === previous.sources[index])
  ) {
    turnsCache.set(snapshot, previous);
    return previous.value;
  }
  const byId = new Map(snapshot.turnById);
  for (const overlay of snapshot.liveOverlays.values())
    for (const [id, turn] of overlay.turnById) byId.set(id, turn);
  const next = { sources, value: [...byId.values()] };
  turnsCache.set(snapshot, next);
  lastTurnsByBase.set(snapshot.turnById, next);
  return next.value;
}

export type ConversationToolMessage = Pick<
  ConversationRow,
  'id' | 'role' | 'occurredAt' | 'turnId' | 'tools'
>;
interface ToolMessagesCache {
  readonly sources: readonly unknown[];
  readonly messages: readonly ConversationToolMessage[];
  readonly tools: readonly ToolStepData[];
}
const toolMessagesCache = new WeakMap<ConversationSnapshot, ToolMessagesCache>();
const lastToolsByBase = new WeakMap<ReadonlyMap<string, ConversationRow>, ToolMessagesCache>();
function toolFacets(snapshot: ConversationSnapshot): ToolMessagesCache {
  const cached = toolMessagesCache.get(snapshot);
  if (cached !== undefined) return cached;
  // Only execution-local rows are inspected on the token path. Durable rows are
  // visited again only when history/topology or an actual tool array changes.
  const sources: unknown[] = [snapshot.rowIds];
  for (const overlay of snapshot.liveOverlays.values()) {
    sources.push(overlay.owner);
    for (const row of overlay.rowsById.values()) sources.push(row.id, row.tools);
  }
  const previous = lastToolsByBase.get(snapshot.rowsById);
  if (
    previous !== undefined &&
    sources.length === previous.sources.length &&
    sources.every((source, index) => source === previous.sources[index])
  ) {
    toolMessagesCache.set(snapshot, previous);
    return previous;
  }
  const oldMessages = new Map(previous?.messages.map((message) => [message.id, message]));
  const messages = conversationRows(snapshot).map((row) => {
    const old = oldMessages.get(row.id);
    return old !== undefined &&
      old.tools === row.tools &&
      old.role === row.role &&
      old.occurredAt === row.occurredAt &&
      old.turnId === row.turnId
      ? old
      : {
          id: row.id,
          role: row.role,
          occurredAt: row.occurredAt,
          turnId: row.turnId,
          tools: row.tools,
        };
  });
  const value = { sources, messages, tools: messages.flatMap((message) => message.tools) };
  toolMessagesCache.set(snapshot, value);
  lastToolsByBase.set(snapshot.rowsById, value);
  return value;
}
export function conversationTools(snapshot: ConversationSnapshot): readonly ToolStepData[] {
  return toolFacets(snapshot).tools;
}
export function conversationToolMessages(
  snapshot: ConversationSnapshot,
): readonly ConversationToolMessage[] {
  return toolFacets(snapshot).messages;
}

export interface ResolvedConversationTarget {
  readonly rowId: string;
  readonly row: ConversationRow;
  readonly turn?: TurnSummary;
  readonly tool?: ToolStepData;
}
export function resolveConversationTarget(
  snapshot: ConversationSnapshot,
  target: ConversationTarget,
): ResolvedConversationTarget | undefined {
  if (target.sessionId !== snapshot.sessionId) return undefined;
  let rowId: string | undefined;
  if (target.kind === 'row') rowId = target.rowId;
  else {
    const key = target.kind === 'tool' ? toolIdentityKey(target) : durableMessageKey(target);
    for (const overlay of snapshot.liveOverlays.values()) {
      if (overlay.owner.turnId !== target.turnId) continue;
      rowId = (target.kind === 'tool' ? overlay.toolOwnerByKey : overlay.durableOwnerByKey).get(
        key,
      );
      if (rowId !== undefined) break;
    }
    rowId ??= (target.kind === 'tool' ? snapshot.toolOwnerByKey : snapshot.durableOwnerByKey).get(
      key,
    );
  }
  if (rowId === undefined || !snapshot.rowIds.includes(rowId)) return undefined;
  const row = getConversationRow(snapshot, rowId);
  if (row === undefined || (target.kind !== 'row' && row.turnId !== target.turnId))
    return undefined;
  const turn = row.turnId === undefined ? undefined : getConversationTurn(snapshot, row.turnId);
  const tool =
    target.kind === 'tool'
      ? row.tools.find((tool) => tool.toolCallId === target.toolCallId)
      : undefined;
  if (target.kind === 'tool' && tool === undefined) return undefined;
  return {
    rowId,
    row,
    ...(turn === undefined ? {} : { turn }),
    ...(tool === undefined ? {} : { tool }),
  };
}

export function projectWorkspaceMessages(
  sessionId: string,
  messages: readonly WorkspaceMessage[],
  turns: readonly TurnSummary[] = [],
): readonly ConversationRow[] {
  return conversationRows(
    projectConversation({
      id: sessionId,
      title: sessionId,
      lastSequence: 0,
      messages: [...messages],
      turns: [...turns],
    }),
  );
}
