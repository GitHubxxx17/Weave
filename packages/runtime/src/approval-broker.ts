import { randomUUID } from 'node:crypto';
import {
  ApprovalError,
  createApprovalRequestInputSchema,
  type ApprovalBroker,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalStatus,
  type CreateApprovalRequestInput,
} from './approval-types.js';

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  reject: (error: ApprovalError) => void;
  cleanup: () => void;
}

function createAbortError(): ApprovalError {
  return new ApprovalError('approval-cancelled', 'Approval request was cancelled');
}

function createTerminalDecision(
  status: Exclude<ApprovalStatus, 'pending'>,
  reason: string | undefined,
): ApprovalDecision {
  return reason === undefined ? { status } : { status, reason };
}

function snapshot(request: ApprovalRequest): ApprovalRequest {
  return Object.freeze({ ...request });
}

function parseInput(input: CreateApprovalRequestInput): CreateApprovalRequestInput {
  const result = createApprovalRequestInputSchema.safeParse(input);
  if (!result.success) {
    throw new ApprovalError('approval-invalid-input', 'Approval request input is invalid', {
      cause: result.error,
    });
  }
  return result.data;
}

function createResolvedMessage(status: Exclude<ApprovalStatus, 'pending'>): string {
  return `Approval request is already ${status}`;
}

/** Creates an in-memory Approval Broker for one Runtime process. */
export function createApprovalBroker(): ApprovalBroker {
  const requests = new Map<string, PendingApproval>();

  function getPending(approvalId: string): PendingApproval {
    const pending = requests.get(approvalId);
    if (pending === undefined) {
      throw new ApprovalError('approval-not-found', 'Approval request was not found');
    }
    if (pending.request.status !== 'pending') {
      throw new ApprovalError(
        'approval-already-resolved',
        createResolvedMessage(pending.request.status),
      );
    }
    return pending;
  }

  function transition(
    approvalId: string,
    status: Exclude<ApprovalStatus, 'pending'>,
    reason: string | undefined,
  ): ApprovalRequest {
    const pending = getPending(approvalId);
    const resolvedAt = new Date().toISOString();
    pending.request = Object.freeze({
      ...pending.request,
      status,
      resolvedAt,
      ...(reason === undefined ? {} : { decisionReason: reason }),
    });
    pending.cleanup();

    const decision = createTerminalDecision(status, reason);
    if (status === 'cancelled') {
      pending.reject(
        new ApprovalError('approval-cancelled', 'Approval request was cancelled', {
          cause: reason === undefined ? undefined : new Error(reason),
        }),
      );
    } else if (status === 'expired') {
      pending.reject(
        new ApprovalError('approval-expired', 'Approval request expired', {
          cause: reason === undefined ? undefined : new Error(reason),
        }),
      );
    } else {
      pending.resolve(decision);
    }
    return snapshot(pending.request);
  }

  return {
    request(input): Promise<ApprovalDecision> {
      const parsedInput = parseInput(input);
      if (parsedInput.signal?.aborted) {
        return Promise.reject(createAbortError());
      }

      const createdAt = new Date();
      const approvalId = randomUUID();
      const expiresAt =
        parsedInput.timeoutMs === undefined
          ? undefined
          : new Date(createdAt.getTime() + parsedInput.timeoutMs).toISOString();
      const request: ApprovalRequest = Object.freeze({
        approvalId,
        toolCallId: parsedInput.toolCallId,
        toolName: parsedInput.toolName,
        operation: parsedInput.operation,
        summary: parsedInput.summary,
        risk: parsedInput.risk,
        inputSummary: parsedInput.inputSummary,
        status: 'pending',
        createdAt: createdAt.toISOString(),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });

      let resolvePromise!: (decision: ApprovalDecision) => void;
      let rejectPromise!: (error: ApprovalError) => void;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let abortHandler: (() => void) | undefined;
      const promise = new Promise<ApprovalDecision>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });

      const pending: PendingApproval = {
        request,
        resolve: resolvePromise,
        reject: rejectPromise,
        cleanup: () => {
          if (timeoutId !== undefined) {
            clearTimeout(timeoutId);
            timeoutId = undefined;
          }
          if (abortHandler !== undefined && parsedInput.signal !== undefined) {
            parsedInput.signal.removeEventListener('abort', abortHandler);
            abortHandler = undefined;
          }
        },
      };
      requests.set(approvalId, pending);

      if (parsedInput.signal !== undefined) {
        abortHandler = (): void => {
          try {
            transition(approvalId, 'cancelled', 'Approval signal was aborted');
          } catch {
            // A concurrent terminal decision already won the race.
          }
        };
        parsedInput.signal.addEventListener('abort', abortHandler, { once: true });
      }

      if (parsedInput.timeoutMs === 0) {
        transition(approvalId, 'expired', 'Approval timeout elapsed');
      } else if (parsedInput.timeoutMs !== undefined) {
        timeoutId = setTimeout(() => {
          try {
            transition(approvalId, 'expired', 'Approval timeout elapsed');
          } catch {
            // A concurrent terminal decision already won the race.
          }
        }, parsedInput.timeoutMs);
      }

      return promise;
    },

    get(approvalId): ApprovalRequest | undefined {
      const pending = requests.get(approvalId);
      return pending === undefined ? undefined : snapshot(pending.request);
    },

    list(): readonly ApprovalRequest[] {
      return Object.freeze([...requests.values()].map((pending) => snapshot(pending.request)));
    },

    approve(approvalId, reason): ApprovalRequest {
      return transition(approvalId, 'approved', reason);
    },

    reject(approvalId, reason): ApprovalRequest {
      return transition(approvalId, 'rejected', reason);
    },

    cancel(approvalId, reason): ApprovalRequest {
      return transition(approvalId, 'cancelled', reason);
    },

    expire(approvalId, reason): ApprovalRequest {
      return transition(approvalId, 'expired', reason);
    },
  };
}
