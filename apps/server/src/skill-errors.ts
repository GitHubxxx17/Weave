/** Safe public failures from inert Skill discovery and preparation. */
export type SkillErrorCode =
  | 'skill-not-found'
  | 'skill-catalog-stale'
  | 'skill-source-changed'
  | 'skill-not-invocable'
  | 'skill-invalid-input'
  | 'skill-unavailable';
export class SkillError extends Error {
  constructor(
    readonly code: SkillErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'SkillError';
  }
}
/** Required durable provenance failure: deliberately not a recoverable tool error. */
export class SkillAuditError extends Error {
  readonly code = 'skill-audit-failed';
  constructor(options?: ErrorOptions) {
    super('The Skill instructions for this turn could not be safely recorded', options);
    this.name = 'SkillAuditError';
  }
}
export function safeSkillError(error: unknown): SkillError {
  if (error instanceof SkillError) return error;
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'skill-source-changed'
  )
    return new SkillError(
      'skill-source-changed',
      'The Skill changed; refresh its catalog and select it again',
      { cause: error },
    );
  return new SkillError('skill-unavailable', 'The Skill content is unavailable', { cause: error });
}
