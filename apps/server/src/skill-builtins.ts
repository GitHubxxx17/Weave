import type { SkillContribution } from '@weave/plugin';
/** Authored for Weave; execution and approval retain the ordinary Runtime rules. */
export const builtinSkills: readonly SkillContribution[] = Object.freeze([
  Object.freeze({
    name: 'weave-planning',
    description: 'Plan multi-step coding work, keep progress current, and verify the result.',
    instructions:
      'For multi-step work, use update_plan to record concrete steps. Keep at most one step in_progress, mark completed work promptly, and verify behavior before reporting completion. Read references/planning.md when a detailed checklist helps. This Skill grants no additional tool permissions.',
    invocation: Object.freeze({ user: true, model: true }),
    resources: Object.freeze({
      'references/planning.md':
        '# Planning checklist\n\n1. Inspect the current project and define observable outcomes.\n2. Record a small ordered plan with update_plan.\n3. Keep at most one in_progress step and mark finished steps completed.\n4. Run relevant checks, resolve failures, and report concrete evidence.\n',
    }),
  }),
]);
