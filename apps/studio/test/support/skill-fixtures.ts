export const planningSkill = {
  id: 'builtin:weave-planning',
  name: 'weave-planning',
  description: '为代码任务制定可验证的实施计划',
  instructionSha256: 'a'.repeat(64),
  bundleSha256: 'b'.repeat(64),
  source: { kind: 'builtin', label: 'Weave 内置' },
  invocation: { user: true, model: true },
} as const;
export const projectSkill = {
  ...planningSkill,
  id: `project:${'c'.repeat(32)}/native/review-code`,
  name: 'review-code',
  description: '检查项目代码的行为和边界',
  source: { kind: 'project', label: '当前项目' },
} as const;
export const planningRef = {
  id: planningSkill.id,
  instructionSha256: planningSkill.instructionSha256,
  bundleSha256: planningSkill.bundleSha256,
};
export function skillCatalog(entries: readonly unknown[] = [planningSkill, projectSkill]) {
  return {
    schemaVersion: 1,
    generation: 1,
    fingerprint: 'd'.repeat(64),
    entries,
    complete: true,
    truncated: false,
    issues: [],
  };
}
