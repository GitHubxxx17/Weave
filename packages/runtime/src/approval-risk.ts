import type { ToolPermissionMode } from './tool-types.js';

/** Approval outcome the pipeline applies to one protected tool call. */
export type ApprovalRiskDecision = 'auto' | 'ask';

/**
 * Commands that delete data, touch the network, or escalate privilege. In
 * `trust` mode these still require Approval; other commands run directly.
 */
const dangerousCommandPattern =
  /\b(sudo|rm|rmdir|mkfs|dd|shutdown|reboot|kill|pkill|chmod|chown|curl|wget|nc|ssh|scp)\b|\bgit\s+(push|reset|clean)\b|\b(npm|pnpm|yarn)\s+publish\b/i;

function readStringField(input: unknown, key: string): string {
  if (typeof input === 'object' && input !== null) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  return '';
}

/**
 * Classifies one protected tool call. `ask` marks a high-risk call that must
 * still wait for Approval even in `trust` mode; `auto` may run directly.
 */
export function classifyApprovalRisk(operation: string, input: unknown): ApprovalRiskDecision {
  if (operation === 'shell.run_command') {
    return dangerousCommandPattern.test(readStringField(input, 'command')) ? 'ask' : 'auto';
  }
  if (operation === 'workspace.write_file' || operation === 'workspace.edit_file') {
    return 'auto';
  }
  // Unknown protected operations stay conservative.
  return 'ask';
}

/** Whether a protected tool call needs Approval under the given permission mode. */
export function approvalRequiredForMode(
  mode: ToolPermissionMode,
  operation: string,
  input: unknown,
): boolean {
  switch (mode) {
    case 'ask':
      return true;
    case 'trust':
      return classifyApprovalRisk(operation, input) === 'ask';
    case 'yolo':
      return false;
  }
}
