import { z } from 'zod';

/** Lifecycle state of one plan item. */
export type PlanItemStatus = 'pending' | 'in_progress' | 'completed';

/** One task in an Agent plan checklist. */
export interface PlanItem {
  /** Short description of the task. */
  readonly step: string;
  readonly status: PlanItemStatus;
}

/**
 * A task checklist the Agent maintains with the `update_plan` tool. Each update
 * replaces the whole plan, so this is always the current, complete list.
 */
export interface AgentPlan {
  /** Optional one-line note explaining this update. */
  readonly explanation?: string | undefined;
  readonly items: readonly PlanItem[];
}

export const planItemStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

export const planItemSchema: z.ZodType<PlanItem> = z.object({
  step: z.string().min(1),
  status: planItemStatusSchema,
});

/** Validates a complete Agent plan snapshot. */
export const planSchema: z.ZodType<AgentPlan> = z.object({
  explanation: z.string().optional(),
  items: z.array(planItemSchema),
});
