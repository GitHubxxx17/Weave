import type { PluginEventType, SessionEvent, SessionEventStore } from '@weave/runtime';
import type { z } from 'zod';
import { pluginEventNamePattern, pluginEventTypePattern } from './event-type.js';
import { PluginError } from './plugin-errors.js';

/**
 * Plugin-owned Session events.
 *
 * A plugin records its own durable facts in the Session log under the type
 * `<pluginId>/<name>`. The Session stores only check the envelope; what a
 * payload must look like is the plugin's contract, held by the host in a
 * {@link PluginEventRegistry} and applied when the plugin appends. Reading and
 * projecting a Session never depend on the registry, so a Session still opens
 * after a plugin is removed and its events simply stay in the log.
 */

/** An event as a plugin's projection sees it. */
export interface PluginEventRecord<P> {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly payload: P;
}

/**
 * Folds one event type of a Session into a state of the plugin's choosing.
 * `apply` must be pure: the same events always produce the same state.
 */
export interface PluginEventProjection<P, S> {
  /** The state of a Session that has none of this event. */
  initial(): S;
  /** Returns the state after `event`. */
  apply(state: S, event: PluginEventRecord<P>): S;
}

/** What a plugin gives `env.defineEvent` for one event. */
export interface PluginEventSpec<P extends Record<string, unknown>> {
  /** The payload contract; the output is what gets stored. */
  readonly schema: z.ZodType<P>;
}

/** An event spec that also builds a state out of the Session's events. */
export interface ProjectedPluginEventSpec<
  P extends Record<string, unknown>,
  S,
> extends PluginEventSpec<P> {
  readonly project: PluginEventProjection<P, S>;
}

/** One event a registry holds. */
export interface PluginEventDefinition<
  P extends Record<string, unknown> = Record<string, unknown>,
  S = unknown,
> {
  /** `<pluginId>/<name>`. */
  readonly type: PluginEventType;
  readonly schema: z.ZodType<P>;
  readonly project?: PluginEventProjection<P, S> | undefined;
}

/** A plugin event ready to append: a type and a payload its schema accepted. */
export interface PluginNewEvent {
  readonly type: PluginEventType;
  readonly payload: Record<string, unknown>;
}

/** What `env.defineEvent` hands back for appending one event type. */
export interface PluginEventHandle<P extends Record<string, unknown>> {
  readonly type: PluginEventType;
  /**
   * An event to pass to `append`. The payload is checked against the schema
   * again when it is appended, so the type here is a convenience, not a gate.
   */
  create(payload: P): PluginNewEvent;
}

/** A handle for an event that also has a projection. */
export interface ProjectedPluginEventHandle<
  P extends Record<string, unknown>,
  S,
> extends PluginEventHandle<P> {
  /** Folds the events of this type in `events` (any order of types) into the state. */
  project(events: readonly SessionEvent[]): S;
}

/** The plugin events a host accepts. */
export interface PluginEventRegistry {
  /** Registers an event type. Throws when it is malformed or already taken. */
  define(definition: PluginEventDefinition): void;
  get(type: string): PluginEventDefinition | undefined;
  /** The registered events in registration order. */
  list(): readonly PluginEventDefinition[];
  /**
   * Checks an event a plugin wants to append and returns what to store: the
   * type, and the payload as the schema produced it, in the JSON form a Store
   * keeps it. Throws `plugin-event-unknown` for a type nobody registered
   * (including every core event type) and `plugin-event-invalid` for a payload
   * the schema rejects.
   */
  parse(event: { readonly type: string; readonly payload: unknown }): PluginNewEvent;
  /**
   * Folds the events of `type` in `events` into the state its projection
   * builds. Events written under an older schema, which no longer parse, are
   * skipped: the log is append-only, so the plugin's schema has to accept what
   * it wants to keep seeing.
   */
  project<S = unknown>(type: string, events: readonly SessionEvent[]): S;
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) =>
        `${issue.path.length === 0 ? '(payload)' : issue.path.join('.')}: ${issue.message}`,
    )
    .join('; ');
}

/** Round-trips through JSON so every Store holds and returns the same value. */
function toJsonRecord(value: unknown): Record<string, unknown> {
  const json = JSON.stringify(value);
  const copy: unknown = json === undefined ? undefined : JSON.parse(json);
  if (typeof copy !== 'object' || copy === null || Array.isArray(copy)) {
    throw new TypeError('A payload must be a JSON object');
  }
  return copy as Record<string, unknown>;
}

function projectEvents<S>(definition: PluginEventDefinition, events: readonly SessionEvent[]): S {
  const projection = definition.project;
  if (projection === undefined) {
    throw new PluginError('plugin-event-unknown', `Event "${definition.type}" has no projection`);
  }
  let state = projection.initial();
  for (const event of events) {
    if (event.type !== definition.type) {
      continue;
    }
    const parsed = definition.schema.safeParse(event.payload);
    if (!parsed.success) {
      continue;
    }
    state = projection.apply(state, {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      payload: parsed.data,
    });
  }
  return state as S;
}

/** Creates an empty registry of plugin events. */
export function createPluginEventRegistry(): PluginEventRegistry {
  const definitions = new Map<string, PluginEventDefinition>();

  return {
    define(definition) {
      if (!pluginEventTypePattern.test(definition.type)) {
        throw new PluginError(
          'plugin-event-invalid',
          `Event type "${definition.type}" must look like <pluginId>/<name>, lowercase and hyphen-separated`,
        );
      }
      if (definitions.has(definition.type)) {
        throw new PluginError(
          'plugin-registration-conflict',
          `Event "${definition.type}" conflicts with an existing registration`,
        );
      }
      definitions.set(definition.type, definition);
    },

    get: (type) => definitions.get(type),

    list: () => [...definitions.values()],

    parse(event) {
      const definition = definitions.get(event.type);
      if (definition === undefined) {
        throw new PluginError(
          'plugin-event-unknown',
          pluginEventTypePattern.test(event.type)
            ? `Event "${event.type}" is not registered by any plugin`
            : `"${event.type}" is not a plugin event; plugins append only their own events, named <pluginId>/<name>`,
        );
      }
      const parsed = definition.schema.safeParse(event.payload);
      if (!parsed.success) {
        throw new PluginError(
          'plugin-event-invalid',
          `Payload of event "${definition.type}" is invalid: ${issueSummary(parsed.error)}`,
          { cause: parsed.error },
        );
      }
      try {
        return { type: definition.type, payload: toJsonRecord(parsed.data) };
      } catch (error: unknown) {
        throw new PluginError(
          'plugin-event-invalid',
          `Payload of event "${definition.type}" cannot be stored as a JSON object`,
          { cause: error },
        );
      }
    },

    project<S>(type: string, events: readonly SessionEvent[]): S {
      const definition = definitions.get(type);
      if (definition === undefined) {
        throw new PluginError(
          'plugin-event-unknown',
          `Event "${type}" is not registered by any plugin`,
        );
      }
      return projectEvents<S>(definition, events);
    },
  };
}

/**
 * The Session Store a plugin gets. Reads pass through. An append is accepted
 * only for events a plugin registered, with a payload its schema accepts, and
 * a batch with any rejected event is rejected whole before anything is
 * written. The core events (turns, messages, tool results) stay the Runtime's
 * to write: a plugin cannot forge them. `close` does nothing, because the host
 * owns the Store.
 */
export function createPluginSessionStore(
  store: SessionEventStore,
  events: PluginEventRegistry,
): SessionEventStore {
  return {
    append: async (sessionId, newEvents) =>
      store.append(
        sessionId,
        newEvents.map((event) => events.parse(event)),
      ),
    read: (sessionId, options) => store.read(sessionId, options),
    close: () => Promise.resolve(),
  };
}

/**
 * Builds the definition `env.defineEvent` registers for one of a plugin's
 * events, and the handle it hands back. Throws `plugin-event-invalid` for a
 * name that is not lowercase and hyphen-separated.
 */
export function createPluginEventDefinition<P extends Record<string, unknown>, S>(
  pluginId: string,
  name: string,
  spec: PluginEventSpec<P> & { readonly project?: PluginEventProjection<P, S> },
): { readonly definition: PluginEventDefinition; readonly handle: PluginEventHandle<P> } {
  if (!pluginEventNamePattern.test(name)) {
    throw new PluginError(
      'plugin-event-invalid',
      `Event name "${name}" of plugin "${pluginId}" must be lowercase and hyphen-separated`,
      { pluginId },
    );
  }
  const type = `${pluginId}/${name}` as PluginEventType;
  const definition = {
    type,
    schema: spec.schema,
    project: spec.project,
  } as unknown as PluginEventDefinition;
  const handle: PluginEventHandle<P> = {
    type,
    create: (payload) => ({ type, payload }),
  };
  if (spec.project === undefined) {
    return { definition, handle };
  }
  return {
    definition,
    handle: Object.assign(handle, {
      project: (sessionEvents: readonly SessionEvent[]): S =>
        projectEvents<S>(definition, sessionEvents),
    }),
  };
}
