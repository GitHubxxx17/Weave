import { PluginError } from './plugin-errors.js';
import { type Disposer } from './service.js';

/**
 * Extension points let one plugin own an aggregation that other plugins
 * contribute into. The owner reads the accumulated result after every
 * contribution for the current generation has run, so contribution order is
 * the only thing that matters and a plugin never observes a half-built point.
 *
 * `T` is the contributor-facing API (for example `{ addTool(tool): void }`).
 * A `singleSlot` point accepts at most one contribution.
 */
export interface ExtensionPoint<T> {
  readonly id: string;
  readonly singleSlot: boolean;
  /** Phantom carrier of the contributor API type; never set at runtime. */
  readonly __api?: T;
}

/** Defines an extension point. `singleSlot` rejects a second contribution. */
export function defineExtensionPoint<T>(spec: {
  id: string;
  singleSlot?: boolean;
}): ExtensionPoint<T> {
  return Object.freeze({ id: spec.id, singleSlot: spec.singleSlot ?? false }) as ExtensionPoint<T>;
}

type Contributor<T> = (api: T) => void;

interface ContributionEntry {
  readonly fn: Contributor<unknown>;
  readonly pluginId: string;
}

/** Collects contributions per extension point and replays them against an owner API. */
export class ExtensionRegistry {
  readonly #contributions = new Map<string, ContributionEntry[]>();
  readonly #singleSlot = new Map<string, boolean>();

  /** Records a contribution to `point`. Returns a disposer that removes it. */
  contribute<T>(point: ExtensionPoint<T>, fn: Contributor<T>, pluginId: string): Disposer {
    this.#singleSlot.set(point.id, point.singleSlot);
    const entry: ContributionEntry = { fn: fn as Contributor<unknown>, pluginId };
    const list = this.#contributions.get(point.id);
    if (list === undefined) {
      this.#contributions.set(point.id, [entry]);
    } else {
      list.push(entry);
    }
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const current = this.#contributions.get(point.id);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(entry);
      if (index >= 0) {
        current.splice(index, 1);
      }
    };
  }

  /**
   * Runs every contribution to `point` against `api` in registration order and
   * returns `api`. Throws when a single-slot point has more than one
   * contribution.
   */
  collect<T>(point: ExtensionPoint<T>, api: T): T {
    const list = this.#contributions.get(point.id) ?? [];
    if (point.singleSlot && list.length > 1) {
      throw new PluginError(
        'plugin-extension-single-slot',
        `Extension point "${point.id}" is single-slot but has ${list.length} contributions ` +
          `(from plugins ${list.map((entry) => entry.pluginId).join(', ')})`,
      );
    }
    for (const entry of list) {
      (entry.fn as Contributor<T>)(api);
    }
    return api;
  }

  /** Number of contributions recorded for a point (test/introspection aid). */
  count(point: ExtensionPoint<unknown>): number {
    return this.#contributions.get(point.id)?.length ?? 0;
  }
}
