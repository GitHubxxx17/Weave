import { z } from 'zod';

export type GithubAcquisitionErrorCode =
  | 'plugin-github-invalid'
  | 'plugin-github-too-large'
  | 'plugin-github-unavailable'
  | 'plugin-github-rate-limited'
  | 'plugin-github-timeout';

export class GithubAcquisitionError extends Error {
  constructor(
    readonly code: GithubAcquisitionErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'GithubAcquisitionError';
  }
}

export function invalid(
  message = 'GitHub returned invalid plugin source data',
): GithubAcquisitionError {
  return new GithubAcquisitionError('plugin-github-invalid', message);
}

export function tooLarge(): GithubAcquisitionError {
  return new GithubAcquisitionError(
    'plugin-github-too-large',
    'The GitHub plugin source exceeds acquisition limits',
  );
}

export function safeSegments(value: string): string[] {
  const segments = value.split('/');
  for (const segment of segments) {
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      /[<>:"\\|?*\p{Cc}]/u.test(segment) ||
      /[. ]$/.test(segment) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(segment)
    )
      throw invalid('The GitHub plugin source contains an unsafe path');
    // JSON can contain unpaired surrogates that cannot name the same UTF-8 file.
    try {
      encodeURIComponent(segment);
    } catch {
      throw invalid('The GitHub plugin source contains an unsafe path');
    }
  }
  return segments;
}

export const githubPluginSourceSchema = z.strictObject({
  repository: z
    .string()
    .regex(/^https:\/\/github\.com\/[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\/[a-zA-Z0-9_.-]+$/)
    .refine(
      (value) =>
        !value.toLowerCase().endsWith('.git') && !value.endsWith('/.') && !value.endsWith('/..'),
    )
    .transform((value) => value.toLowerCase()),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  subdirectory: z
    .string()
    .default('')
    .refine((value) => {
      if (value === '') return true;
      try {
        return safeSegments(value).length <= 8;
      } catch {
        return false;
      }
    }),
});

export type GithubPluginSource = z.infer<typeof githubPluginSourceSchema>;

export interface GithubPluginAcquirer {
  withSource<T>(
    source: GithubPluginSource,
    use: (directory: string, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export interface GithubPluginAcquirerOptions {
  readonly directory: string;
  readonly fetch?: typeof globalThis.fetch;
}
