import { useCallback, useRef, useState, type RefObject, type SetStateAction } from 'react';
export interface ComposerOwner {
  readonly sessionId: string;
  readonly projectId: string;
  readonly rootKey: string;
  readonly epoch: number;
}
export interface PreparedInsertion {
  readonly owner: ComposerOwner;
  readonly panelRef: string;
  readonly serverEpoch: string;
  readonly generation: number;
  readonly authorityEpoch: number;
  readonly formId: string;
  readonly requestEpoch: number;
  readonly text: string;
}
export type InsertPreparedResult = 'inserted' | 'stale';
export interface PanelInsertionContext {
  readonly owner: ComposerOwner;
  readonly panelRef: string;
  readonly serverEpoch: string;
  readonly generation: number;
  readonly authorityEpoch: number;
  readonly visible: boolean;
  readonly lifetime: string;
}
interface Draft {
  readonly text: string;
  readonly images: readonly unknown[];
  readonly literalSend: boolean;
  readonly revision: number;
}
export interface DraftCapture {
  readonly owner: ComposerOwner;
  readonly revision: number;
}
export interface DraftMigrationTicket {
  readonly source: DraftCapture;
  readonly destination: ComposerOwner;
  readonly revision: number;
}
export function sameComposerOwner(a: ComposerOwner, b: ComposerOwner): boolean {
  return (
    a.epoch === b.epoch &&
    a.sessionId === b.sessionId &&
    a.projectId === b.projectId &&
    a.rootKey === b.rootKey
  );
}
function ownerKey(sessionId: string, projectId: string, rootKey: string): string {
  return JSON.stringify([projectId, rootKey, sessionId || null]);
}
function draftKey(owner: ComposerOwner): string {
  return owner.sessionId !== ''
    ? JSON.stringify(['session', owner.sessionId])
    : JSON.stringify(['provisional', owner.projectId, owner.rootKey]);
}
function contextKey(c: PanelInsertionContext | null): string {
  return c === null
    ? ''
    : JSON.stringify([
        c.owner,
        c.panelRef,
        c.serverEpoch,
        c.generation,
        c.authorityEpoch,
        c.visible,
        c.lifetime,
      ]);
}
const emptyDraft = (): Draft => ({ text: '', images: [], literalSend: false, revision: 0 });
/** App-owned draft and interaction authority. Owner epochs deliberately survive Session ABA. */
export function useComposerDraft(options: {
  sessionId: string;
  projectId: string;
  rootKey: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}) {
  const [, render] = useState(0);
  const state = useRef<{
    owner: ComposerOwner;
    key: string;
    buckets: Map<string, Draft>;
    sequence: number;
    panel: PanelInsertionContext | null;
    token: number;
    formId: string;
    consumed: boolean;
    ticket: DraftMigrationTicket | null;
    migrationPending: boolean;
  }>({
    owner: {
      sessionId: options.sessionId,
      projectId: options.projectId,
      rootKey: options.rootKey,
      epoch: 1,
    },
    key: ownerKey(options.sessionId, options.projectId, options.rootKey),
    buckets: new Map(),
    sequence: 0,
    panel: null,
    token: 0,
    formId: '',
    consumed: true,
    ticket: null,
    migrationPending: false,
  });
  const requested = ownerKey(options.sessionId, options.projectId, options.rootKey);
  const current = state.current;
  if (current.migrationPending && current.key === requested) current.migrationPending = false;
  if (
    current.key !== requested &&
    !(
      current.migrationPending &&
      current.ticket !== null &&
      requested ===
        ownerKey(
          current.ticket.source.owner.sessionId,
          current.ticket.source.owner.projectId,
          current.ticket.source.owner.rootKey,
        )
    )
  ) {
    current.migrationPending = false;
    current.owner = {
      sessionId: options.sessionId,
      projectId: options.projectId,
      rootKey: options.rootKey,
      epoch: current.owner.epoch + 1,
    };
    current.key = requested;
    current.panel = null;
    current.token += 1;
    current.consumed = true;
  }
  if (!current.buckets.has(draftKey(current.owner)))
    current.buckets.set(draftKey(current.owner), emptyDraft());
  const active = current.buckets.get(draftKey(current.owner))!;
  current.buckets.delete(draftKey(current.owner));
  current.buckets.set(draftKey(current.owner), active);
  while (current.buckets.size > 129) {
    const oldest = current.buckets.keys().next().value;
    if (oldest === undefined) break;
    current.buckets.delete(oldest);
  }
  const update = useCallback((fn: (d: Draft) => Omit<Draft, 'revision'>) => {
    const s = state.current;
    const draft = s.buckets.get(draftKey(s.owner)) ?? emptyDraft();
    s.sequence += 1;
    s.buckets.set(draftKey(s.owner), { ...fn(draft), revision: s.sequence });
    render((n) => n + 1);
  }, []);
  const setText = useCallback(
    (value: SetStateAction<string>) =>
      update((d) => ({ ...d, text: typeof value === 'function' ? value(d.text) : value })),
    [update],
  );
  const setImages = useCallback(
    <T>(value: SetStateAction<readonly T[]>) =>
      update((d) => ({
        ...d,
        images: typeof value === 'function' ? value(d.images as readonly T[]) : value,
      })),
    [update],
  );
  const resetLiteral = useCallback(() => update((d) => ({ ...d, literalSend: false })), [update]);
  const isOwnerCurrent = useCallback(
    (owner: ComposerOwner) => sameComposerOwner(state.current.owner, owner),
    [],
  );
  const setPanelContext = useCallback((panel: PanelInsertionContext) => {
    const s = state.current;
    if (contextKey(s.panel) !== contextKey(panel)) {
      s.token += 1;
      s.consumed = true;
      s.panel = panel;
    }
  }, []);
  const invalidatePanel = useCallback((lifetime?: string) => {
    const s = state.current;
    if (lifetime === undefined || s.panel?.lifetime === lifetime) {
      s.token += 1;
      s.panel = null;
      s.consumed = true;
    }
  }, []);
  const beginPrepare = useCallback((formId: string): number => {
    const s = state.current;
    s.token += 1;
    s.formId = formId;
    s.consumed = false;
    render((n) => n + 1);
    return s.token;
  }, []);
  const isRequestCurrent = useCallback((value: PreparedInsertion): boolean => {
    const s = state.current;
    const p = s.panel;
    return (
      p !== null &&
      p.visible &&
      s.token === value.requestEpoch &&
      s.formId === value.formId &&
      sameComposerOwner(value.owner, s.owner) &&
      sameComposerOwner(p.owner, s.owner) &&
      p.panelRef === value.panelRef &&
      p.serverEpoch === value.serverEpoch &&
      p.generation === value.generation &&
      p.authorityEpoch === value.authorityEpoch
    );
  }, []);
  const isPreparedCurrent = useCallback(
    (value: PreparedInsertion) => !state.current.consumed && isRequestCurrent(value),
    [isRequestCurrent],
  );
  const insertPrepared = useCallback(
    (value: PreparedInsertion): InsertPreparedResult => {
      if (!isPreparedCurrent(value)) return 'stale';
      state.current.consumed = true;
      update((d) => ({
        ...d,
        text: d.text && value.text ? `${d.text}\n\n${value.text}` : d.text + value.text,
        literalSend: true,
      }));
      const input = options.inputRef?.current;
      input?.focus();
      if (input !== undefined && input !== null) {
        const length = state.current.buckets.get(draftKey(state.current.owner))!.text.length;
        requestAnimationFrame(() => {
          if (isOwnerCurrent(value.owner)) {
            input.focus();
            input.setSelectionRange(length, length);
          }
        });
      }
      return 'inserted';
    },
    [isPreparedCurrent, isOwnerCurrent, options.inputRef, update],
  );
  const capture = useCallback((): DraftCapture => {
    const s = state.current;
    return { owner: s.owner, revision: s.buckets.get(draftKey(s.owner))!.revision };
  }, []);
  const migrateProvisional = useCallback(
    (
      source: DraftCapture,
      sessionId: string,
      projectId: string,
      rootKey: string,
    ): DraftMigrationTicket | null => {
      const s = state.current;
      const draft = s.buckets.get(draftKey(s.owner));
      if (
        source.owner.sessionId !== '' ||
        !sameComposerOwner(source.owner, s.owner) ||
        draft?.revision !== source.revision
      )
        return null;
      const destination = { sessionId, projectId, rootKey, epoch: s.owner.epoch + 1 };
      const ticket = { source, destination, revision: source.revision };
      s.buckets.delete(draftKey(s.owner));
      s.key = ownerKey(sessionId, projectId, rootKey);
      s.owner = destination;
      s.buckets.set(draftKey(s.owner), draft);
      s.panel = null;
      s.token += 1;
      s.consumed = true;
      s.ticket = ticket;
      s.migrationPending = true;
      render((n) => n + 1);
      return ticket;
    },
    [],
  );
  const clearSubmittedDraftIfCurrent = useCallback(
    (source: DraftCapture, ticket: DraftMigrationTicket | null = null): boolean => {
      const s = state.current;
      const owner =
        ticket !== null && s.ticket === ticket && ticket.source === source
          ? ticket.destination
          : source.owner;
      const draft = s.buckets.get(draftKey(s.owner));
      if (!sameComposerOwner(owner, s.owner) || draft?.revision !== source.revision) return false;
      s.sequence += 1;
      s.buckets.set(draftKey(s.owner), { ...emptyDraft(), revision: s.sequence });
      s.ticket = null;
      render((n) => n + 1);
      return true;
    },
    [],
  );
  return {
    owner: current.owner,
    draft: active,
    setText,
    setImages,
    resetLiteral,
    isOwnerCurrent,
    setPanelContext,
    invalidatePanel,
    beginPrepare,
    isPreparedCurrent,
    isRequestCurrent,
    insertPrepared,
    capture,
    migrateProvisional,
    clearSubmittedDraftIfCurrent,
  };
}
export type ComposerDraftController = ReturnType<typeof useComposerDraft>;
