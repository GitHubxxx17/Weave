import { randomBytes, randomUUID } from 'node:crypto';
import { PanelError } from './plugin-panel-errors.js';
import { createPanelCache, type PanelCacheEntry } from './plugin-panel-cache.js';
import {
  boundPanelData,
  projectPanelPrefix,
  type PanelProjection,
} from './plugin-panel-projection.js';
import {
  freezePanel,
  panelBytes,
  panelSessionIdSchema,
  panelTokenSchema,
  prepareRequestSchema,
  type BoundPanelDefinition,
  type CurrentUiObservation,
  type PanelCatalog,
  type PanelService,
  type PanelServiceOptions,
  type PreparedCommand,
} from './plugin-panel-types.js';
const token = () => randomBytes(24).toString('base64url');
interface RefEntry {
  readonly panel: BoundPanelDefinition;
  readonly ref: string;
  readonly observation: CurrentUiObservation;
}
interface Job {
  readonly identity: string;
  readonly base: PanelCacheEntry | undefined;
  readonly promise: Promise<PanelProjection>;
  consumers: number;
  readonly liveConsumers: Set<object>;
}
export function createPanelService({
  host,
  authority,
  sessionStore,
}: PanelServiceOptions): PanelService {
  const serviceAbort = new AbortController();
  const serverEpoch = token(),
    cache = createPanelCache();
  let refs = new Map<string, RefEntry>();
  let generation = 0,
    epoch = 0,
    closed = false;
  let catalogValue: PanelCatalog | undefined;
  let incorporatedPublicationId: string | undefined;
  let incorporatedSignal: AbortSignal | undefined;
  const jobs = new Map<string, Job>();
  const active = new Set<Promise<unknown>>();
  let consumers = 0;
  function rebuild() {
    const observation = authority.captureCurrentUiSync();
    const publication = host.currentPublicationSync();
    if (
      epoch === observation.authorityEpoch &&
      generation === observation.generationId &&
      catalogValue !== undefined &&
      incorporatedPublicationId === publication?.publicationId &&
      incorporatedSignal === observation.signal &&
      catalogValue.acceptingRuns === (!closed && observation.available) &&
      publication?.generationId === observation.generationId &&
      host.controller()?.current().id === observation.generationId
    )
      return;
    cache.clear();
    refs = new Map();
    epoch = observation.authorityEpoch;
    generation = observation.generationId;
    incorporatedPublicationId = publication?.publicationId;
    incorporatedSignal = observation.signal;
    const current =
      publication?.generationId === observation.generationId &&
      host.controller()?.current().id === publication.generationId;
    const panels = (current ? publication.panels : []).map((panel) => {
      const allowed =
        observation.available &&
        observation.members.some((member) => member.pluginId === panel.pluginId);
      const ref = token();
      refs.set(ref, { panel, ref, observation });
      return {
        panelId: panel.panelId,
        panelRef: ref,
        pluginId: panel.pluginId,
        pluginName: panel.pluginName,
        pluginVersion: panel.pluginVersion,
        state: allowed ? ('available' as const) : ('unavailable' as const),
        definition: panel.definition,
      };
    });
    catalogValue = freezePanel({
      schemaVersion: 1,
      serverEpoch,
      generation: Math.max(1, generation),
      authorityEpoch: epoch,
      acceptingRuns: !closed && observation.available && current,
      panels,
    });
    if (panelBytes(catalogValue) > 1048576) throw new PanelError('panel-unavailable');
  }
  function invalidate() {
    epoch = 0;
    incorporatedPublicationId = undefined;
    incorporatedSignal = undefined;
    catalogValue = undefined;
    cache.clear();
    refs.clear();
  }
  function observeInvalidation() {
    // Signal-abort callbacks can re-enter catalog before authority/publication
    // notifications reach this service. Preserve the exact already-incorporated
    // pair rather than rotating fresh refs a second time for the same change.
    const currentAuthority = authority.captureCurrentUiSync();
    const publication = host.currentPublicationSync();
    if (
      !closed &&
      catalogValue !== undefined &&
      publication !== undefined &&
      incorporatedPublicationId === publication.publicationId &&
      incorporatedSignal === currentAuthority.signal &&
      generation === publication.generationId &&
      epoch === currentAuthority.authorityEpoch &&
      currentAuthority.generationId === publication.generationId &&
      host.controller()?.current().id === publication.generationId &&
      catalogValue.acceptingRuns === currentAuthority.available
    )
      return;
    invalidate();
  }
  const unsubscribeAuthority = authority.subscribeUiInvalidationSync(observeInvalidation);
  const unsubscribePublication = host.subscribePublicationSync(observeInvalidation);
  function capture(sessionId: string, ref: string, signal?: AbortSignal): RefEntry {
    if (!panelSessionIdSchema.safeParse(sessionId).success)
      throw new PanelError('session-invalid-input');
    if (!panelTokenSchema.safeParse(ref).success) throw new PanelError('panel-invalid-input');
    signal?.throwIfAborted();
    if (closed) throw new PanelError('panel-unavailable');
    rebuild();
    const entry = refs.get(ref);
    if (!entry) throw new PanelError('panel-stale');
    check(entry, signal);
    return entry;
  }
  function check(entry: RefEntry, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (closed) throw new PanelError('panel-unavailable');
    authority.assertCurrentUiSync(entry.observation);
    if (
      !entry.observation.available ||
      entry.observation.signal.aborted ||
      !entry.observation.members.some((member) => member.pluginId === entry.panel.pluginId) ||
      host.controller()?.current().id !== entry.observation.generationId ||
      host.currentPublicationSync()?.generationId !== entry.observation.generationId ||
      refs.get(entry.ref) !== entry
    )
      throw new PanelError('panel-unavailable');
  }
  function tuple(entry: RefEntry) {
    return {
      serverEpoch,
      generation: entry.observation.generationId,
      authorityEpoch: entry.observation.authorityEpoch,
    };
  }
  async function prefix(
    sessionId: string,
    entry: RefEntry,
    signal?: AbortSignal,
  ): Promise<PanelProjection> {
    check(entry, signal);
    const key = JSON.stringify([
      serverEpoch,
      entry.observation.generationId,
      entry.observation.authorityEpoch,
      entry.ref,
      sessionId,
    ]);
    let job = jobs.get(key);
    if (
      consumers >= 32 ||
      (job !== undefined && job.consumers >= 4) ||
      (job === undefined && active.size >= 8)
    )
      throw new PanelError('panel-busy');
    if (!job) {
      const base = cache.get(key);
      const identity = JSON.stringify([
        key,
        base?.value.lastSequence ?? 0,
        base?.identity ?? randomUUID(),
        base?.version ?? 0,
      ]);
      const liveConsumers = new Set<object>();
      const pending = Promise.resolve()
        .then(() => {
          // Scheduling is an await boundary: authority or every consumer may
          // have withdrawn before any actual store operation was started.
          check(entry);
          if (liveConsumers.size === 0) throw new PanelError('panel-unavailable');
          return sessionStore.read(sessionId, { afterSequence: base?.value.lastSequence ?? 0 });
        })
        .catch((error: unknown) => {
          if (error instanceof PanelError) throw error;
          throw new PanelError('panel-store-unavailable');
        })
        .then((events) => {
          check(entry);
          let state = projectPanelPrefix(sessionId, entry.panel, base?.value, events);
          const data = boundPanelData(
            {
              schemaVersion: 1,
              ...tuple(entry),
              panelRef: entry.ref,
              panelId: entry.panel.panelId,
              sessionId,
              lastSequence: state.lastSequence,
              state: state.state,
              sources: [...state.sources],
              blocks: [...state.blocks],
            },
            entry.panel.definition,
          );
          state = freezePanel({
            ...state,
            state: data.state,
            sources: data.sources,
            blocks: data.blocks,
          });
          check(entry);
          if (jobs.get(key)?.identity === identity) cache.put(key, sessionId, state, base);
          return state;
        });
      job = { identity, base, promise: pending, consumers: 0, liveConsumers };
      jobs.set(key, job);
      active.add(pending);
      void pending
        .finally(() => {
          if (jobs.get(key)?.identity === identity) jobs.delete(key);
          active.delete(pending);
        })
        .catch(() => undefined);
    }
    job.consumers++;
    consumers++;
    const consumerIdentity = {};
    job.liveConsumers.add(consumerIdentity);
    let remove = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        const abort = () => {
          // Synchronous liveness withdrawal precedes the await/finally cleanup,
          // so the deferred start can still distinguish a live joining caller.
          job.liveConsumers.delete(consumerIdentity);
          reject(signal?.aborted ? signal.reason : new PanelError('panel-unavailable'));
        };
        signal?.addEventListener('abort', abort, { once: true });
        entry.observation.signal.addEventListener('abort', abort, { once: true });
        serviceAbort.signal.addEventListener('abort', abort, { once: true });
        remove = () => {
          signal?.removeEventListener('abort', abort);
          entry.observation.signal.removeEventListener('abort', abort);
          serviceAbort.signal.removeEventListener('abort', abort);
        };
      });
      const state = await Promise.race([job.promise, aborted]);
      check(entry, signal);
      return state;
    } finally {
      remove();
      job.liveConsumers.delete(consumerIdentity);
      job.consumers--;
      consumers--;
    }
  }
  return {
    catalog() {
      if (closed) throw new PanelError('panel-unavailable');
      rebuild();
      return catalogValue!;
    },
    async read(sessionId, ref, { signal }) {
      const entry = capture(sessionId, ref, signal);
      const state = await prefix(sessionId, entry, signal);
      check(entry, signal);
      return boundPanelData(
        {
          schemaVersion: 1,
          ...tuple(entry),
          panelRef: ref,
          panelId: entry.panel.panelId,
          sessionId,
          lastSequence: state.lastSequence,
          state: state.state,
          sources: [...state.sources],
          blocks: [...state.blocks],
        },
        entry.panel.definition,
      );
    },
    async prepare(sessionId, ref, input, { signal }) {
      const entry = capture(sessionId, ref, signal);
      if (panelBytes(input) > 16384) throw new PanelError('panel-request-too-large');
      const parsed = prepareRequestSchema.safeParse(input);
      if (!parsed.success) throw new PanelError('panel-invalid-input');
      const form = entry.panel.definition.blocks.find(
        (block) => block.id === parsed.data.formId && block.type === 'form',
      );
      if (form?.type !== 'form') throw new PanelError('panel-not-found');
      const values = parsed.data.values;
      const ids = new Set(form.fields.map((field) => field.id));
      if (Object.keys(values).some((key) => !ids.has(key)))
        throw new PanelError('panel-invalid-input');
      const ordered: Record<string, string | boolean> = Object.create(null) as Record<
        string,
        string | boolean
      >;
      for (const field of form.fields) {
        const value = Object.hasOwn(values, field.id)
          ? values[field.id]
          : field.type === 'boolean'
            ? false
            : '';
        if (field.type === 'boolean') {
          if (typeof value !== 'boolean') throw new PanelError('panel-invalid-input');
        } else {
          if (
            typeof value !== 'string' ||
            value.length > 2048 ||
            (field.required && value.trim() === '') ||
            (field.type === 'select' &&
              value !== '' &&
              !field.options.some((option) => option.value === value))
          )
            throw new PanelError('panel-invalid-input');
        }
        Object.defineProperty(ordered, field.id, { value, enumerable: true });
      }
      const command = entry.panel.commands[form.id];
      if (!command) throw new PanelError('panel-not-found');
      const args = JSON.stringify(ordered);
      const text = command.prompt.includes('$ARGUMENTS')
        ? command.prompt.split('$ARGUMENTS').join(args)
        : `${command.prompt}\n\n${args}`;
      if (Buffer.byteLength(text, 'utf8') > 32768) throw new PanelError('panel-prompt-too-large');
      const state = await prefix(sessionId, entry, signal);
      if (state.archived) throw new PanelError('session-archived');
      const result: PreparedCommand = {
        schemaVersion: 1,
        ...tuple(entry),
        panelRef: ref,
        panelId: entry.panel.panelId,
        sessionId,
        lastSequence: state.lastSequence,
        formId: form.id,
        command: command.name,
        text,
        requiresUserSend: true,
      };
      if (panelBytes(result) > 262144) throw new PanelError('panel-prompt-too-large');
      check(entry, signal);
      return freezePanel(result);
    },
    closeSync() {
      if (closed) return;
      closed = true;
      unsubscribeAuthority();
      unsubscribePublication();
      invalidate();
      serviceAbort.abort(new PanelError('panel-unavailable'));
    },
    async drain() {
      await Promise.allSettled([...active]);
    },
  };
}
