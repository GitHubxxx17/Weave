import path from 'node:path';

import { isSecretFile } from './secret-files.js';

/**
 * Workspace files whose content later runs code or exposes secrets. In `trust`
 * mode a write or edit that targets one of them asks for Approval.
 *
 * Paths are Workspace-relative with `/` separators. Matching is case
 * insensitive and happens after `.` and `..` segments are normalized.
 *
 * Studio shows these categories as static text: when you change this list, also
 * update `apps/studio/src/app/permission-settings-view.tsx`.
 */

/** Directory prefixes: every file below them is sensitive. */
const sensitiveDirectories: readonly string[] = [
  // Git internals, including hooks that run on commit or checkout.
  '.git',
  // Hook managers: the files run as Git hooks.
  '.husky',
  '.githooks',
  // CI definitions run with repository secrets on a remote runner.
  '.github/workflows',
  '.github/actions',
  '.circleci',
  '.buildkite',
  // Dev container definitions run commands when the folder is opened.
  '.devcontainer',
];

/** Exact Workspace-root files. */
const sensitiveRootFiles: readonly string[] = [
  '.pre-commit-config.yaml',
  'lefthook.yml',
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  // direnv runs this file when the shell enters the folder.
  '.envrc',
  // The editor runs tasks and launch configurations on request.
  '.vscode/tasks.json',
  '.vscode/launch.json',
  '.vscode/settings.json',
];

/** File names that are sensitive at any depth. */
const sensitiveFileNames: readonly string[] = [
  // Lifecycle scripts run on install or by name.
  'package.json',
  // Package manager configuration: registries, scripts and hooks.
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'pnpm-workspace.yaml',
  // Build scripts run by `make` and `just`.
  'Makefile',
  'justfile',
];

const sensitiveDirectorySet = sensitiveDirectories.map((entry) => entry.toLowerCase());
const sensitiveRootFileSet = new Set(sensitiveRootFiles.map((entry) => entry.toLowerCase()));
const sensitiveFileNameSet = new Set(sensitiveFileNames.map((entry) => entry.toLowerCase()));

/** Reason shown on the Approval card for a call that asks because of its path. */
export type SensitivePathReason = 'sensitive-path';

/**
 * Normalizes a Workspace-relative path: `/` separators, no `.` segments, `..`
 * resolved. Returns `undefined` for an absolute path or one that climbs above
 * the Workspace root.
 */
function normalizeRelativePath(relativePath: string): string | undefined {
  const posix = relativePath.replace(/\\/g, '/');
  if (posix.startsWith('/') || /^[A-Za-z]:\//.test(posix)) {
    return undefined;
  }
  const normalized = path.posix.normalize(posix);
  if (normalized === '..' || normalized.startsWith('../')) {
    return undefined;
  }
  return normalized === '.' ? '' : normalized;
}

/**
 * Whether writing the Workspace-relative path `relativePath` is sensitive. A
 * path that cannot be normalized (absolute, or outside the Workspace) counts as
 * sensitive so callers err toward asking.
 */
export function isSensitiveWritePath(relativePath: string): boolean {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === undefined) {
    return true;
  }
  const lower = normalized.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  return (
    sensitiveDirectorySet.some(
      (directory) => lower === directory || lower.startsWith(`${directory}/`),
    ) ||
    sensitiveRootFileSet.has(lower) ||
    sensitiveFileNameSet.has(name) ||
    isSecretFile(name)
  );
}
