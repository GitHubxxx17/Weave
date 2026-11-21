import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { connectMcp, McpClientError, type McpConnection } from '@weave/mcp-client';
import { createMcpPlugin } from '@weave/plugin-builtins';
import {
  McpAuthorityError,
  validateMcpAuthorityLog,
  type McpAuthorityCommand,
  type McpAuthorityLog,
  type McpAuthorityRecord,
  type McpAuthorityStore,
} from './mcp-authority-store.js';
import {
  normalizeMcpServerConfig,
  recheckMcpLaunchPaths,
  resolveMcpEnvironment,
  type McpServerConfig,
} from './mcp-environment.js';
import type { ExtensionCoordinator } from './extension-coordinator.js';
import { ExtensionPreparationError } from './extension-types.js';
import type {
  ExtensionAuthorityObserver,
  ExtensionIdentity,
  ExtensionSourceFactory,
  ExtensionSourceSnapshot,
  PreparedExtensionItem,
  PreparedExtensionSource,
} from './extension-types.js';
import type {
  McpManagementSnapshot,
  McpMutationResult,
  McpServerRecord,
  ServerMcpManager,
} from './mcp-management-types.js';

const sourceId = 'mcp';
const capacity = 32;
const emptyLog: McpAuthorityLog = { sequence: 0, events: [], records: [] };
const unavailable = {
  code: 'mcp-connect-failed',
  message: 'The MCP service could not be initialized.',
};
const cleanupIssue = {
  code: 'mcp-close-failed',
  message: 'MCP connection cleanup did not complete.',
};
type Issue = { readonly code: string; readonly message: string };
interface Allocation {
  readonly instanceId: string;
  readonly record: McpAuthorityRecord;
  readonly release: () => void;
  redactValues: readonly string[];
  readonly abort: AbortController;
  readonly detachPreparationSignal: () => void;
  connection?: McpConnection;
  stale: boolean;
  closed: boolean;
  closing: boolean;
  issue?: Issue;
  disposal?: Promise<void>;
}

export interface McpExtensionSourceOptions {
  readonly store: McpAuthorityStore;
  readonly readHostVariable?: (name: string) => string | undefined;
  readonly connect?: typeof connectMcp;
  readonly reservedPluginIds?: () => Promise<readonly string[]>;
  /** Applies the validated log exactly once inside the paired authority update. */
  readonly installAuthoritySync?: (applyValidatedLog: () => void) => void;
  readonly assertCreateAllowedSync?: (pluginId: string) => void;
}

function pluginId(id: string): string {
  return `mcp-${id}`;
}

function identity(record: McpAuthorityRecord): string {
  return JSON.stringify([record.config.id, record.configDigest]);
}
function mappedName(id: string, name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 10) || 'tool';
  return `mcp_${id}_${slug}_${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 16)}`;
}
function redactText(text: string, values: readonly string[]): string {
  const secrets = [...new Set(values.filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (secrets.length === 0) return text;
  let cursor = 0;
  const parts: string[] = [];
  while (cursor < text.length) {
    let next = -1;
    let selected = '';
    for (const secret of secrets) {
      const position = text.indexOf(secret, cursor);
      if (position >= 0 && (next < 0 || position < next)) {
        next = position;
        selected = secret;
      }
    }
    if (next < 0) break;
    parts.push(text.slice(cursor, next), '[REDACTED]');
    cursor = next + selected.length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}
function redactJson(
  value: Readonly<Record<string, unknown>>,
  values: readonly string[],
): Readonly<Record<string, unknown>> {
  function copyJson(child: unknown): unknown {
    if (typeof child === 'string') return redactText(child, values);
    if (Array.isArray(child)) return Object.freeze(child.map(copyJson));
    if (child === null || typeof child !== 'object') return child;
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(child)) {
      // Annotation text is a display projection. Redacted-key collisions use
      // the last source value; exact tool identities and schemas are separate.
      Object.defineProperty(copy, redactText(key, values), {
        value: copyJson(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return Object.freeze(copy);
  }
  return copyJson(value) as Readonly<Record<string, unknown>>;
}

function safeIssue(error: unknown): Issue {
  if (error instanceof McpClientError)
    return { code: error.code, message: new McpClientError(error.code).message };
  return unavailable;
}
function conflict(): McpAuthorityError {
  return new McpAuthorityError('mcp-conflict');
}
function invalid(): McpAuthorityError {
  return new McpAuthorityError('mcp-invalid');
}

/** Server-owned launch authority and exact generation-owned connection resources. */
export function createMcpExtensionSource(options: McpExtensionSourceOptions): {
  register: ExtensionSourceFactory;
  facade(coordinator: ExtensionCoordinator): ServerMcpManager;
  declaredPluginIds(): readonly string[];
  setDeniedPluginIdsSync(ids: ReadonlySet<string>): void;
  refresh(): Promise<void>;
  close(): Promise<void>;
} {
  let log = emptyLog;
  let revision = 0;
  let deniedIds: ReadonlySet<string> = new Set();
  let observer: ExtensionAuthorityObserver | undefined;
  let registered = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  let nextInstance = 0;
  let allocations = 0;
  const ledger = new Map<string, Allocation>();
  const failed = new Map<string, Issue>();
  const cleanupErrors: Issue[] = [];
  const connect = options.connect ?? connectMcp;

  function ensureOpen(): void {
    if (closed) throw new McpAuthorityError('mcp-closed');
  }
  function eligible(record: McpAuthorityRecord): boolean {
    return (
      !record.removed &&
      record.enabled &&
      record.trustedDigest === record.configDigest &&
      !deniedIds.has(pluginId(record.config.id))
    );
  }
  function eligibleIdentities(): ExtensionIdentity[] {
    return log.records
      .filter(eligible)
      .map((record) => ({ pluginId: pluginId(record.config.id), identity: identity(record) }));
  }
  function snapshot(): ExtensionSourceSnapshot {
    return {
      stamp: { revision, trustSequence: log.sequence },
      eligible: eligibleIdentities(),
    };
  }
  function observeChange(
    before: readonly ExtensionIdentity[],
    current: ExtensionSourceSnapshot,
    immediate = false,
    affectedId?: string,
  ): void {
    const affectedIds = new Set<string>(affectedId === undefined ? [] : [pluginId(affectedId)]);
    for (const previous of before) {
      if (!current.eligible.some((item) => item.identity === previous.identity)) {
        affectedIds.add(previous.pluginId);
      }
    }
    observer?.(sourceId, { snapshot: current, affectedIds: [...affectedIds], immediate });
  }
  function declaredPluginIds(): readonly string[] {
    return log.records
      .filter((record) => !record.removed)
      .map((record) => pluginId(record.config.id));
  }
  function setDeniedPluginIdsSync(ids: ReadonlySet<string>): void {
    const before = eligibleIdentities();
    deniedIds = new Set(ids);
    const current = eligibleIdentities();
    if (!isDeepStrictEqual(before, current)) {
      revision++;
      observeChange(before, {
        stamp: { revision, trustSequence: log.sequence },
        eligible: current,
      });
    }
  }
  function install(input: unknown, immediate = false, affectedId?: string): boolean {
    const next = validateMcpAuthorityLog(input, log.events);
    let changed = false;
    function applyValidatedLog(): void {
      if (isDeepStrictEqual(log, next)) return;
      const before = eligibleIdentities();
      if (!isDeepStrictEqual(log.records, next.records)) revision++;
      log = next;
      changed = true;
      observeChange(before, snapshot(), immediate, affectedId);
    }
    if (options.installAuthoritySync === undefined) applyValidatedLog();
    else options.installAuthoritySync(applyValidatedLog);
    return changed;
  }
  async function refresh(): Promise<void> {
    ensureOpen();
    const next = await options.store.read({ knownPrefix: log.events });
    ensureOpen();
    install(next);
  }
  function reserve(count: number): Array<() => void> {
    if (allocations + count > capacity) throw new ExtensionPreparationError();
    allocations += count;
    return Array.from({ length: count }, () => {
      let released = false;
      return () => {
        if (!released) {
          released = true;
          allocations--;
        }
      };
    });
  }
  function disposeAllocation(allocation: Allocation): Promise<void> {
    allocation.disposal ??= (async () => {
      allocation.closing = true;
      allocation.detachPreparationSignal();
      allocation.abort.abort(new McpClientError('mcp-cancelled'));
      try {
        await allocation.connection?.close();
        allocation.release();
        ledger.delete(allocation.instanceId);
      } catch {
        allocation.issue = cleanupIssue;
        cleanupErrors.push(cleanupIssue);
        throw new Error(cleanupIssue.message);
      }
    })();
    return allocation.disposal;
  }
  async function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    for (const entry of ledger.values()) entry.abort.abort(new McpClientError('mcp-cancelled'));
    closePromise = (async () => {
      await Promise.allSettled([...ledger.values()].map(disposeAllocation));
      if (cleanupErrors.length) throw new Error(cleanupIssue.message);
    })();
    return closePromise;
  }

  const register: ExtensionSourceFactory = (observe) => {
    if (registered) throw new Error('MCP source is already registered');
    registered = true;
    observer = observe;
    return {
      id: sourceId,
      snapshot,
      refresh,
      close,
      async prepare(stamp, { signal, excluded }): Promise<PreparedExtensionSource> {
        ensureOpen();
        const desired = log.records.filter(
          (record) => eligible(record) && !excluded.has(identity(record)),
        );
        const releases = reserve(desired.length);
        const items: PreparedExtensionItem[] = [];
        const failures: PreparedExtensionSource['failures'][number][] = [];
        const owned: Allocation[] = [];
        let disposal: Promise<void> | undefined;
        function dispose(): Promise<void> {
          disposal ??= (async () => {
            const outcomes = await Promise.allSettled(owned.map(disposeAllocation));
            if (outcomes.some((outcome) => outcome.status === 'rejected'))
              throw new Error(cleanupIssue.message);
          })();
          return disposal;
        }
        try {
          for (const [index, record] of desired.entries()) {
            const release = releases[index]!;
            const abort = new AbortController();
            const cancel = () => abort.abort(new McpClientError('mcp-cancelled'));
            const entry: Allocation = {
              instanceId: `mcp:${++nextInstance}`,
              record,
              release,
              redactValues: [],
              abort,
              detachPreparationSignal: () => signal.removeEventListener('abort', cancel),
              stale: false,
              closed: false,
              closing: false,
            };
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
            try {
              ensureOpen();
              if (abort.signal.aborted) throw new McpClientError('mcp-cancelled');
              await recheckMcpLaunchPaths(record.config);
              ensureOpen();
              const resolved = resolveMcpEnvironment(record.config, {
                ...(options.readHostVariable === undefined
                  ? {}
                  : { readHostVariable: options.readHostVariable }),
              });
              entry.redactValues = resolved.redactValues;
              ledger.set(entry.instanceId, entry);
              entry.connection = await connect({
                command: record.config.command,
                args: record.config.args,
                cwd: record.config.cwd,
                env: resolved.env,
                signal: abort.signal,
                onStale: () => {
                  if (!entry.closed) entry.stale = true;
                },
                onClosed: () => {
                  entry.closed = true;
                  if (!entry.closing)
                    entry.issue = { code: 'mcp-closed', message: 'The MCP connection is closed.' };
                },
              });
              owned.push(entry);
              ensureOpen();
              const plugin = createMcpPlugin({
                serverId: record.config.id,
                label: record.config.label,
                cwd: record.config.cwd,
                connection: entry.connection,
                redactValues: resolved.redactValues,
              });
              items.push({
                pluginId: plugin.manifest.id,
                identity: identity(record),
                instanceId: entry.instanceId,
                plugin,
                isReady: () => !entry.closed && !entry.closing,
                dispose: () => disposeAllocation(entry),
              });
              failed.delete(identity(record));
            } catch (error) {
              const issue = safeIssue(error);
              failed.set(identity(record), issue);
              if (entry.connection !== undefined) {
                if (!owned.includes(entry)) owned.push(entry);
                await disposeAllocation(entry).catch(() => undefined);
              } else if (
                !ledger.has(entry.instanceId) ||
                (error instanceof McpClientError && !error.cleanupFailed)
              ) {
                release();
                ledger.delete(entry.instanceId);
              } else {
                // Unknown factory failures cannot prove transport cleanup. Keep the slot.
                entry.closed = true;
                entry.issue = cleanupIssue;
                entry.closing = true;
                entry.disposal = Promise.reject(new Error(cleanupIssue.message));
                void entry.disposal.catch(() => undefined);
                cleanupErrors.push(cleanupIssue);
              }
              failures.push({
                pluginId: pluginId(record.config.id),
                identity: identity(record),
                kind: 'load',
                error: new McpClientError(issue.code as McpClientError['code']),
              });
            } finally {
              if (entry.connection === undefined) entry.detachPreparationSignal();
            }
          }
          return {
            stamp,
            items,
            failures,
            dispose,
            async recheck(recheckSignal) {
              if (recheckSignal.aborted) return false;
              await refresh();
              for (const entry of owned) {
                if (entry.closed || entry.closing) continue; // final sync readiness attributes EOF
                try {
                  await recheckMcpLaunchPaths(entry.record.config);
                } catch {
                  entry.closed = true;
                  entry.issue = unavailable;
                  failed.set(identity(entry.record), unavailable);
                }
              }
              return !recheckSignal.aborted;
            },
          };
        } catch (error) {
          for (const [index, release] of releases.entries()) {
            const reserved = desired[index]!;
            if (![...ledger.values()].some((entry) => entry.record === reserved)) release();
          }
          await dispose().catch(() => undefined);
          throw error;
        }
      },
    };
  };

  return {
    register,
    declaredPluginIds,
    setDeniedPluginIdsSync,
    refresh,
    close,
    facade(coordinator): ServerMcpManager {
      function project(): McpManagementSnapshot {
        const state = coordinator.snapshot();
        const generations = coordinator.retainedGenerations();
        const bindings = generations.flatMap((generation) =>
          generation.members.flatMap((member) => {
            if (member.sourceId !== sourceId || member.instanceId === undefined) return [];
            const allocation = ledger.get(member.instanceId);
            if (!allocation) return [];
            return [
              {
                allocation,
                generation: generation.generationId,
                current: generation.generationId === state.generation.id,
              },
            ];
          }),
        );
        const servers: McpServerRecord[] = log.records.flatMap((record) => {
          const own = bindings.filter(
            (binding) => binding.allocation.record.config.id === record.config.id,
          );
          const active = own.find((binding) => binding.current);
          const draining = own.filter((binding) => !binding.current);
          if (record.removed && own.length === 0) return [];
          const preparing = [...ledger.values()].some(
            (entry) =>
              entry.record.config.id === record.config.id &&
              entry.record.configDigest === record.configDigest &&
              !entry.closing &&
              !entry.closed &&
              !bindings.some((binding) => binding.allocation === entry),
          );
          const currentMatches = active?.allocation.record.configDigest === record.configDigest;
          const issue =
            currentMatches && active?.allocation.issue !== undefined
              ? active.allocation.issue
              : failed.get(identity(record));
          let status: McpServerRecord['state'];
          if (record.removed) status = 'removed';
          else if (record.trustState === 'changed') status = 'changed';
          else if (record.trustedDigest !== record.configDigest) status = 'untrusted';
          else if (!record.enabled) status = 'disabled';
          else if (preparing) status = 'connecting';
          else if (currentMatches && active && !active.allocation.closed) status = 'loaded';
          else status = 'failed';
          const displayConnection = active?.allocation.connection;
          return [
            {
              config: record.config,
              configDigest: record.configDigest,
              ...(record.trustedDigest === null ? {} : { trustedDigest: record.trustedDigest }),
              enabled: record.enabled,
              state: status,
              stale: active?.allocation.stale ?? false,
              ...(active === undefined
                ? {}
                : {
                    active: {
                      generation: active.generation,
                      configDigest: active.allocation.record.configDigest,
                    },
                  }),
              drainingGenerations: draining.map((binding) => ({
                generation: binding.generation,
                configDigest: binding.allocation.record.configDigest,
              })),
              tools: (displayConnection?.tools ?? []).map((tool) => ({
                ...tool,
                description: redactText(tool.description, active?.allocation.redactValues ?? []),
                ...(tool.annotations === undefined
                  ? {}
                  : {
                      annotations: redactJson(
                        tool.annotations,
                        active?.allocation.redactValues ?? [],
                      ),
                    }),
                toolName: mappedName(record.config.id, tool.name),
              })),
              ...(record.reviewed === null ? {} : { reviewedConfig: record.reviewed.config }),
              ...((status === 'failed' || status === 'connecting') && issue !== undefined
                ? { issue }
                : status === 'failed'
                  ? { issue: unavailable }
                  : {}),
            },
          ];
        });
        return { authoritySequence: log.sequence, generation: state.generation, servers };
      }
      function requireSequence(expected: number): void {
        if (!Number.isSafeInteger(expected) || expected < 0) throw invalid();
        if (expected !== log.sequence) throw conflict();
      }
      function recordOf(id: string): McpAuthorityRecord {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 24) throw invalid();
        const record = log.records.find((record) => record.config.id === id);
        if (!record || record.removed) throw new McpAuthorityError('mcp-not-found');
        return record;
      }
      async function mutation(
        expected: number,
        command: () => Promise<McpAuthorityCommand | undefined>,
        immediate = false,
        targetId?: string,
      ): Promise<McpMutationResult> {
        let decisionSequence = expected;
        const result = await coordinator.mutate(
          sourceId,
          async ({ assertOpenSync }) => {
            await refresh();
            requireSequence(expected);
            const requested = await command();
            let installed = false;
            if (requested !== undefined) {
              if (requested.kind === 'create') {
                options.assertCreateAllowedSync?.(pluginId(requested.config.id));
              }
              assertOpenSync();
              const next = await options.store.mutate(requested, {
                expectedSequence: expected,
                knownPrefix: log.events,
              });
              ensureOpen();
              installed = install(next, immediate, targetId);
            }
            decisionSequence = log.sequence;
            if (!installed && immediate && targetId !== undefined)
              coordinator.retryImmediateRevocation(sourceId, pluginId(targetId));
          },
          { force: true },
        );
        const view = project();
        const ownFailures = result.failed.map((failure) => ({
          id: failure.sourceId === sourceId ? failure.pluginId.slice(4) : failure.pluginId,
          error: {
            code: failure.error.code,
            message: 'An extension could not be loaded into the generation.',
          },
        }));
        return {
          ...view,
          result: {
            decisionSequence,
            applied: result.error === undefined && ownFailures.length === 0,
            unchanged: result.unchanged,
            failed: ownFailures,
            ...(result.error === undefined
              ? {}
              : {
                  error: {
                    code: 'plugin-reload-failed',
                    message: 'Extension generation could not be rebuilt.',
                  },
                }),
          },
        };
      }
      async function configuration(
        expected: number,
        input: McpServerConfig,
        id?: string,
      ): Promise<McpMutationResult> {
        return mutation(expected, async () => {
          const config = await normalizeMcpServerConfig(input);
          if (id !== undefined && config.id !== id) throw invalid();
          if (
            id === undefined &&
            ((await options.reservedPluginIds?.()) ?? []).includes(pluginId(config.id))
          )
            throw conflict();
          return { kind: id === undefined ? 'create' : 'update', config };
        });
      }
      const decide = (
        kind: 'disable' | 'revoke' | 'remove',
        id: string,
        expected: number,
        immediate = false,
      ) => mutation(expected, async () => ({ kind, serverId: id }), immediate, id);
      return {
        snapshot: project,
        configure: (expected, config) => configuration(expected, config),
        update: (id, expected, config) => configuration(expected, config, id),
        trust: (id, expected, configDigest) =>
          mutation(expected, async () => {
            await recheckMcpLaunchPaths(recordOf(id).config);
            return { kind: 'trust', serverId: id, configDigest };
          }),
        enable: (id, expected, configDigest) =>
          mutation(expected, async () => ({ kind: 'enable', serverId: id, configDigest })),
        disable: (id, expected, immediate) => decide('disable', id, expected, immediate?.immediate),
        revoke: (id, expected, immediate) => decide('revoke', id, expected, immediate?.immediate),
        remove: (id, expected, immediate) => decide('remove', id, expected, immediate?.immediate),
        reload: (expected) => mutation(expected, async () => undefined),
      };
    },
  };
}
