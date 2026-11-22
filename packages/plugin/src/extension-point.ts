import { assertNameDeclared } from './declaration.js';
import { type ContributedNameKey, type PluginCapability, type PluginManifest } from './manifest.js';
import { attributePluginError, PluginError } from './plugin-errors.js';
import { type Disposer } from './service.js';

/** Declaration validation, optionally coupled to synchronous owner acceptance. */
export interface ContributionCheck {
  /** Legacy validation only; this does not establish a successful contribution. */
  (name: string): void;
  /** Record only after the owner returns undefined; false explicitly skips it. */
  (name: string, accept: () => void | false): void | false;
}

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
    ...(spec.governed === undefined
      ? {}
      : {
          governed: Object.freeze({
            capability: spec.governed.capability,
            key: spec.governed.key,
            guard: spec.governed.guard,
          }),
        }),
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

/** Observe accidental async work without blocking synchronous collection. */
function observeThenable(value: unknown): boolean {
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  ) {
    void Promise.resolve(value).catch(() => undefined);
    return true;
  }
  return false;
}

function assertCapability<T>(point: ExtensionPoint<T>, entry: ContributionEntry): void {
  const governed = point.governed;
  if (
    governed !== undefined &&
    entry.declaration !== undefined &&
    !entry.declaration.capabilities.includes(governed.capability)
  )
    throw new PluginError(
      'plugin-capability-not-declared',
      `Plugin "${entry.pluginId}" contributes to "${point.id}" but did not declare the "${governed.capability}" capability`,
      { pluginId: entry.pluginId },
    );
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
    const entry: ContributionEntry = { fn: fn as Contributor<unknown>, pluginId, declaration };
    assertCapability(point, entry);
    this.#singleSlot.set(point.id, point.singleSlot);
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
   * Whatever a contribution throws, including a failure inside the owner's own
   * API such as a name that is already taken, leaves as a {@link PluginError}
   * that names the contributing plugin, so a host can drop that one plugin.
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
    const skillNames = new Set<string>();
    const pendingSkills = new Set<string>();
    for (const entry of list) {
      let active = true;
      try {
        // The collector's point is canonical; a same-id author reference cannot
        // change its capability or declaration policy.
        assertCapability(point, entry);
        const result: unknown = (entry.fn as Contributor<T>)(
          this.#guarded(point, api, entry, skillNames, pendingSkills, () => active),
        );
        active = false;
        if (observeThenable(result))
          throw new PluginError(
            'plugin-invalid-definition',
            'Extension contributors must finish synchronously',
            { pluginId: entry.pluginId },
          );
      } catch (error: unknown) {
        active = false;
        const attributed = attributePluginError(
          error,
          entry.pluginId,
          `Plugin "${entry.pluginId}" failed while contributing to "${point.id}"`,
        );
        // This boundary is executing this contributor, not resolving a provider;
        // an exception cannot choose another plugin as the contribution owner.
        if (attributed.pluginId !== entry.pluginId)
          throw new PluginError(attributed.code, attributed.message, {
            cause: error,
            pluginId: entry.pluginId,
          });
        throw attributed;
      } finally {
        active = false;
      }
    }
    return api;
  }

  /**
   * The API a contributor receives. A governed point always wraps it: names are
   * checked against the manifest's `contributes` when one was declared, and
   * recorded either way so the host can list what each plugin added.
   */
  #guarded<T>(
    point: ExtensionPoint<T>,
    api: T,
    entry: ContributionEntry,
    skillNames: Set<string>,
    pendingSkills: Set<string>,
    active: () => boolean,
  ): T {
    const governed = point.governed;
    if (governed === undefined) {
      return api;
    }
    const contributes = entry.declaration?.contributes;
    return governed.guard(
      api,
      (name: string, accept?: () => void | false) => {
        if (!active())
          throw new PluginError(
            'plugin-invalid-definition',
            'The contribution API is closed after its callback returns',
            { pluginId: entry.pluginId },
          );
        assertNameDeclared(entry.pluginId, contributes, governed.key, name);
        const identity = `${entry.pluginId}/${name}`;
        if (governed.key === 'skills') {
          if (skillNames.has(identity) || pendingSkills.has(identity))
            throw new PluginError(
              'plugin-invalid-definition',
              `Plugin "${entry.pluginId}" contributed Skill "${name}" twice`,
              { pluginId: entry.pluginId },
            );
        }
        if (accept === undefined) return;
        if (governed.key === 'skills') pendingSkills.add(identity);
        let result: unknown;
        try {
          result = accept();
          if (observeThenable(result) || (result !== undefined && result !== false))
            throw new PluginError(
              'plugin-invalid-definition',
              'Contribution owners must synchronously return undefined or false',
              { pluginId: entry.pluginId },
            );
        } finally {
          if (governed.key === 'skills') pendingSkills.delete(identity);
        }
        if (result === false) return false;
        if (governed.key === 'skills') skillNames.add(identity);
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
      skills: [...(byKind?.get('skills') ?? [])],
    };
  }

  /** Number of contributions recorded for a point (test/introspection aid). */
  count<T>(point: ExtensionPoint<T>): number {
    return this.#contributions.get(point.id)?.length ?? 0;
  }
}
