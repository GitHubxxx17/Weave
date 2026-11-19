import { planItemSchema, type AgentPlan, type PlanItem } from '@weave/protocol';
import { z } from 'zod';
import type { ToolDefinition } from './tool-types.js';

/** Stable name of the plan-maintenance tool. */
export const updatePlanToolName = 'update_plan';

/** Model-facing input of the `update_plan` tool (Codex-compatible shape). */
export interface UpdatePlanInput {
  /** Optional one-line note explaining this update. */
  readonly explanation?: string | undefined;
  /** The complete, current task list; each call replaces the whole plan. */
  readonly plan: readonly PlanItem[];
}

/** Validates parsed `update_plan` arguments. */
export const updatePlanInputSchema: z.ZodType<UpdatePlanInput> = z.object({
  explanation: z.string().optional(),
  plan: z.array(planItemSchema),
});

function toAgentPlan(input: UpdatePlanInput): AgentPlan {
  return {
    ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
    items: input.plan.map((item) => ({ step: item.step, status: item.status })),
  };
}

/**
 * Recovers the {@link AgentPlan} carried by a tool call, when it is an
 * `update_plan` call with valid arguments.
 *
 * The Runner only has the raw JSON argument string of an executed tool call
 * (the Pipeline returns a serialized result, not the parsed input), so it
 * re-parses here to attach the plan to durable and transient events.
 */
export function parsePlanFromToolCall(toolCall: {
  readonly name: string;
  readonly arguments: string;
}): AgentPlan | undefined {
  if (toolCall.name !== updatePlanToolName) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments);
  } catch {
    return undefined;
  }
  const result = updatePlanInputSchema.safeParse(parsed);
  return result.success ? toAgentPlan(result.data) : undefined;
}

function summarize(plan: AgentPlan): string {
  const total = plan.items.length;
  const inProgress = plan.items.filter((item) => item.status === 'in_progress').length;
  const completed = plan.items.filter((item) => item.status === 'completed').length;
  const pending = total - inProgress - completed;
  return `已记录计划：共 ${total} 项（进行中 ${inProgress}，已完成 ${completed}，待办 ${pending}）。`;
}

/**
 * Creates the `update_plan` tool.
 *
 * The model calls it to maintain a task checklist (pending / in_progress /
 * completed); each call replaces the whole plan. It records plan state only, has
 * no filesystem or network side effect, and therefore needs no approval, so it
 * is marked read-only and runs in every permission mode.
 */
export function createUpdatePlanTool(): ToolDefinition<UpdatePlanInput, string> {
  return {
    name: updatePlanToolName,
    description:
      'Maintain a short task plan for multi-step work. Pass the complete, current ' +
      'list each time (it replaces the previous plan). Each item has a `step` and a ' +
      '`status` of pending, in_progress, or completed. Keep at most one item ' +
      'in_progress. Update it as you finish steps. Records the plan only; it changes ' +
      'nothing on disk.',
    readOnly: true,
    parameters: {
      type: 'object',
      properties: {
        explanation: { type: 'string' },
        plan: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              step: { type: 'string', minLength: 1 },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
            required: ['step', 'status'],
            additionalProperties: false,
          },
        },
      },
      required: ['plan'],
      additionalProperties: false,
    },
    inputSchema: updatePlanInputSchema,
    execute: (input) => summarize(toAgentPlan(input)),
  };
}
