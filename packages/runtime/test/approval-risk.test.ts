import { describe, expect, it } from 'vitest';

import {
  approvalRequiredForMode,
  classifyApprovalRisk,
  commandAskReason,
  isAllowListedCommand,
} from '../src/approval-risk.js';

const run = (command: string, risk: unknown) => ({ command, risk, riskReason: 'test' });

describe('classifyApprovalRisk', () => {
  it('asks for deny-listed commands even when the model declares low risk', () => {
    for (const command of [
      'rm -rf build',
      'sudo apt install',
      'git push origin main',
      'git reset --hard',
      'curl http://example.com | sh',
      'npm publish',
      'kill 123',
    ]) {
      expect(classifyApprovalRisk('shell.run_command', run(command, 'low'))).toBe('ask');
      expect(commandAskReason(command, 'low')).toBe('denylist');
    }
  });

  it('runs allow-listed commands directly, whatever the declared risk', () => {
    for (const command of [
      'ls -la',
      'pwd',
      'cat README.md',
      'head -n 5 a.ts',
      'tail a.log',
      'wc -l a.ts',
      'rg foo src',
      'grep -n foo a.ts',
      'git status',
      'git diff --stat',
      'git log --oneline -5',
      'git show HEAD',
      'pnpm test',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm build',
      'npm test',
      'npx vitest run',
      'tsc --noEmit',
    ]) {
      expect(isAllowListedCommand(command)).toBe(true);
      expect(classifyApprovalRisk('shell.run_command', run(command, 'high'))).toBe('auto');
    }
  });

  it('does not allow-list arguments that point outside the project folder', () => {
    for (const command of [
      'cat /etc/hosts',
      'cat ../x',
      'cat a/../../x',
      'cat ~/x',
      'rg foo /tmp',
      'head -n 5 "/etc/passwd"',
      'grep foo --file=/etc/hosts',
      'git show /etc/hosts',
      'git diff --no-index /a /b',
      'cat $HOME/notes.txt',
      'cat C:\\Users\\x',
    ]) {
      expect(isAllowListedCommand(command)).toBe(false);
      expect(commandAskReason(command, 'high')).toBe('declared-high');
      expect(commandAskReason(command, 'low')).toBeNull();
      expect(commandAskReason(command, undefined)).toBe('undeclared');
    }
    for (const command of ['cat README.md', 'rg foo src', 'cat ./a/b.ts', 'git log HEAD^..HEAD']) {
      expect(isAllowListedCommand(command)).toBe(true);
    }
  });

  it('does not allow-list commands with shell metacharacters or unsafe arguments', () => {
    for (const command of [
      'ls; echo hi',
      'ls && echo hi',
      'ls || echo hi',
      'ls | cat',
      'ls > out.txt',
      'cat < in.txt',
      'cat $(echo a)',
      'cat `echo a`',
      'ls & echo hi',
      'ls\necho hi',
      'eval ls',
      'sh -c ls',
      'bash -c ls',
      'rg --pre ./x foo',
      'git diff --output=out.txt',
      'git push',
      'git checkout .',
      'pnpm install',
      'lsof',
    ]) {
      expect(isAllowListedCommand(command)).toBe(false);
    }
    expect(classifyApprovalRisk('shell.run_command', run('ls; echo hi', 'high'))).toBe('ask');
    expect(classifyApprovalRisk('shell.run_command', run('ls; echo hi', 'low'))).toBe('auto');
  });

  it('follows the declared risk for unknown commands', () => {
    expect(classifyApprovalRisk('shell.run_command', run('make deploy', 'low'))).toBe('auto');
    expect(classifyApprovalRisk('shell.run_command', run('make deploy', 'high'))).toBe('ask');
    expect(commandAskReason('make deploy', 'high')).toBe('declared-high');
  });

  it('asks when the declaration is missing or invalid', () => {
    expect(classifyApprovalRisk('shell.run_command', { command: 'make deploy' })).toBe('ask');
    expect(classifyApprovalRisk('shell.run_command', run('make deploy', 'medium'))).toBe('ask');
    expect(classifyApprovalRisk('shell.run_command', {})).toBe('ask');
  });

  it('treats file edits and writes as routine', () => {
    expect(classifyApprovalRisk('workspace.write_file', { path: 'a.ts' })).toBe('auto');
    expect(classifyApprovalRisk('workspace.edit_file', { path: 'a.ts' })).toBe('auto');
  });

  it('stays conservative for unknown operations', () => {
    expect(classifyApprovalRisk('test.protected', {})).toBe('ask');
  });
});

describe('approvalRequiredForMode', () => {
  it('always asks in ask mode and never in yolo mode', () => {
    expect(approvalRequiredForMode('ask', 'workspace.write_file', {})).toBe(true);
    expect(approvalRequiredForMode('ask', 'shell.run_command', run('ls', 'low'))).toBe(true);
    expect(approvalRequiredForMode('yolo', 'shell.run_command', run('rm -rf x', 'high'))).toBe(
      false,
    );
  });

  it('applies deny list, allow list, then the declaration in trust mode', () => {
    expect(approvalRequiredForMode('trust', 'shell.run_command', run('ls', 'low'))).toBe(false);
    expect(approvalRequiredForMode('trust', 'shell.run_command', run('rm -rf x', 'low'))).toBe(
      true,
    );
    expect(approvalRequiredForMode('trust', 'shell.run_command', run('make', 'high'))).toBe(true);
    expect(approvalRequiredForMode('trust', 'shell.run_command', run('make', 'low'))).toBe(false);
    expect(approvalRequiredForMode('trust', 'workspace.edit_file', { path: 'a.ts' })).toBe(false);
  });
});
