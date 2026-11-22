import type { LlmProviderRegistration, LlmProviderRegistry, StreamEvent } from '@weave/llm';
import type {
  AgentRunner,
  LlmCall,
  SessionEventStore,
  ToolDefinition,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolPipeline,
  ToolRegistry,
} from '@weave/runtime';

import type { PluginApprovalBroker } from './approval-view.js';
import { pluginCommandSchema, type PluginCommand } from './commands.js';
import { defineExtensionPoint, type ExtensionPoint } from './extension-point.js';
import { defineHook, type Hook, type PolicyVote } from './hook.js';
import { PluginError } from './plugin-errors.js';
import type { PluginEventDefinition, PluginEventRegistry } from './plugin-events.js';
import { defineServiceRef, type ServiceRef } from './service.js';
import { skillContributionSchema, type SkillsExtensionApi } from './skills.js';

/**
 * The concrete seams that Weave's own subsystems are exposed through, typed
 * against the real library contracts. Builtin plugins (Stage 2) provide these
 * services and contribute into these extension points; the host resolves the
 * agent runner and tool pipeline from a sealed generation instead of the
 * hand-assembled `WeakMap` wiring in `apps/server/src/runtime.ts`.
 *
 * This module only declares the vocabulary. It pulls in no library
 * implementation — just their types — so `@weave/plugin` stays a kernel, not a
 * product.
 */

// --- Service seams (root-scoped singletons for the first slice) ---

/**
 * The approval broker a plugin sees: it can raise and observe requests, but not
 * decide them. The Tool Pipeline consults it for protected tools. The host
 * keeps the full broker for its own approval API.
 */
export const approvalBrokerRef: ServiceRef<PluginApprovalBroker> = defineServiceRef({
  id: 'weave.approval.broker',
});

/** The LLM provider registry the router and agent loop read from. */
export const llmProviderRegistryRef: ServiceRef<LlmProviderRegistry> = defineServiceRef({
  id: 'weave.llm.registry',
});

/** The durable Session event store. */
export const sessionStoreRef: ServiceRef<SessionEventStore> = defineServiceRef({
  id: 'weave.session.store',
});

/** The Tool Registry that holds every contributed tool definition. */
export const toolRegistryRef: ServiceRef<ToolRegistry> = defineServiceRef({
  id: 'weave.tools.registry',
});

/** The plugin events the host accepts; plugin projections read through it. */
export const pluginEventsRef: ServiceRef<PluginEventRegistry> = defineServiceRef({
  id: 'weave.session.plugin-events',
});

/** The shared Tool Pipeline — the only path a tool's `execute` runs through. */
export const toolPipelineRef: ServiceRef<ToolPipeline> = defineServiceRef({
  id: 'weave.tools.pipeline',
});

/** The agent loop; replaceable, but it must call the pipeline above. */
export const agentRunnerRef: ServiceRef<AgentRunner> = defineServiceRef({
  id: 'weave.agent.runner',
});

// --- Extension points ---

/** Contributor API for the `weave.tools` extension point. */
export interface ToolsExtensionApi {
  addTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void;
}

/** Tools are contributed here; the Tool Registry owner collects them. */
export const toolsExtensionPoint: ExtensionPoint<ToolsExtensionApi> = defineExtensionPoint({
  id: 'weave.tools',
  governed: {
    capability: 'tool',
    key: 'tools',
    guard: (api, check) => ({
      addTool(tool) {
        check(tool.name);
        api.addTool(tool);
      },
    }),
  },
});

/** Contributor API for the `weave.llm.providers` extension point. */
export interface LlmProvidersExtensionApi {
  addProvider(registration: LlmProviderRegistration): void;
}

/** LLM providers are contributed here; the provider registry owner collects them. */
export const llmProvidersExtensionPoint: ExtensionPoint<LlmProvidersExtensionApi> =
  defineExtensionPoint({
    id: 'weave.llm.providers',
    governed: {
      capability: 'llm-provider',
      key: 'providers',
      guard: (api, check) => ({
        addProvider(registration) {
          check(registration.id);
          api.addProvider(registration);
        },
      }),
    },
  });

/** One addressable piece of the system prompt. Lower `order` renders earlier. */
export interface PromptSection {
  readonly id: string;
  readonly order: number;
  readonly text: string;
  /**
   * The plugin that contributed the section. The kernel sets it on every
   * section it passes to the owner and replaces whatever a contributor wrote,
   * so an owner can attribute the text it applies.
   */
  readonly pluginId?: string | undefined;
}

/** Contributor API for the `weave.prompt.sections` extension point. */
export interface PromptSectionsExtensionApi {
  addSection(section: PromptSection): void;
}

/** System-prompt sections are contributed here; `prompt-core` owns assembly. */
export const promptSectionsExtensionPoint: ExtensionPoint<PromptSectionsExtensionApi> =
  defineExtensionPoint({
    id: 'weave.prompt.sections',
    governed: {
      capability: 'prompt',
      key: 'promptSections',
      guard: (api, check, pluginId) => ({
        addSection(section) {
          check(section.id);
          // A copy that names its contributor: the owner can tell whose text it
          // applies, and a later change to the contributor's own object cannot
          // change what the owner holds.
          api.addSection(Object.freeze({ ...section, pluginId }));
        },
      }),
    },
  });

/** Contributor API for the `weave.session.events` extension point. */
export interface SessionEventsExtensionApi {
  addEvent(definition: PluginEventDefinition): void;
}

/**
 * Plugin event types are contributed here; the plugin event registry owner
 * collects them. A plugin may define only events under its own id, so no
 * plugin writes into another's namespace.
 */
export const eventsExtensionPoint: ExtensionPoint<SessionEventsExtensionApi> = defineExtensionPoint(
  {
    id: 'weave.session.events',
    governed: {
      capability: 'event',
      key: 'events',
      guard: (api, check, pluginId) => ({
        addEvent(definition) {
          if (!definition.type.startsWith(`${pluginId}/`)) {
            throw new PluginError(
              'plugin-event-invalid',
              `Plugin "${pluginId}" cannot define event "${definition.type}": its events must start with "${pluginId}/"`,
              { pluginId },
            );
          }
          check(definition.type);
          api.addEvent(definition);
        },
      }),
    },
  },
);

/** Contributor API for the `weave.commands` extension point. */
export interface CommandsExtensionApi {
  addCommand(command: PluginCommand): void;
}

/**
 * Slash commands are contributed here. They are declarative prompt templates,
 * so the host collects them directly and serves them to Studio. A command is
 * checked against {@link pluginCommandSchema} before the owner sees it, and the
 * owner receives the checked copy.
 */
export const commandsExtensionPoint: ExtensionPoint<CommandsExtensionApi> = defineExtensionPoint({
  id: 'weave.commands',
  governed: {
    capability: 'command',
    key: 'commands',
    guard: (api, check, pluginId) => ({
      addCommand(command) {
        const parsed = pluginCommandSchema.safeParse(command);
        if (!parsed.success) {
          throw new PluginError(
            'plugin-invalid-definition',
            `Plugin "${pluginId}" contributed an invalid command: ${parsed.error.issues
              .map((issue) => `${issue.path.join('.') || '(command)'}: ${issue.message}`)
              .join('; ')}`,
            { cause: parsed.error, pluginId },
          );
        }
        check(parsed.data.name);
        api.addCommand(Object.freeze(parsed.data));
      },
    }),
  },
});

// --- Hooks ---

/** Declarative per-turn instructions, with host-assigned contributor identity. */
export const skillsExtensionPoint: ExtensionPoint<SkillsExtensionApi> = defineExtensionPoint({
  id: 'weave.skills',
  governed: {
    capability: 'skill',
    key: 'skills',
    guard: (api, check, pluginId) => ({
      addSkill(skill) {
        const parsed = skillContributionSchema.safeParse(skill);
        if (!parsed.success) {
          throw new PluginError(
            'plugin-invalid-definition',
            `Plugin "${pluginId}" contributed an invalid Skill`,
            { cause: parsed.error, pluginId },
          );
        }
        check(parsed.data.name);
        api.addSkill(
          Object.freeze({
            ...parsed.data,
            pluginId,
            ...(parsed.data.invocation === undefined
              ? {}
              : { invocation: Object.freeze(parsed.data.invocation) }),
            ...(parsed.data.resources === undefined
              ? {}
              : { resources: Object.freeze(parsed.data.resources) }),
          }),
        );
      },
    }),
  },
});

/** Security vote before a tool runs; votes merge strictly tighter. */
export const toolPolicyHook: Hook<ToolExecutionRequest, PolicyVote> = defineHook({
  id: 'weave.tools.policy',
  mode: 'decide',
});

/** Middleware around a single tool execution (retry, timing, result shaping). */
export const toolAroundHook: Hook<ToolExecutionRequest, ToolExecutionResult> = defineHook({
  id: 'weave.tools.around',
  mode: 'wrap',
});

/** Read-only observation of a completed tool execution. */
export const toolResultHook: Hook<ToolExecutionResult> = defineHook({
  id: 'weave.tools.result',
  mode: 'observe',
});

/**
 * Middleware around the model stream of one step (retry, timeout, redaction of
 * what is sent). It wraps the whole stream, never each chunk. The runner keeps
 * the provider and model of the request fixed and checks every event it yields.
 */
export const llmRequestHook: Hook<LlmCall, AsyncIterable<StreamEvent>> = defineHook({
  id: 'weave.llm.request',
  mode: 'wrap',
});

/** Identifies a turn to lifecycle observers. */
export interface TurnInfo {
  readonly sessionId: string;
  readonly turnId: string;
}

/** A turn that has ended, and how. */
export interface TurnEndInfo extends TurnInfo {
  readonly status: 'completed' | 'failed' | 'cancelled';
  /** Why a turn that did not simply finish ended, such as `agent-step-limit`. */
  readonly reason?: string | undefined;
}

/** Observed when a turn starts, after its start is durably recorded. */
export const turnStartHook: Hook<TurnInfo> = defineHook({
  id: 'weave.turn.start',
  mode: 'observe',
});

/** Observed when a turn ends, after its end is durably recorded. */
export const turnEndHook: Hook<TurnEndInfo> = defineHook({
  id: 'weave.turn.end',
  mode: 'observe',
});
