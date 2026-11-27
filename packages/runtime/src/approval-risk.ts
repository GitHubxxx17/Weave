import { isSensitiveWritePath } from './sensitive-paths.js';
import type { ToolPermissionMode } from './tool-types.js';

function isAbsolutePath(value: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(value);
}

/** Approval outcome the pipeline applies to one protected tool call. */
export type ApprovalRiskDecision = 'auto' | 'ask';

/** Risk level the model declares for a `run_command` call. */
export type DeclaredCommandRisk = 'low' | 'high';

/** Why a `run_command` call asks for Approval in `trust` mode. */
export type CommandAskReason = 'denylist' | 'declared-high' | 'undeclared';

/**
 * Deny list: commands that delete data, touch the network, or escalate
 * privilege. In `trust` mode these always require Approval, whatever risk the
 * model declared.
 */
const dangerousCommandPattern =
  /\b(sudo|rm|rmdir|mkfs|dd|shutdown|reboot|kill|pkill|chmod|chown|curl|wget|nc|ssh|scp)\b|\bgit\s+(push|reset|clean)\b|\b(npm|pnpm|yarn)\s+publish\b/i;

/**
 * Allow list for `trust` mode, matched on program plus subcommand (token
 * prefix). Further arguments are accepted unless they hit
 * `unsafeAllowListArguments` or may point outside the project folder.
 */
const allowListedCommands: readonly (readonly string[])[] = [
  ['ls'],
  ['pwd'],
  ['cat'],
  ['head'],
  ['tail'],
  ['wc'],
  ['rg'],
  ['grep'],
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'log'],
  ['git', 'show'],
  ['pnpm', 'test'],
  ['pnpm', 'lint'],
  ['pnpm', 'typecheck'],
  ['pnpm', 'build'],
  ['npm', 'test'],
  ['npx', 'vitest'],
  ['tsc', '--noEmit'],
];

/** Arguments that make an allow-listed program run other programs or write files. */
const unsafeAllowListArguments = /^(--pre(=.*)?|--output(=.*)?|--ext-diff|--textconv)$/;

/**
 * Shell syntax that can chain, redirect, substitute or indirectly run another
 * command. A command containing any of these never matches the allow list.
 */
const shellMetacharacterPattern = /;|&|\||>|<|\$\(|`|\n|\r|\beval\b|\b(sh|bash)\s+-c\b/;

/**
 * Whether one argument may point outside the project folder: an absolute path,
 * a home path, a `..` segment, or a variable that expands to one. The project
 * root is not known where the allow list is evaluated, so every absolute path
 * counts as outside. An option value (`--file=/etc/x`) is checked as well.
 */
function mayEscapeProjectRoot(token: string): boolean {
  const bare = token.replace(/['"]/g, '');
  if (bare.includes('$')) {
    return true;
  }
  const equals = bare.indexOf('=');
  const candidates = equals === -1 ? [bare] : [bare, bare.slice(equals + 1)];
  return candidates.some(
    (value) =>
      /^([/\\~]|[A-Za-z]:[/\\])/.test(value) || value.split(/[/\\]/).some((part) => part === '..'),
  );
}

/** Whether a command line is a plain allow-listed command. */
export function isAllowListedCommand(command: string): boolean {
  if (shellMetacharacterPattern.test(command)) {
    return false;
  }
  const tokens = command.trim().split(/\s+/);
  if (tokens.some((token) => unsafeAllowListArguments.test(token))) {
    return false;
  }
  const entry = allowListedCommands.find((candidate) =>
    candidate.every((word, index) => tokens[index] === word),
  );
  // Arguments that reach outside the project folder (for example
  // `cat /etc/hosts`) fall back to the risk the model declared.
  return entry !== undefined && !tokens.slice(entry.length).some(mayEscapeProjectRoot);
}

/**
 * Decides whether a `run_command` call asks in `trust` mode and why. `null`
 * means it runs directly. The deny list wins over the allow list, which wins
 * over the model's declaration.
 */
export function commandAskReason(command: string, risk: unknown): CommandAskReason | null {
  if (dangerousCommandPattern.test(command)) {
    return 'denylist';
  }
  if (isAllowListedCommand(command)) {
    return null;
  }
  if (risk === 'high') {
    return 'declared-high';
  }
  return risk === 'low' ? null : 'undeclared';
}

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
    const risk =
      typeof input === 'object' && input !== null
        ? (input as Record<string, unknown>).risk
        : undefined;
    return commandAskReason(readStringField(input, 'command'), risk) === null ? 'auto' : 'ask';
  }
  if (operation === 'workspace.write_file' || operation === 'workspace.edit_file') {
    // Lexical check on the path the model typed. Absolute paths and symbolic
    // links are resolved against the Workspace by the tool's `asksInTrust`.
    const target = readStringField(input, 'path');
    return !isAbsolutePath(target) && isSensitiveWritePath(target) ? 'ask' : 'auto';
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
