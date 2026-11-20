import { z } from 'zod';
import { pluginApiVersion } from './constants.js';
import { defineExtensionPoint } from './extension-point.js';
import { defineHook } from './hook.js';
import type { PluginEnv } from './plugin-env.js';
import {
  approvalBrokerRef,
  commandsExtensionPoint,
  llmProvidersExtensionPoint,
  llmRequestHook,
  pluginEventsRef,
  promptSectionsExtensionPoint,
  sessionStoreRef,
  toolAroundHook,
  toolPolicyHook,
  toolResultHook,
  toolsExtensionPoint,
  turnEndHook,
  turnStartHook,
} from './seams.js';
import { defineServiceRef } from './service.js';

/**
 * What a plugin the host loads from disk is written against.
 *
 * Such a plugin lives outside the repository, so Node cannot resolve
 * `@weave/plugin` from its directory. The host passes it an SDK instead: the
 * vocabulary the plugin needs to say what it contributes, and nothing that
 * assembles or runs a kernel. Everything in it is the host's own copy, so
 * there is one set of service references, extension points and hooks, and one
 * `zod`.
 */

/** What a plugin's entry module returns: the same two functions a kernel plugin has. */
export interface PluginModule {
  setup(env: PluginEnv): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** The default export of a plugin's entry module. */
export type PluginFactory = (sdk: PluginSdk) => PluginModule | Promise<PluginModule>;

/**
 * The host APIs a loaded plugin can use. Service references, extension points
 * and hooks that only the host assembles stay out: the tool registry, the tool
 * pipeline, the agent runner, the provider registry and the events extension
 * point (plugins use `env.defineEvent` for events).
 */
export interface PluginSdk {
  /** The plugin API version this host speaks. A manifest's `apiVersion` must equal it. */
  readonly apiVersion: string;
  /** The `zod` the host validates with; use it for event schemas and tool inputs. */
  readonly z: typeof z;

  // Authoring helpers, for a plugin's own services, extension points and hooks.
  readonly defineServiceRef: typeof defineServiceRef;
  readonly defineExtensionPoint: typeof defineExtensionPoint;
  readonly defineHook: typeof defineHook;

  // Service references. The approval broker is a view that cannot decide, and
  // the session store accepts only events a plugin registered.
  readonly approvalBrokerRef: typeof approvalBrokerRef;
  readonly pluginEventsRef: typeof pluginEventsRef;
  readonly sessionStoreRef: typeof sessionStoreRef;

  // Extension points.
  readonly commandsExtensionPoint: typeof commandsExtensionPoint;
  readonly llmProvidersExtensionPoint: typeof llmProvidersExtensionPoint;
  readonly promptSectionsExtensionPoint: typeof promptSectionsExtensionPoint;
  readonly toolsExtensionPoint: typeof toolsExtensionPoint;

  // Hooks.
  readonly llmRequestHook: typeof llmRequestHook;
  readonly toolAroundHook: typeof toolAroundHook;
  readonly toolPolicyHook: typeof toolPolicyHook;
  readonly toolResultHook: typeof toolResultHook;
  readonly turnStartHook: typeof turnStartHook;
  readonly turnEndHook: typeof turnEndHook;
}

/** Creates the frozen {@link PluginSdk} the host passes to a plugin's factory. */
export function createPluginSdk(): PluginSdk {
  return Object.freeze({
    apiVersion: pluginApiVersion,
    z,
    defineServiceRef,
    defineExtensionPoint,
    defineHook,
    approvalBrokerRef,
    pluginEventsRef,
    sessionStoreRef,
    commandsExtensionPoint,
    llmProvidersExtensionPoint,
    promptSectionsExtensionPoint,
    toolsExtensionPoint,
    llmRequestHook,
    toolAroundHook,
    toolPolicyHook,
    toolResultHook,
    turnStartHook,
    turnEndHook,
  });
}
