import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type {
  NewSessionEvent,
  PluginEventType,
  SessionEvent,
  SessionEventStore,
} from '@weave/runtime';

import { createPluginKernel, definePlugin, type KernelPlugin } from '../src/kernel.js';
import { type PluginManifest } from '../src/manifest.js';
import { PluginError } from '../src/plugin-errors.js';
import {
  createPluginEventRegistry,
  createPluginEventReader,
  createPluginSessionStore,
  type PluginEventDefinition,
  type PluginEventProjection,
  type ProjectedPluginEventHandle,
} from '../src/plugin-events.js';
import { eventsExtensionPoint } from '../src/seams.js';

const noteSchema = z.object({ text: z.string().min(1) });
type NotePayload = z.infer<typeof noteSchema>;

interface NotesState {
  readonly texts: readonly string[];
  readonly lastSequence: number;
}

const notesProjection: PluginEventProjection<NotePayload, NotesState> = {
  initial: () => ({ texts: [], lastSequence: 0 }),
  apply: (state, event) => ({
    texts: [...state.texts, event.payload.text],
    lastSequence: event.sequence,
  }),
};

function definition(
  type: PluginEventType,
  over: Partial<PluginEventDefinition> = {},
): PluginEventDefinition {
  return { type, schema: noteSchema, ...over } as PluginEventDefinition;
}

function stored(type: string, payload: unknown, sequence: number): SessionEvent {
  return {
    eventId: `event-${sequence}`,
    sessionId: 'session-1',
    sequence,
    occurredAt: '2026-01-01T00:00:00.000Z',
    type,
    payload,
  } as unknown as SessionEvent;
}

function pluginError(action: () => unknown): PluginError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof PluginError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the action to throw a PluginError');
}

describe('plugin event registry', () => {
  it('lists the events in registration order and finds each by type', () => {
    const registry = createPluginEventRegistry();
    const first = definition('notes/note-added');
    const second = definition('notes/note-removed');

    registry.define(first);
    registry.define(second);

    expect(registry.list()).toEqual([
      { type: first.type, hasProjection: false },
      { type: second.type, hasProjection: false },
    ]);
    expect(registry.get('notes/note-removed')).toEqual({ type: second.type, hasProjection: false });
    expect(registry.get('notes/missing')).toBeUndefined();
  });

  it('rejects a type that is not <pluginId>/<name>', () => {
    const registry = createPluginEventRegistry();

    expect(
      pluginError(() => registry.define(definition('turn.started' as PluginEventType))),
    ).toMatchObject({
      code: 'plugin-event-invalid',
    });
    expect(registry.list()).toEqual([]);
  });

  it('rejects a second definition of the same type', () => {
    const registry = createPluginEventRegistry();
    registry.define(definition('notes/note-added'));

    expect(pluginError(() => registry.define(definition('notes/note-added')))).toMatchObject({
      code: 'plugin-registration-conflict',
    });
    expect(registry.list()).toHaveLength(1);
  });

  describe('parse', () => {
    it('returns the type and the payload the schema produced', () => {
      const registry = createPluginEventRegistry();
      registry.define(definition('notes/note-added'));

      expect(
        registry.parse({ type: 'notes/note-added', payload: { text: 'hello', extra: 1 } }),
      ).toEqual({ type: 'notes/note-added', payload: { text: 'hello' } });
    });

    it('rejects an event nobody registered', () => {
      const registry = createPluginEventRegistry();

      expect(
        pluginError(() => registry.parse({ type: 'notes/note-added', payload: { text: 'x' } })),
      ).toMatchObject({
        code: 'plugin-event-unknown',
        message: expect.stringContaining('not registered by any plugin'),
      });
    });

    it('rejects a core event type, which only the Runtime writes', () => {
      const registry = createPluginEventRegistry();

      expect(
        pluginError(() => registry.parse({ type: 'turn.completed', payload: { status: 'done' } })),
      ).toMatchObject({
        code: 'plugin-event-unknown',
        message: expect.stringContaining('is not a plugin event'),
      });
    });

    it('rejects a payload the schema refuses and names the field', () => {
      const registry = createPluginEventRegistry();
      registry.define(definition('notes/note-added'));

      const error = pluginError(() =>
        registry.parse({ type: 'notes/note-added', payload: { text: '' } }),
      );

      expect(error.code).toBe('plugin-event-invalid');
      expect(error.message).toContain('notes/note-added');
      expect(error.message).toContain('text:');
      expect(error.cause).toBeInstanceOf(z.ZodError);
    });

    it('returns the JSON form of the payload, which is what every Store keeps', () => {
      const registry = createPluginEventRegistry();
      registry.define(
        definition('notes/note-added', {
          schema: z.object({ text: z.string(), at: z.date(), tag: z.string().optional() }),
        }),
      );

      const parsed = registry.parse({
        type: 'notes/note-added',
        payload: { text: 'hi', at: new Date('2026-02-03T04:05:06.000Z'), tag: undefined },
      });

      expect(parsed.payload).toEqual({ text: 'hi', at: '2026-02-03T04:05:06.000Z' });
      expect('tag' in parsed.payload).toBe(false);
    });

    it('rejects a payload that cannot be stored as JSON', () => {
      const registry = createPluginEventRegistry();
      registry.define(definition('notes/note-added', { schema: z.object({ n: z.bigint() }) }));

      expect(
        pluginError(() => registry.parse({ type: 'notes/note-added', payload: { n: 1n } })),
      ).toMatchObject({
        code: 'plugin-event-invalid',
        message: expect.stringContaining('cannot be stored as a JSON object'),
      });
    });

    it('rejects a schema that does not produce an object', () => {
      const registry = createPluginEventRegistry();
      registry.define(definition('notes/note-added', { schema: z.string() as never }));

      expect(
        pluginError(() => registry.parse({ type: 'notes/note-added', payload: 'text' })),
      ).toMatchObject({ code: 'plugin-event-invalid' });
    });
  });

  describe('project', () => {
    const projected = (): ReturnType<typeof createPluginEventRegistry> => {
      const registry = createPluginEventRegistry();
      registry.define(
        definition('notes/note-added', {
          project: notesProjection as PluginEventDefinition['project'],
        }),
      );
      registry.define(definition('notes/plain'));
      return registry;
    };

    it('folds only the events of its type, in log order', () => {
      const state = projected().project<NotesState>('notes/note-added', [
        stored('session.created', {}, 1),
        stored('notes/note-added', { text: 'first' }, 2),
        stored('other/note-added', { text: 'not mine' }, 3),
        stored('notes/note-added', { text: 'second' }, 4),
      ]);

      expect(state).toEqual({ texts: ['first', 'second'], lastSequence: 4 });
    });

    it('returns the initial state when the Session has none of the event', () => {
      expect(projected().project<NotesState>('notes/note-added', [])).toEqual({
        texts: [],
        lastSequence: 0,
      });
    });

    it('skips an event written under an older schema instead of failing the Session', () => {
      const state = projected().project<NotesState>('notes/note-added', [
        stored('notes/note-added', { body: 'old shape' }, 1),
        stored('notes/note-added', { text: 'current' }, 2),
      ]);

      expect(state.texts).toEqual(['current']);
    });

    it('rejects an event nobody registered and one without a projection', () => {
      const registry = projected();

      expect(pluginError(() => registry.project('notes/missing', []))).toMatchObject({
        code: 'plugin-event-unknown',
      });
      expect(pluginError(() => registry.project('notes/plain', []))).toMatchObject({
        code: 'plugin-event-unknown',
        message: expect.stringContaining('has no projection'),
      });
    });
  });
});

describe('plugin session store', () => {
  function setup() {
    const registry = createPluginEventRegistry();
    registry.define(definition('notes/note-added'));
    const appended: { sessionId: string; events: readonly NewSessionEvent[] }[] = [];
    const reads: unknown[] = [];
    let closed = 0;
    const history = [stored('session.created', {}, 1)];
    const store: SessionEventStore = {
      append: (sessionId, events) => {
        appended.push({ sessionId, events });
        return Promise.resolve(
          events.map((event, index) => stored(event.type, event.payload, index + 2)),
        );
      },
      read: (sessionId, options) => {
        reads.push({ sessionId, options });
        return Promise.resolve(history);
      },
      close: () => {
        closed += 1;
        return Promise.resolve();
      },
    };
    return {
      facade: createPluginSessionStore(store, registry, 'notes'),
      appended,
      reads,
      closedCount: () => closed,
      history,
    };
  }

  it('appends a registered event with the payload the schema produced', async () => {
    const { facade, appended } = setup();

    const events = await facade.append('session-1', [
      { type: 'notes/note-added', payload: { text: 'hi', extra: true } } as NewSessionEvent,
    ]);

    expect(appended).toEqual([
      {
        sessionId: 'session-1',
        events: [{ type: 'notes/note-added', payload: { text: 'hi' } }],
      },
    ]);
    expect(events.map((event) => event.type)).toEqual(['notes/note-added']);
  });

  it('refuses to write a core event, so a plugin cannot forge a turn or a message', async () => {
    const { facade, appended } = setup();

    await expect(
      facade.append('session-1', [
        {
          type: 'turn.completed',
          payload: { turnId: 't1', status: 'completed' },
        } as NewSessionEvent,
      ]),
    ).rejects.toMatchObject({ code: 'plugin-event-unknown' });
    expect(appended).toEqual([]);
  });

  it('refuses an unregistered plugin event and an invalid payload', async () => {
    const { facade, appended } = setup();

    await expect(
      facade.append('session-1', [{ type: 'notes/other', payload: {} } as NewSessionEvent]),
    ).rejects.toMatchObject({ code: 'plugin-event-unknown' });
    await expect(
      facade.append('session-1', [
        { type: 'notes/note-added', payload: { text: 7 } } as unknown as NewSessionEvent,
      ]),
    ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
    expect(appended).toEqual([]);
  });

  it('rejects the whole batch when any event in it is rejected', async () => {
    const { facade, appended } = setup();

    await expect(
      facade.append('session-1', [
        { type: 'notes/note-added', payload: { text: 'fine' } } as NewSessionEvent,
        { type: 'notes/note-added', payload: { text: '' } } as NewSessionEvent,
      ]),
    ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
    expect(appended).toEqual([]);
  });

  it('reads through, core events included', async () => {
    const { facade, reads, history } = setup();

    expect(await facade.read('session-1', { afterSequence: 0 })).toBe(history);
    expect(reads).toEqual([{ sessionId: 'session-1', options: { afterSequence: 0 } }]);
  });

  it('does not close the Store the host owns', async () => {
    const { facade, closedCount } = setup();

    await facade.close();

    expect(closedCount()).toBe(0);
  });
});

describe('env.defineEvent', () => {
  const manifest = (id: string, over: Partial<PluginManifest> = {}): PluginManifest => ({
    id,
    name: id,
    version: '0.1.0',
    apiVersion: '1.0.0',
    capabilities: ['event'],
    ...over,
  });

  async function sealed(...plugins: KernelPlugin[]) {
    const kernel = createPluginKernel();
    for (const plugin of plugins) {
      await kernel.register(plugin);
    }
    await kernel.seal();
    const registry = createPluginEventRegistry();
    kernel.extensions.collect(eventsExtensionPoint, {
      addEvent: (event) => registry.define(event),
    });
    return { kernel, registry };
  }

  it('registers the event as <pluginId>/<name> once the owner collects', async () => {
    const { kernel, registry } = await sealed(
      definePlugin({
        manifest: manifest('notes'),
        setup: (env) => {
          env.defineEvent('note-added', { schema: noteSchema });
        },
      }),
    );

    expect(registry.list().map((event) => event.type)).toEqual(['notes/note-added']);
    expect(kernel.plugins()[0]?.contributed.events).toEqual(['notes/note-added']);
  });

  it('hands back a handle that builds events and projects a Session', async () => {
    let handle: ProjectedPluginEventHandle<NotePayload, NotesState> | undefined;
    await sealed(
      definePlugin({
        manifest: manifest('notes'),
        setup: (env) => {
          handle = env.defineEvent('note-added', {
            schema: noteSchema,
            project: notesProjection,
          });
        },
      }),
    );

    expect(handle?.type).toBe('notes/note-added');
    expect(handle?.create({ text: 'hello' })).toEqual({
      type: 'notes/note-added',
      payload: { text: 'hello' },
    });
    expect(
      handle?.project([
        stored('turn.started', {}, 1),
        stored('notes/note-added', { text: 'a' }, 2),
        stored('notes/note-added', { text: 'b' }, 3),
      ]),
    ).toEqual({ texts: ['a', 'b'], lastSequence: 3 });
  });

  it('is governed by the event capability', async () => {
    const kernel = createPluginKernel();

    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('notes', { capabilities: ['tool'] }),
          setup: (env) => {
            env.defineEvent('note-added', { schema: noteSchema });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-capability-not-declared' });
  });

  it('rejects a name that is not lowercase and hyphen-separated', async () => {
    const kernel = createPluginKernel();

    await expect(
      kernel.register(
        definePlugin({
          manifest: manifest('notes'),
          setup: (env) => {
            env.defineEvent('Note Added', { schema: noteSchema });
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'plugin-event-invalid' });
  });

  it('keeps a plugin that declared contributes to the event types it listed', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('notes', { contributes: { events: ['notes/note-added'] } }),
        setup: (env) => {
          env.defineEvent('note-added', { schema: noteSchema });
          env.defineEvent('note-removed', { schema: noteSchema });
        },
      }),
    );
    await kernel.seal();
    const registry = createPluginEventRegistry();

    expect(
      pluginError(() =>
        kernel.extensions.collect(eventsExtensionPoint, {
          addEvent: (event) => registry.define(event),
        }),
      ),
    ).toMatchObject({ code: 'plugin-contributes-exceeds-manifest' });
    expect(registry.list().map((event) => event.type)).toEqual(['notes/note-added']);
  });

  it('does not let a plugin define an event in another plugin namespace', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('sneaky'),
        setup: (env) => {
          env.contribute(eventsExtensionPoint, (api) =>
            api.addEvent(definition('notes/note-added')),
          );
        },
      }),
    );
    await kernel.seal();
    const registry = createPluginEventRegistry();

    expect(
      pluginError(() =>
        kernel.extensions.collect(eventsExtensionPoint, {
          addEvent: (event) => registry.define(event),
        }),
      ),
    ).toMatchObject({
      code: 'plugin-event-invalid',
      message: expect.stringContaining('must start with "sneaky/"'),
    });
    expect(registry.list()).toEqual([]);
  });

  it('stops contributing the event when the plugin is disposed', async () => {
    const kernel = createPluginKernel();
    await kernel.register(
      definePlugin({
        manifest: manifest('notes'),
        setup: (env) => {
          env.defineEvent('note-added', { schema: noteSchema });
        },
      }),
    );
    await kernel.dispose();
    const registry = createPluginEventRegistry();

    kernel.extensions.collect(eventsExtensionPoint, {
      addEvent: (event) => registry.define(event),
    });

    expect(registry.list()).toEqual([]);
  });
});

describe('plugin event owner boundaries', () => {
  function recording() {
    const written: unknown[] = [];
    const store: SessionEventStore = {
      append: async (_id, events) => {
        written.push(...events);
        return [];
      },
      read: async () => [],
      close: async () => undefined,
    };
    return { store, written };
  }

  it('requires a valid owner instead of offering an unbound writer', () => {
    const { store } = recording();
    const registry = createPluginEventRegistry();
    expect(() => createPluginSessionStore(store, registry, undefined as never)).toThrow();
    expect(() => createPluginSessionStore(store, registry, 'first/other')).toThrow();
  });

  it('rejects every foreign type before invoking any schema in the batch', async () => {
    const { store, written } = recording();
    let validations = 0;
    const registry = createPluginEventRegistry();
    const schema = z.object({ text: z.string() }).transform((value) => {
      validations++;
      return value;
    });
    registry.define({ type: 'notes/report', schema });
    registry.define({ type: 'other/report', schema });
    const writer = createPluginSessionStore(store, registry, 'notes');
    await expect(
      writer.append('s', [
        { type: 'notes/report', payload: { text: 'own' } },
        { type: 'other/report', payload: { text: 'foreign' } },
      ] as NewSessionEvent[]),
    ).rejects.toMatchObject({ pluginId: 'notes' });
    expect(validations).toBe(0);
    expect(written).toEqual([]);
  });

  it('rejects a parser that relabels a valid own event after parsing', async () => {
    const { store, written } = recording();
    const registry = createPluginEventRegistry();
    registry.define(definition('notes/report'));
    const writer = createPluginSessionStore(
      store,
      { ...registry, parse: (event) => ({ ...registry.parse(event), type: 'other/report' }) },
      'notes',
    );
    await expect(
      writer.append('s', [{ type: 'notes/report', payload: { text: 'own' } }] as NewSessionEvent[]),
    ).rejects.toMatchObject({ pluginId: 'notes' });
    expect(written).toEqual([]);
  });

  it('captures all input types before a schema can mutate later event objects', async () => {
    const { store, written } = recording();
    const registry = createPluginEventRegistry();
    const events = [
      { type: 'notes/report', payload: { text: 'first' } },
      { type: 'notes/report', payload: { text: 'second' } },
    ] as NewSessionEvent[];
    registry.define({
      type: 'notes/report',
      schema: noteSchema.transform((value) => {
        Object.assign(events[1]!, { type: 'other/report' });
        return value;
      }),
    });
    await createPluginSessionStore(store, registry, 'notes').append('s', events);
    expect(written).toEqual([
      { type: 'notes/report', payload: { text: 'first' } },
      { type: 'notes/report', payload: { text: 'second' } },
    ]);
  });

  it('retains stable definitions while exposing only frozen reader metadata', () => {
    const registry = createPluginEventRegistry();
    const original = definition('notes/report', {
      project: notesProjection as PluginEventDefinition['project'],
    });
    registry.define(original);
    const reader = createPluginEventReader(registry);
    expect(Object.keys(reader).sort()).toEqual(['get', 'list', 'parse', 'project']);
    expect(Object.isFrozen(reader)).toBe(true);
    const info = reader.get('notes/report')!;
    expect(info).toEqual({ type: 'notes/report', hasProjection: true });
    expect(Object.isFrozen(info)).toBe(true);
    expect(Object.isFrozen(reader.list())).toBe(true);
    expect('schema' in info).toBe(false);
    expect('project' in info).toBe(false);
    expect(registry.get('notes/report')).toEqual(info);
    Object.assign(original, {
      type: 'other/report',
      schema: z.object({ changed: z.boolean() }),
      project: undefined,
    });
    expect(reader.parse({ type: 'notes/report', payload: { text: 'same' } })).toEqual({
      type: 'notes/report',
      payload: { text: 'same' },
    });
    expect(
      reader.project<NotesState>('notes/report', [stored('notes/report', { text: 'same' }, 1)]),
    ).toEqual({ texts: ['same'], lastSequence: 1 });
  });

  it('copies projection callback structure instead of keeping its mutable author object', () => {
    const registry = createPluginEventRegistry();
    const projection = { initial: () => 0, apply: (state: number) => state + 1 };
    registry.define({
      type: 'notes/report',
      schema: noteSchema,
      project: projection as PluginEventDefinition['project'],
    });
    Object.assign(projection, { initial: () => 100, apply: () => 999 });
    expect(registry.project('notes/report', [stored('notes/report', { text: 'same' }, 1)])).toBe(1);
  });
});

describe('stable parsing identity', () => {
  it('rejects a parser that mutates its input type while returning the same relabelled event', async () => {
    const registry = createPluginEventRegistry();
    registry.define(definition('notes/report'));
    let writes = 0;
    const store: SessionEventStore = {
      append: async () => {
        writes++;
        return [];
      },
      read: async () => [],
      close: async () => undefined,
    };
    const writer = createPluginSessionStore(
      store,
      {
        ...registry,
        parse: (event) => {
          Object.assign(event, { type: 'notes/changed' });
          return { type: 'notes/changed', payload: { text: 'own' } };
        },
      },
      'notes',
    );
    await expect(
      writer.append('s', [{ type: 'notes/report', payload: { text: 'own' } }] as NewSessionEvent[]),
    ).rejects.toMatchObject({ pluginId: 'notes' });
    expect(writes).toBe(0);
  });

  it('captures a definition type getter once and returns that stable key', () => {
    const registry = createPluginEventRegistry();
    let reads = 0;
    const entry = {
      get type() {
        return ++reads === 1 ? 'notes/report' : 'other/report';
      },
      schema: noteSchema,
    } as PluginEventDefinition;
    registry.define(entry);
    expect(reads).toBe(1);
    expect(registry.parse({ type: 'notes/report', payload: { text: 'own' } }).type).toBe(
      'notes/report',
    );
    expect(registry.list()).toEqual([{ type: 'notes/report', hasProjection: false }]);
  });
});
