import { describe, expect, it, vi } from 'vitest';
import { createPanelService } from '../src/plugin-panel-service.js';
import type {
  BoundPanelDefinition,
  CurrentUiAuthority,
  CurrentUiObservation,
} from '../src/plugin-panel-types.js';
import type { ServerHost } from '../src/server-host.js';
import type { SessionEvent, SessionEventStore } from '@weave/session';
const event = (sequence: number, type: string, payload: unknown = {}): SessionEvent =>
  ({
    eventId: String(sequence),
    sessionId: 's',
    sequence,
    type,
    payload,
    occurredAt: '2026-11-22T00:00:00.000Z',
  }) as SessionEvent;
const panel = {
  panelId: 'plugin:quality/report',
  pluginId: 'quality',
  pluginName: 'Quality',
  pluginVersion: '1.0.0',
  definitionHash: '0'.repeat(64),
  commands: { review: { name: 'review', prompt: 'Review\n\n$ARGUMENTS' } },
  definition: {
    schemaVersion: 1,
    id: 'report',
    title: 'Report',
    icon: 'info',
    placement: 'right',
    sources: [],
    blocks: [
      {
        id: 'review',
        type: 'form',
        fields: [
          { id: 'target', type: 'text', label: 'Target', required: true, default: 'src' },
          { id: 'include-tests', type: 'boolean', label: 'Include tests', default: true },
        ],
        submit: { type: 'prepare-command', command: 'review', label: 'Prepare' },
      },
    ],
  },
} as const satisfies BoundPanelDefinition;
function fixture(
  read = vi.fn(async () => [event(1, 'session.created')]),
  bound: BoundPanelDefinition = panel,
) {
  let controller = new AbortController(),
    epoch = 1;
  const listeners = new Set<() => void>();
  let available = true;
  const authority: CurrentUiAuthority = {
    captureCurrentUiSync: () => ({
      generationId: 1,
      authorityEpoch: epoch,
      available,
      members: [{ kind: 'host', pluginId: 'quality', baselineId: 'baseline' }],
      signal: controller.signal,
    }),
    assertCurrentUiSync(capture: CurrentUiObservation) {
      if (capture.signal.aborted || capture.authorityEpoch !== epoch || !available)
        throw new Error('stale');
    },
    subscribeUiInvalidationSync(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const host = {
    controller: () => ({ current: () => ({ id: 1 }) }),
    currentPublicationSync: () => ({
      generationId: 1,
      publicationId: 'B'.repeat(32),
      panels: [bound],
    }),
    subscribePublicationSync: () => () => {},
  } as unknown as ServerHost;
  const store = { read, append: vi.fn(), close: vi.fn() } as unknown as SessionEventStore;
  const service = createPanelService({ host, authority, sessionStore: store });
  return {
    service,
    read,
    store,
    ref: service.catalog().panels[0]!.panelRef,
    invalidate() {
      const previous = controller;
      controller = new AbortController();
      epoch++;
      for (const listener of listeners) listener();
      previous.abort();
    },
    withdraw() {
      available = false;
      this.invalidate();
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
describe('panel service', () => {
  it('prepares canonical field order without defaults implicitly applied or writes', async () => {
    const f = fixture();
    const prepared = await f.service.prepare(
      's',
      f.ref,
      { formId: 'review', values: { 'include-tests': true, target: 'src' } },
      {},
    );
    expect(prepared.text).toBe('Review\n\n{"target":"src","include-tests":true}');
    expect(prepared.requiresUserSend).toBe(true);
    expect(f.store.append).not.toHaveBeenCalled();
    await expect(
      f.service.prepare('s', f.ref, { formId: 'review', values: {} }, {}),
    ).rejects.toMatchObject({ code: 'panel-invalid-input' });
    await expect(
      f.service.prepare(
        's',
        f.ref,
        { formId: 'review', values: { target: 'src', unknown: 'bad' } },
        {},
      ),
    ).rejects.toMatchObject({ code: 'panel-invalid-input' });
  });
  it('rotates refs even for same eligible current generation and rejects old pending work', async () => {
    const pending = deferred<SessionEvent[]>();
    const f = fixture(vi.fn(() => pending.promise));
    const waiting = f.service.read('s', f.ref, {});
    await Promise.resolve();
    f.invalidate();
    expect(f.service.catalog().panels[0]!.panelRef).not.toBe(f.ref);
    pending.resolve([event(1, 'session.created')]);
    await expect(waiting).rejects.toBeDefined();
    await expect(f.service.read('s', f.ref, {})).rejects.toMatchObject({ code: 'panel-stale' });
    await f.service.drain();
  });
  it('joins only exact jobs, limits per-key consumers and retains aborted store slot', async () => {
    const pending = deferred<SessionEvent[]>();
    const read = vi.fn(() => pending.promise);
    const f = fixture(read);
    const abort = new AbortController();
    const waiting = [
      f.service.read('s', f.ref, { signal: abort.signal }),
      ...Array.from({ length: 3 }, () => f.service.read('s', f.ref, {})),
    ];
    await expect(f.service.read('s', f.ref, {})).rejects.toMatchObject({ code: 'panel-busy' });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    abort.abort();
    await expect(waiting[0]).rejects.toBeDefined();
    pending.resolve([event(1, 'session.created')]);
    await Promise.all(waiting.slice(1));
    await f.service.drain();
  });
  it('uses durable prefix archive state and observes a later restore tail', async () => {
    const f = fixture(
      vi
        .fn()
        .mockResolvedValueOnce([event(1, 'session.created'), event(2, 'session.archived')])
        .mockResolvedValueOnce([event(3, 'session.restored')]),
    );
    expect((await f.service.read('s', f.ref, {})).lastSequence).toBe(2);
    expect(
      (await f.service.prepare('s', f.ref, { formId: 'review', values: { target: 'src' } }, {}))
        .lastSequence,
    ).toBe(3);
    expect(f.read).toHaveBeenLastCalledWith('s', { afterSequence: 2 });
  });
  it('rejects archived preparation and post-close calls', async () => {
    const f = fixture(
      vi.fn(async () => [event(1, 'session.created'), event(2, 'session.archived')]),
    );
    await expect(
      f.service.prepare('s', f.ref, { formId: 'review', values: { target: 'src' } }, {}),
    ).rejects.toMatchObject({ code: 'session-archived' });
    f.service.closeSync();
    await expect(f.service.read('s', f.ref, {})).rejects.toMatchObject({
      code: 'panel-unavailable',
    });
    await f.service.drain();
  });
});

describe('panel job admission and prefix commit races', () => {
  it('admits8 store jobs and32 consumers, rejects ninth job/33rd consumer with no queue', async () => {
    const gates = Array.from({ length: 8 }, () => deferred<SessionEvent[]>());
    const read = vi.fn((id: string) => gates[Number(id.slice(1))]!.promise);
    const f = fixture(read);
    const waiting = Array.from({ length: 8 }, (_, i) =>
      Array.from({ length: 4 }, () => f.service.read(`s${i}`, f.ref, {})),
    ).flat();
    await expect(f.service.read('ninth', f.ref, {})).rejects.toMatchObject({ code: 'panel-busy' });
    await expect(f.service.read('s0', f.ref, {})).rejects.toMatchObject({ code: 'panel-busy' });
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(8);
    gates.forEach((gate, i) =>
      gate.resolve([{ ...event(1, 'session.created'), sessionId: `s${i}` }]),
    );
    await Promise.all(waiting);
    await f.service.drain();
  });
  it('holds all8 store slots after every caller aborts until real settlement; close rejects promptly and drain waits', async () => {
    const gate = deferred<SessionEvent[]>();
    const f = fixture(vi.fn(() => gate.promise));
    const aborts = Array.from({ length: 8 }, () => new AbortController());
    const waiting = aborts.map((abort, i) =>
      f.service.read(`s${i}`, f.ref, { signal: abort.signal }),
    );
    await Promise.resolve();
    expect(f.read).toHaveBeenCalledTimes(8);
    aborts.forEach((abort) => abort.abort());
    await Promise.allSettled(waiting);
    await expect(f.service.read('ninth', f.ref, {})).rejects.toMatchObject({ code: 'panel-busy' });
    let drained = false;
    f.service.closeSync();
    const drain = f.service.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    gate.resolve([event(1, 'session.created')]);
    await drain;
    expect(drained).toBe(true);
  });
  it('preserves cache cursor on failed tail and does not append a lifecycle fence after captured prefix', async () => {
    const gate = deferred<SessionEvent[]>();
    const read = vi
      .fn()
      .mockResolvedValueOnce([event(1, 'session.created')])
      .mockRejectedValueOnce(new Error('io'))
      .mockReturnValueOnce(gate.promise)
      .mockResolvedValueOnce([event(2, 'session.deleted')]);
    const f = fixture(read);
    await f.service.read('s', f.ref, {});
    await expect(f.service.read('s', f.ref, {})).rejects.toMatchObject({
      code: 'panel-store-unavailable',
    });
    const waiting = f.service.read('s', f.ref, {});
    await Promise.resolve();
    gate.resolve([]);
    expect((await waiting).lastSequence).toBe(1);
    await expect(f.service.read('s', f.ref, {})).rejects.toMatchObject({ code: 'session-deleted' });
    expect(read.mock.calls.slice(1).map((call) => call[1])).toEqual(
      Array(3).fill({ afterSequence: 1 }),
    );
  });
  it('keeps close consumers cancelled while underlying store remains drain-owned', async () => {
    const gate = deferred<SessionEvent[]>();
    const f = fixture(vi.fn(() => gate.promise));
    const waiting = f.service.read('s', f.ref, {});
    await Promise.resolve();
    f.service.closeSync();
    await expect(waiting).rejects.toMatchObject({ code: 'panel-unavailable' });
    let done = false;
    const drain = f.service.drain().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve([event(1, 'session.created')]);
    await drain;
  });
  it('rejects multibyte prompt/request limits and substitutes arguments literally', async () => {
    const huge = { ...panel, commands: { review: { name: 'review', prompt: '中'.repeat(11000) } } };
    const f = fixture(undefined, huge);
    await expect(
      f.service.prepare('s', f.ref, { formId: 'review', values: { target: 'src' } }, {}),
    ).rejects.toMatchObject({ code: 'panel-prompt-too-large' });
    const literal = fixture();
    expect(
      (
        await literal.service.prepare(
          's',
          literal.ref,
          { formId: 'review', values: { target: '$&$ARGUMENTS' } },
          {},
        )
      ).text,
    ).toBe('Review\n\n{"target":"$&$ARGUMENTS","include-tests":false}');
    const tooLarge = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`field${i}`, '中'.repeat(2048)]),
    );
    await expect(
      literal.service.prepare('s', literal.ref, { formId: 'review', values: tooLarge }, {}),
    ).rejects.toMatchObject({ code: 'panel-request-too-large' });
  });
});

describe('scheduled panel read admission', () => {
  it('does not invoke store after the sole consumer aborts before scheduled start', async () => {
    const f = fixture();
    const abort = new AbortController();
    const pending = f.service.read('s', f.ref, { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toBeDefined();
    await f.service.drain();
    expect(f.read).not.toHaveBeenCalled();
  });
  it('starts one exact shared job when the first caller aborts but a live joiner remains', async () => {
    const f = fixture();
    const abort = new AbortController();
    const first = f.service.read('s', f.ref, { signal: abort.signal });
    const joined = f.service.read('s', f.ref, {});
    abort.abort();
    await expect(first).rejects.toBeDefined();
    await expect(joined).resolves.toMatchObject({ lastSequence: 1 });
    expect(f.read).toHaveBeenCalledTimes(1);
  });
  it.each(['close', 'withdraw'] as const)(
    'avoids a scheduled store invocation after %s',
    async (change) => {
      const f = fixture();
      const waiting = f.service.read('s', f.ref, {});
      if (change === 'close') f.service.closeSync();
      else f.withdraw();
      await expect(waiting).rejects.toBeDefined();
      await f.service.drain();
      expect(f.read).not.toHaveBeenCalled();
    },
  );
});

describe('strict raw prepare field acceptance', () => {
  it('rejects own prototype-like unknown keys rather than silently dropping them', async () => {
    const optional = {
      ...panel,
      definition: {
        ...panel.definition,
        blocks: [
          {
            ...panel.definition.blocks[0],
            fields: [{ id: 'include-tests', type: 'boolean' as const, label: 'Include tests' }],
          },
        ],
      },
    } satisfies BoundPanelDefinition;
    const f = fixture(undefined, optional);
    const input = JSON.parse('{"formId":"review","values":{"__proto__":"unknown"}}');
    await expect(f.service.prepare('s', f.ref, input, {})).rejects.toMatchObject({
      code: 'panel-invalid-input',
    });
    expect(f.read).not.toHaveBeenCalled();
  });
});
