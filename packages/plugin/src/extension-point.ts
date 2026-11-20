import { assertNameDeclared } from './declaration.js';
import { type ContributedNameKey, type PluginCapability, type PluginManifest } from './manifest.js';
import { PluginError } from './plugin-errors.js';
import { type Disposer } from './service.js';

/** Throws when a contributed name is not declared in the contributor's manifest. */
export type ContributionCheck = (name: string) => void;

/**
 * Ties an extension point to the manifest: contributors must declare
 * `capability`, and a contributor that declares `contributes` may only add the
 * names it lists under `key`.
 */
export interface GovernedContribution<T> {
  /** The capability a contributor must declare. */
  readonly capability: PluginCapability;
  /** The `contributes` key that lists the names added through this point. */
  readonly key: ContributedNameKey;
  /**
   * Wraps the owner's API so every name a contributor adds passes `check`
   * before it reaches the owner. `pluginId` is the contributor, for points
   * whose names must belong to it.
   */
  readonly guard: (api: T, check: ContributionCheck, pluginId: string) => T;
}

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
  /** Present when contributions are checked against the contributor's manifest. */
  readonly governed?: GovernedContribution<T> | undefined;
  /** Phantom carrier of the contributor API type; never set at runtime. */
  readonly __api?: T;
}

/** Defines an extension point. `singleSlot` rejects a second contribution. */
export function defineExtensionPoint<T>(spec: {
  id: string;
  singleSlot?: boolean;
  governed?: GovernedContribution<T>;
}): ExtensionPoint<T> {
  return Object.freeze({
    id: spec.id,
    singleSlot: spec.singleSlot ?? false,
    ...(spec.governed === undefined ? {} : { governed: spec.governed }),
  }) as ExtensionPoint<T>;
}

/**
 * Runs every contribution to a point against an owner-supplied `api` and
 * returns it. A service owner calls this (via {@link ServiceInitContext.collect})
 * from its factory, which runs after the kernel is sealed, so every plugin's
 * contribution is present regardless of registration order.
 */
export type ExtensionCollector = <T>(point: ExtensionPoint<T>, api: T) => T;

type Contributor<T> = (api: T) => void;

/** The parts of a plugin's manifest an extension point checks contributions against. */
export type PluginDeclaration = Pick<PluginManifest, 'capabilities' | 'contributes'>;

interface ContributionEntry {
  readonly fn: Contributor<unknown>;
  readonly pluginId: string;
  readonly declaration: PluginDeclaration | undefined;
}

/** Collects contributions per extension point and replays them against an owner API. */
export class ExtensionRegistry {
  readonly #contributions = new Map<string, ContributionEntry[]>();
  readonly #singleSlot = new Map<string, boolean>();
  readonly #collected = new Map<string, Map<ContributedNameKey, Set<string>>>();

  /**
   * Records a contribution to `point`. Returns a disposer that removes it.
   *
   * When the plugin's `declaration` is given and `point` is governed, the
   * plugin must have declared the point's capability, and (once collected) a
   * declared `contributes` list limits the names it may add.
   */
  contribute<T>(
    point: ExtensionPoint<T>,
    fn: Contributor<T>,
    pluginId: string,
    declaration?: PluginDeclaration,
  ): Disposer {
    const governed = point.governed;
    if (
      governed !== undefined &&
      declaration !== undefined &&
      !declaration.capabilities.includes(governed.capability)
    ) {
      throw new PluginError(
        'plugin-capability-not-declared',
        `Plugin "${pluginId}" contributes to "${point.id}" but did not declare the "${governed.capability}" capability`,
      );
    }
    this.#singleSlot.set(point.id, point.singleSlot);
    const entry: ContributionEntry = { fn: fn as Contributor<unknown>, pluginId, declaration };
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
   * contribution, or when a contributor adds a name its manifest does not list.
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
      (entry.fn as Contributor<T>)(this.#guarded(point, api, entry));
    }
    return api;
  }

  /**
   * The API a contributor receives. A governed point always wraps it: names are
   * checked against the manifest's `contributes` when one was declared, and
   * recorded either way so the host can list what each plugin added.
   */
  #guarded<T>(point: ExtensionPoint<T>, api: T, entry: ContributionEntry): T {
    const governed = point.governed;
    if (governed === undefined) {
      return api;
    }
    const contributes = entry.declaration?.contributes;
    return governed.guard(
      api,
      (name) => {
        assertNameDeclared(entry.pluginId, contributes, governed.key, name);
        this.#record(entry.pluginId, governed.key, name);
      },
      entry.pluginId,
    );
  }

  #record(pluginId: string, key: ContributedNameKey, name: string): void {
    let byKind = this.#collected.get(pluginId);
    if (byKind === undefined) {
      byKind = new Map();
      this.#collected.set(pluginId, byKind);
    }
    let names = byKind.get(key);
    if (names === undefined) {
      names = new Set();
      byKind.set(key, names);
    }
    names.add(name);
  }

  /**
   * The names a plugin has added through governed extension points, as owners
   * collected them. Nothing is listed until an owner has run `collect`.
   */
  collected(pluginId: string): Readonly<Record<ContributedNameKey, readonly string[]>> {
    const byKind = this.#collected.get(pluginId);
    return {
      tools: [...(byKind?.get('tools') ?? [])],
      providers: [...(byKind?.get('providers') ?? [])],
      promptSections: [...(byKind?.get('promptSections') ?? [])],
      events: [...(byKind?.get('events') ?? [])],
      commands: [...(byKind?.get('commands') ?? [])],
    };
  }

  /** Number of contributions recorded for a point (test/introspection aid). */
  count<T>(point: ExtensionPoint<T>): number {
    return this.#contributions.get(point.id)?.length ?? 0;
  }
}
