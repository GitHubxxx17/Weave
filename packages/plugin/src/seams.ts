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
import { cloneDeclarativePanel, type PanelsExtensionApi } from './panels.js';
import { PluginError } from './plugin-errors.js';
import type { PluginEventDefinition, PluginEventReader } from './plugin-events.js';
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
export const pluginEventsRef: ServiceRef<PluginEventReader> = defineServiceRef({
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
  addTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void | false;
}

/** Tools are contributed here; the Tool Registry owner collects them. */
export const toolsExtensionPoint: ExtensionPoint<ToolsExtensionApi> = defineExtensionPoint({
  id: 'weave.tools',
  governed: {
    capability: 'tool',
    key: 'tools',
    guard: (api, check) => ({
      addTool(tool) {
        const { name, description, parameters, inputSchema, readOnly, approval, execute, ...rest } =
          tool;
        const captured = Object.freeze({
          ...rest,
          name,
          description,
          parameters,
          inputSchema,
          readOnly,
          approval,
          execute,
        });
        return check(name, () => api.addTool(captured));
      },
    }),
  },
});

/** Contributor API for the `weave.llm.providers` extension point. */
export interface LlmProvidersExtensionApi {
  addProvider(registration: LlmProviderRegistration): void | false;
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
          const {
            id,
            label,
            type,
            client,
            defaultModel,
            contextWindowTokens,
            temperature,
            maxTokens,
            ...rest
          } = registration;
          if (typeof id !== 'string' || id.trim() === '' || id !== id.trim()) {
            throw new PluginError(
              'plugin-invalid-definition',
              'Provider IDs must be nonblank and have no surrounding whitespace',
            );
          }
          const captured = Object.freeze({
            ...rest,
            id,
            label,
            type,
            client,
            ...(defaultModel === undefined ? {} : { defaultModel }),
            ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
            ...(temperature === undefined ? {} : { temperature }),
            ...(maxTokens === undefined ? {} : { maxTokens }),
          });
          return check(id, () => api.addProvider(captured));
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
  addSection(section: PromptSection): void | false;
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
          const { id, order, text } = section;
          // A copy that names its contributor: the owner can tell whose text it
          // applies, and a later change to the contributor's own object cannot
          // change what the owner holds.
          return check(id, () => api.addSection(Object.freeze({ id, order, text, pluginId })));
        },
      }),
    },
  });

/** Contributor API for the `weave.session.events` extension point. */
export interface SessionEventsExtensionApi {
  addEvent(definition: PluginEventDefinition): void | false;
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
          const { type, schema, project } = definition;
          if (!type.startsWith(`${pluginId}/`)) {
            throw new PluginError(
              'plugin-event-invalid',
              `Plugin "${pluginId}" cannot define event "${type}": its events must start with "${pluginId}/"`,
              { pluginId },
            );
          }
          const captured = Object.freeze({
            type,
            schema,
            ...(project === undefined
              ? {}
              : { project: Object.freeze({ initial: project.initial, apply: project.apply }) }),
          });
          return check(type, () => api.addEvent(captured));
        },
      }),
    },
  },
);

/** Contributor API for the `weave.commands` extension point. */
export interface CommandsExtensionApi {
  addCommand(command: PluginCommand): void | false;
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
        return check(parsed.data.name, () => api.addCommand(Object.freeze(parsed.data)));
      },
    }),
  },
});

/** Detached host-rendered right panels, with host-assigned contributor identity. */
export const panelsExtensionPoint: ExtensionPoint<PanelsExtensionApi> = defineExtensionPoint({
  id: 'weave.studio.panels',
  governed: {
    capability: 'panel',
    key: 'panels',
    guard: (api, check, pluginId) => ({
      addPanel(definition) {
        let panel;
        try {
          panel = cloneDeclarativePanel(definition);
        } catch (cause: unknown) {
          throw new PluginError(
            'plugin-invalid-definition',
            `Plugin "${pluginId}" contributed an invalid panel`,
            { cause, pluginId },
          );
        }
        return check(panel.id, () => api.addPanel(Object.freeze({ ...panel, pluginId })));
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
        return check(parsed.data.name, () =>
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
          ),
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
