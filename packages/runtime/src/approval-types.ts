import { z } from 'zod';

const nonEmptyStringSchema = z.string().min(1);
const approvalRiskSchema = z.enum(['low', 'medium', 'high']);
const approvalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']);

/** Risk level shown to the caller before a protected tool executes. */
export type ApprovalRisk = z.infer<typeof approvalRiskSchema>;

/** Lifecycle states owned by the Approval Broker. */
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

/** Immutable snapshot exposed while an Approval request is pending or resolved. */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly summary: string;
  readonly risk: ApprovalRisk;
  readonly inputSummary: unknown;
  readonly sessionId?: string | undefined;
  /** Run attribution supplied by the shared Tool Pipeline. */
  readonly turnId?: string | undefined;
  readonly executionId?: string | undefined;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
  readonly resolvedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly decisionReason?: string | undefined;
}

/** A live Approval Broker event carrying an immutable request snapshot. */
export interface ApprovalEvent {
  readonly type: 'approval.created' | 'approval.resolved';
  readonly request: ApprovalRequest;
}

/** Receives live Approval Broker events within the current Runtime process. */
export type ApprovalListener = (event: ApprovalEvent) => void;

/** Input used to create one pending Approval request. */
export interface CreateApprovalRequestInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly operation: string;
  readonly summary: string;
  readonly risk: ApprovalRisk;
  readonly inputSummary: unknown;
  readonly sessionId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/** Decision returned when an Approval request reaches a terminal state. */
export type ApprovalDecision =
  | { readonly status: 'approved'; readonly reason?: string | undefined }
  | { readonly status: 'rejected'; readonly reason?: string | undefined }
  | { readonly status: 'cancelled'; readonly reason?: string | undefined }
  | { readonly status: 'expired'; readonly reason?: string | undefined };

/** Stable failures raised by the Approval Broker boundary. */
export type ApprovalErrorCode =
  | 'approval-invalid-input'
  | 'approval-not-found'
  | 'approval-already-resolved'
  | 'approval-cancelled'
  | 'approval-expired';

/** Error raised when an Approval request cannot continue. */
export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApprovalError';
    this.code = code;
  }
}

/** Public operations for creating and resolving Approval requests. */
export interface ApprovalBroker {
  /** Creates a pending request and waits for an external decision. */
  request(input: CreateApprovalRequestInput): Promise<ApprovalDecision>;
  /** Returns an immutable snapshot for one request, when it exists. */
  get(approvalId: string): ApprovalRequest | undefined;
  /** Returns immutable snapshots in request creation order. */
  list(): readonly ApprovalRequest[];
  /** Subscribes to live request creation and terminal-state events. */
  subscribe(listener: ApprovalListener): () => void;
  /** Approves a pending request. */
  approve(approvalId: string, reason?: string): ApprovalRequest;
  /** Rejects a pending request without executing the protected tool. */
  reject(approvalId: string, reason?: string): ApprovalRequest;
  /** Cancels a pending request and rejects its waiting Promise. */
  cancel(approvalId: string, reason?: string): ApprovalRequest;
  /** Expires a pending request and rejects its waiting Promise. */
  expire(approvalId: string, reason?: string): ApprovalRequest;
}

/** Validates one Approval request before it enters the Broker. */
export const createApprovalRequestInputSchema: z.ZodType<CreateApprovalRequestInput> = z.object({
  toolCallId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  operation: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  risk: approvalRiskSchema,
  inputSummary: z.unknown(),
  sessionId: nonEmptyStringSchema.optional(),
  signal: z.instanceof(AbortSignal).optional(),
  timeoutMs: z.number().finite().nonnegative().optional(),
});

/** Validates the immutable shape returned by the Broker. */
export const approvalRequestSchema: z.ZodType<ApprovalRequest> = z.object({
  approvalId: nonEmptyStringSchema,
  toolCallId: nonEmptyStringSchema,
  toolName: nonEmptyStringSchema,
  operation: nonEmptyStringSchema,
  summary: nonEmptyStringSchema,
  risk: approvalRiskSchema,
  inputSummary: z.unknown(),
  sessionId: nonEmptyStringSchema.optional(),
  turnId: nonEmptyStringSchema.optional(),
  executionId: nonEmptyStringSchema.optional(),
  status: approvalStatusSchema,
  createdAt: nonEmptyStringSchema,
  resolvedAt: nonEmptyStringSchema.optional(),
  expiresAt: nonEmptyStringSchema.optional(),
  decisionReason: z.string().optional(),
});

/** Validates a terminal Approval decision. */
export const approvalDecisionSchema: z.ZodType<ApprovalDecision> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('approved'), reason: z.string().optional() }),
  z.object({ status: z.literal('rejected'), reason: z.string().optional() }),
  z.object({ status: z.literal('cancelled'), reason: z.string().optional() }),
  z.object({ status: z.literal('expired'), reason: z.string().optional() }),
]);
