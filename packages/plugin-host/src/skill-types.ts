export type SkillHostErrorCode =
  | 'skill-invalid-document'
  | 'skill-unreadable'
  | 'skill-unsafe-entry'
  | 'skill-source-changed'
  | 'skill-limit-exceeded'
  | 'skill-unsupported-text';

/** Disk diagnostics are safe codes; callers do not need native paths or messages. */
export class SkillHostError extends Error {
  constructor(
    readonly code: SkillHostErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = 'SkillHostError';
  }
}

export interface SkillRootInput {
  readonly id: string;
  readonly directory: string;
  readonly label: string;
}
export interface DiskSkillHandle {
  readonly rootId: string;
  readonly name: string;
  readonly instructionSha256: string;
  readonly bundleSha256: string;
}
export interface SkillResourceIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface ParsedSkillDocument {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
  readonly invocation: { readonly user: boolean; readonly model: boolean };
  readonly license?: string;
  readonly compatibility?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface DiscoveredSkillBundle {
  readonly handle: DiskSkillHandle;
  readonly name: string;
  readonly description: string;
  readonly invocation: { readonly user: boolean; readonly model: boolean };
  readonly resources: readonly SkillResourceIdentity[];
}
export interface SkillDiscoveryResult {
  readonly bundles: readonly DiscoveredSkillBundle[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly issues: readonly {
    readonly code:
      'unreadable' | 'invalid-document' | 'unsafe-entry' | 'source-changed' | 'limit-exceeded';
    readonly name?: string;
  }[];
}
export interface PinnedSkillBundle {
  readonly handle: DiskSkillHandle;
  readonly instructions: string;
  readonly resources: readonly SkillResourceIdentity[];
}

/** Shared by all roots in a single host-owned catalog operation. */
export interface SkillScanBudget {
  remainingBytes: number;
}
export function createSkillScanBudget(totalBytes = 64 * 1024 * 1024): SkillScanBudget {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > 64 * 1024 * 1024) {
    throw new SkillHostError('skill-limit-exceeded');
  }
  return { remainingBytes: totalBytes };
}

export interface SkillIoOptions {
  readonly root: SkillRootInput;
  readonly signal?: AbortSignal;
  readonly budget?: SkillScanBudget;
}
