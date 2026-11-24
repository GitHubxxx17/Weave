/** How much a plugin can do to the host through one hook. */
export type HookRiskLevel = 'high' | 'medium' | 'low';

export interface HookImpact {
  readonly level: HookRiskLevel;
  readonly description: string;
}

/**
 * The single source of truth for hook risk. Hosts and Studio (through the
 * Server) read the level and the wording from here.
 */
export const hookImpacts: Readonly<Record<string, HookImpact>> = Object.freeze({
  'weave.llm.request': Object.freeze({
    level: 'high',
    description: '能看到并改写发给模型的全部内容',
  }),
  'weave.tools.around': Object.freeze({ level: 'high', description: '能改写工具调用的参数和结果' }),
  'weave.tools.result': Object.freeze({ level: 'medium', description: '能读到每次工具调用的结果' }),
  'weave.tools.policy': Object.freeze({
    level: 'low',
    description: '只能拒绝或要求确认工具调用，不能放行',
  }),
  'weave.turn.start': Object.freeze({ level: 'low', description: '知道回合何时开始和结束' }),
  'weave.turn.end': Object.freeze({ level: 'low', description: '知道回合何时开始和结束' }),
});

/**
 * Hooks that stay inactive until the user confirms them when a plugin
 * subscribes without declaring them in `contributes.hooks`.
 * `weave.tools.result` is deliberately not listed; see the design proposal.
 */
export const confirmationRequiredHookIds: readonly string[] = Object.freeze([
  'weave.llm.request',
  'weave.tools.around',
]);

/** Whether an undeclared subscription to `hookId` needs the user's confirmation. */
export function requiresHookConfirmation(hookId: string): boolean {
  return confirmationRequiredHookIds.includes(hookId);
}
