import { PluginError } from './plugin-errors.js';
import { type Disposer } from './service.js';

/**
 * Hooks are the kernel's three — and only three — interception shapes:
 *
 * - `observe`: read-only listeners run in parallel; one failing never affects
 *   the main flow or the other listeners.
 * - `wrap`: onion middleware; each handler wraps the next via `next()` and may
 *   adjust input and output. First-registered is outermost.
 * - `decide`: a security vote that can only make the outcome stricter. Votes
 *   merge `deny > ask > abstain`; no handler can vote `allow`. An all-abstain
 *   result permits the action.
 */
export type HookMode = 'observe' | 'wrap' | 'decide';

export interface Hook<I, O = void> {
  readonly id: string;
  readonly mode: HookMode;
  readonly __in?: I;
  readonly __out?: O;
}

/** Defines a hook with one of the three fixed modes. */
export function defineHook<I, O = void>(spec: { id: string; mode: HookMode }): Hook<I, O> {
  return Object.freeze({ id: spec.id, mode: spec.mode }) as Hook<I, O>;
}

/** A security decision; strictly ordered `deny > ask > abstain`. */
export type PolicyVote = 'deny' | 'ask' | 'abstain';

const voteRank: Record<PolicyVote, number> = { abstain: 0, ask: 1, deny: 2 };

export type ObserveHandler<I> = (input: I) => void | Promise<void>;
export type WrapHandler<I, O> = (input: I, next: (input: I) => Promise<O>) => Promise<O>;
export type DecideHandler<I> = (input: I) => PolicyVote | Promise<PolicyVote>;

interface HandlerEntry {
  readonly handler: unknown;
  readonly pluginId: string;
}

/** Stores hook handlers and runs them with the mode's dispatch rules. */
export class HookRegistry {
  readonly #handlers = new Map<string, HandlerEntry[]>();

  /** Registers a handler for `hook`. Returns a disposer that removes it. */
  on<I, O>(
    hook: Hook<I, O>,
    handler: ObserveHandler<I> | WrapHandler<I, O> | DecideHandler<I>,
    pluginId: string,
  ): Disposer {
    const entry: HandlerEntry = { handler, pluginId };
    const list = this.#handlers.get(hook.id);
    if (list === undefined) {
      this.#handlers.set(hook.id, [entry]);
    } else {
      list.push(entry);
    }
    let disposed = false;
    return () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const current = this.#handlers.get(hook.id);
      if (current === undefined) {
        return;
      }
      const index = current.indexOf(entry);
      if (index >= 0) {
        current.splice(index, 1);
      }
    };
  }

  #entries(hookId: string): readonly HandlerEntry[] {
    return this.#handlers.get(hookId) ?? [];
  }

  /** Runs observe listeners in parallel; isolates and swallows their errors. */
  async runObserve<I>(
    hook: Hook<I, void>,
    input: I,
    onError?: (error: unknown, pluginId: string) => void,
  ): Promise<void> {
    if (hook.mode !== 'observe') {
      throw new PluginError('plugin-hook-invalid-vote', `Hook "${hook.id}" is not an observe hook`);
    }
    await Promise.all(
      this.#entries(hook.id).map(async (entry) => {
        try {
          await (entry.handler as ObserveHandler<I>)(input);
        } catch (error: unknown) {
          onError?.(error, entry.pluginId);
        }
      }),
    );
  }

  /** Composes wrap middleware around `base`; first-registered is outermost. */
  async runWrap<I, O>(hook: Hook<I, O>, input: I, base: (input: I) => Promise<O>): Promise<O> {
    if (hook.mode !== 'wrap') {
      throw new PluginError('plugin-hook-invalid-vote', `Hook "${hook.id}" is not a wrap hook`);
    }
    const handlers = this.#entries(hook.id).map((entry) => entry.handler as WrapHandler<I, O>);
    const chain = handlers.reduceRight<(input: I) => Promise<O>>(
      (next, handler) => (value: I) => handler(value, next),
      base,
    );
    return chain(input);
  }

  /** Collects decide votes and returns the strictest; all-abstain permits. */
  async runDecide<I>(hook: Hook<I, PolicyVote>, input: I): Promise<PolicyVote> {
    if (hook.mode !== 'decide') {
      throw new PluginError('plugin-hook-invalid-vote', `Hook "${hook.id}" is not a decide hook`);
    }
    let result: PolicyVote = 'abstain';
    for (const entry of this.#entries(hook.id)) {
      const vote = await (entry.handler as DecideHandler<I>)(input);
      if (vote !== 'deny' && vote !== 'ask' && vote !== 'abstain') {
        throw new PluginError(
          'plugin-hook-invalid-vote',
          `Decide hook "${hook.id}" handler from plugin "${entry.pluginId}" returned an invalid vote`,
        );
      }
      if (voteRank[vote] > voteRank[result]) {
        result = vote;
      }
    }
    return result;
  }

  /** Number of handlers registered for a hook (test/introspection aid). */
  count(hook: Hook<unknown, unknown>): number {
    return this.#handlers.get(hook.id)?.length ?? 0;
  }
}
