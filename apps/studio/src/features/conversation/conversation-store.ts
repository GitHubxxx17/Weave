import { createLiveTurnProjector, type LiveTurnProjector } from '../agent/live-turn-projector.js';
import {
  isTerminalExecution,
  type AgentExecutionSnapshot,
  type AgentExecutionStatusFrame,
} from '../agent/agent-execution-types.js';
import type { SessionDetail } from '../workspace/workspace-types.js';
import { projectConversation, projectConversationView } from './conversation-model.js';
import type {
  ConversationSnapshot,
  ConversationStore,
  ConversationViewInput,
  LiveConversationOverlay,
  LiveOwner,
} from './conversation-types.js';

export interface ConversationStoreOptions {
  readonly scheduleFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (id: number) => void;
  readonly scheduleTimeout?: (callback: () => void) => number;
  readonly cancelTimeout?: (id: number) => void;
  readonly isHidden?: () => boolean;
}
interface LiveEntry {
  readonly owner: LiveOwner;
  readonly projector: LiveTurnProjector;
  status: AgentExecutionStatusFrame;
  generation: number;
  detached?: boolean;
  frame?: number | undefined;
  timeout?: number | undefined;
}
interface SessionState {
  base: ConversationSnapshot;
  snapshot: ConversationSnapshot;
  detailKnown: boolean;
  input?: ConversationViewInput | undefined;
  readonly listeners: Set<() => void>;
  readonly entries: Map<string, LiveEntry>;
  readonly owners: Map<string, LiveOwner>;
}
const exactOwner = (a: LiveOwner, b: LiveOwner): boolean =>
  a.sessionId === b.sessionId &&
  a.executionId === b.executionId &&
  a.turnId === b.turnId &&
  a.userMessageId === b.userMessageId &&
  a.runId === b.runId &&
  a.epoch === b.epoch;

function projectionEqual(a: ConversationSnapshot, b: ConversationSnapshot): boolean {
  return (
    a.durableSequence === b.durableSequence &&
    a.rowIds.length === b.rowIds.length &&
    a.rowIds.every(
      (id, index) => id === b.rowIds[index] && a.rowsById.get(id) === b.rowsById.get(id),
    ) &&
    a.turnById.size === b.turnById.size &&
    [...a.turnById].every(([id, turn]) => b.turnById.get(id) === turn)
  );
}

/** Session-local immutable publication; execution authority remains with the HTTP client. */
export function createConversationStore(options: ConversationStoreOptions = {}): ConversationStore {
  const scheduleFrame =
    options.scheduleFrame ??
    ((callback) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(callback)
        : (globalThis.setTimeout(callback, 16) as unknown as number));
  const cancelFrame =
    options.cancelFrame ??
    ((id) =>
      typeof cancelAnimationFrame === 'function'
        ? cancelAnimationFrame(id)
        : globalThis.clearTimeout(id));
  const scheduleTimeout =
    options.scheduleTimeout ??
    ((callback) =>
      globalThis.setTimeout(
        callback,
        options.isHidden?.() === true || (typeof document !== 'undefined' && document.hidden)
          ? 16
          : 100,
      ) as unknown as number);
  const cancelTimeout = options.cancelTimeout ?? ((id) => globalThis.clearTimeout(id));
  const sessions = new Map<string, SessionState>();
  let disposed = false;
  const stateFor = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId);
    if (state === undefined) {
      const base = projectConversationView({
        sessionId,
        messages: [],
        turns: [],
        detailKnown: false,
      });
      state = {
        base,
        snapshot: base,
        detailKnown: false,
        listeners: new Set(),
        entries: new Map(),
        owners: new Map(),
      };
      sessions.set(sessionId, state);
    }
    return state;
  };
  const notify = (state: SessionState): void => {
    for (const listener of state.listeners) listener();
  };
  const invalidate = (entry: LiveEntry): void => {
    entry.generation++;
    if (entry.frame !== undefined) cancelFrame(entry.frame);
    if (entry.timeout !== undefined) cancelTimeout(entry.timeout);
    entry.frame = undefined;
    entry.timeout = undefined;
  };
  const owned = (owner: LiveOwner): { state: SessionState; entry: LiveEntry } | undefined => {
    if (disposed) return undefined;
    const state = sessions.get(owner.sessionId);
    const entry = state?.entries.get(owner.executionId);
    return state !== undefined &&
      entry !== undefined &&
      entry.detached !== true &&
      exactOwner(entry.owner, owner)
      ? { state, entry }
      : undefined;
  };
  // Called only when the base or execution topology changes, never for a text delta.
  const topology = (
    state: SessionState,
    overlays: ReadonlyMap<string, LiveConversationOverlay>,
  ): readonly string[] => {
    const byTurn = new Map(
      [...overlays.values()].map((overlay) => [overlay.owner.turnId, overlay]),
    );
    const byUser = new Map(
      [...overlays.values()].map((overlay) => [overlay.owner.userMessageId, overlay]),
    );
    const ids: string[] = [];
    const seen = new Set<string>();
    const inserted = new Set<LiveConversationOverlay>();
    const appendOverlay = (overlay: LiveConversationOverlay): void => {
      if (inserted.has(overlay)) return;
      inserted.add(overlay);
      for (const id of overlay.rowIds)
        if (!seen.has(id)) {
          ids.push(id);
          seen.add(id);
        }
    };
    // Replacements occupy the first durable slot of their own Turn. An older
    // terminal overlay must not move behind a newer settled execution.
    for (const id of state.base.rowIds) {
      const row = state.base.rowsById.get(id);
      const overlay =
        byUser.get(id) ?? (row?.turnId === undefined ? undefined : byTurn.get(row.turnId));
      if (overlay !== undefined) appendOverlay(overlay);
      else if (!seen.has(id)) {
        ids.push(id);
        seen.add(id);
      }
    }
    for (const overlay of overlays.values()) appendOverlay(overlay);
    return ids.length === state.snapshot.rowIds.length &&
      ids.every((id, index) => id === state.snapshot.rowIds[index])
      ? state.snapshot.rowIds
      : ids;
  };
  const publish = (state: SessionState, rebuildTopology: boolean): void => {
    const overlays = new Map<string, LiveConversationOverlay>();
    let changed =
      state.snapshot.rowsById !== state.base.rowsById ||
      state.snapshot.durableSequence !== state.base.durableSequence ||
      state.snapshot.liveOverlays.size !== state.entries.size;
    for (const [executionId, entry] of state.entries) {
      const projection = entry.projector.getProjection();
      const old = state.snapshot.liveOverlays.get(executionId);
      const overlay =
        old !== undefined &&
        old.rowsById === projection.rowsById &&
        old.turnById === projection.turnById &&
        exactOwner(old.owner, entry.owner)
          ? old
          : { ...projection, owner: entry.owner };
      overlays.set(executionId, overlay);
      if (overlay !== old) changed = true;
    }
    if (!changed) return;
    const rowIds = rebuildTopology ? topology(state, overlays) : state.snapshot.rowIds;
    let latestAssistantId = state.snapshot.latestAssistantId;
    if (rebuildTopology) {
      const assistants = new Set<string>();
      for (const overlay of overlays.values())
        for (const row of overlay.rowsById.values())
          if (row.role === 'assistant') assistants.add(row.id);
      latestAssistantId = null;
      for (let index = rowIds.length - 1; index >= 0; index--) {
        const id = rowIds[index];
        if (
          id !== undefined &&
          (assistants.has(id) || state.base.rowsById.get(id)?.role === 'assistant')
        ) {
          latestAssistantId = id;
          break;
        }
      }
    }
    state.snapshot = {
      ...state.base,
      revision: state.snapshot.revision + 1,
      rowIds,
      liveOverlays: overlays,
      latestAssistantId,
    };
    notify(state);
  };
  const flush = (owner: LiveOwner): void => {
    const value = owned(owner);
    if (value === undefined) return;
    invalidate(value.entry);
    publish(value.state, false);
  };
  const schedule = (state: SessionState, entry: LiveEntry): void => {
    if (entry.frame !== undefined || entry.timeout !== undefined) return;
    const generation = entry.generation;
    const callback = (): void => {
      const current = owned(entry.owner);
      if (current?.entry !== entry || entry.generation !== generation) return;
      invalidate(entry);
      publish(state, false);
    };
    entry.frame = scheduleFrame(callback);
    // A bounded fallback also covers a tab becoming hidden after rAF was queued.
    entry.timeout = scheduleTimeout(callback);
  };
  const applyBase = (state: SessionState, base: ConversationSnapshot): boolean => {
    if (projectionEqual(state.base, base)) return false;
    state.base = base;
    publish(state, true);
    return true;
  };
  const hydrate = (detail: SessionDetail): boolean => {
    if (disposed) return false;
    const state = stateFor(detail.id);
    if (detail.lastSequence < state.base.durableSequence) return false;
    state.detailKnown = true;
    state.input = undefined;
    const terminal = new Map(
      detail.turns.filter((turn) => turn.status !== 'running').map((turn) => [turn.turnId, turn]),
    );
    let retiredDetached = false;
    for (const [id, entry] of state.entries) {
      const turn = terminal.get(entry.owner.turnId);
      if (
        entry.detached === true &&
        turn?.userMessageId === entry.owner.userMessageId &&
        (entry.status.durableThroughSequence === undefined ||
          detail.lastSequence >= entry.status.durableThroughSequence)
      ) {
        invalidate(entry);
        state.entries.delete(id);
        retiredDetached = true;
      }
    }
    const applied = applyBase(state, projectConversation(detail, state.snapshot));
    if (retiredDetached && !applied) publish(state, true);
    return applied;
  };
  return {
    getSnapshot(sessionId) {
      return stateFor(sessionId).snapshot;
    },
    subscribeSession(sessionId, listener) {
      if (disposed) return () => {};
      const state = stateFor(sessionId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    hydrateView(input) {
      if (disposed) return false;
      const state = stateFor(input.sessionId);
      if (
        (!input.detailKnown && state.detailKnown) ||
        (input.durableSequence !== undefined && input.durableSequence < state.base.durableSequence)
      )
        return false;
      if (
        state.input?.messages === input.messages &&
        state.input.turns === input.turns &&
        state.input.detailKnown === input.detailKnown &&
        state.input.durableSequence === input.durableSequence
      )
        return false;
      state.detailKnown ||= input.detailKnown;
      state.input = input;
      return applyBase(state, projectConversationView(input, state.base));
    },
    hydrate,
    replaceLive(owner, snapshot: AgentExecutionSnapshot) {
      if (
        disposed ||
        snapshot.sessionId !== owner.sessionId ||
        snapshot.executionId !== owner.executionId ||
        snapshot.turnId !== owner.turnId ||
        snapshot.userMessageId !== owner.userMessageId
      )
        return;
      const state = stateFor(owner.sessionId);
      const oldOwner = state.owners.get(owner.executionId);
      if (
        oldOwner !== undefined &&
        (owner.epoch < oldOwner.epoch ||
          (owner.epoch === oldOwner.epoch && !exactOwner(oldOwner, owner)))
      )
        return;
      const old = state.entries.get(owner.executionId);
      if (old?.detached === true && exactOwner(old.owner, owner)) return;
      // Once an exact owner has settled, a delayed snapshot cannot resurrect it.
      if (old === undefined && oldOwner !== undefined && owner.epoch === oldOwner.epoch) return;
      if (
        old !== undefined &&
        isTerminalExecution(old.status.status) &&
        !isTerminalExecution(snapshot.status)
      )
        return;
      // Terminal sequence-zero snapshots after a server epoch reset may carry
      // no transient log. Keep already admitted output until durable readback.
      if (
        old !== undefined &&
        exactOwner(old.owner, owner) &&
        isTerminalExecution(snapshot.status) &&
        snapshot.events.length === 0
      ) {
        old.status = snapshot;
        flush(owner);
        return;
      }
      if (old !== undefined) invalidate(old);
      const entry: LiveEntry = {
        owner: { ...owner },
        projector: createLiveTurnProjector(owner, snapshot),
        status: snapshot,
        generation: (old?.generation ?? 0) + 1,
      };
      state.owners.set(owner.executionId, entry.owner);
      state.entries.set(owner.executionId, entry);
      publish(state, true);
    },
    appendLive(owner, event) {
      const value = owned(owner);
      if (value === undefined || isTerminalExecution(value.entry.status.status)) return;
      value.entry.projector.append(event);
      schedule(value.state, value.entry);
    },
    updateLiveStatus(owner, frame) {
      const value = owned(owner);
      if (value === undefined) return;
      if (isTerminalExecution(value.entry.status.status) && !isTerminalExecution(frame.status))
        return;
      value.entry.status = { ...value.entry.status, ...frame };
      if (isTerminalExecution(frame.status) || frame.status === 'persistence-error') flush(owner);
    },
    flush,
    detachLive(owner) {
      const value = owned(owner);
      if (value === undefined) return;
      flush(owner);
      value.entry.detached = true;
    },
    settle(owner, detail) {
      const value = owned(owner);
      if (value === undefined || detail.id !== owner.sessionId)
        return { confirmed: false, historyApplied: false };
      flush(owner);
      const status = value.entry.status;
      const turn = detail.turns.find((turn) => turn.turnId === owner.turnId);
      const confirmed =
        isTerminalExecution(status.status) &&
        status.durableThroughSequence !== undefined &&
        detail.lastSequence >= status.durableThroughSequence &&
        ((turn !== undefined &&
          turn.userMessageId === owner.userMessageId &&
          turn.status !== 'running') ||
          (turn === undefined && status.status !== 'completed'));
      if (!confirmed) return { confirmed: false, historyApplied: false };
      const historyApplied = hydrate(detail);
      invalidate(value.entry);
      value.state.entries.delete(owner.executionId);
      publish(value.state, true);
      return { confirmed: true, historyApplied };
    },
    removeSession(sessionId) {
      const state = sessions.get(sessionId);
      if (state === undefined) return;
      for (const entry of state.entries.values()) invalidate(entry);
      const listeners = [...state.listeners];
      state.listeners.clear();
      sessions.delete(sessionId);
      for (const listener of listeners) listener();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of sessions.values()) {
        for (const entry of state.entries.values()) invalidate(entry);
        state.entries.clear();
        state.listeners.clear();
      }
      sessions.clear();
    },
  };
}
