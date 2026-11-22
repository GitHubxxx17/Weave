import { z } from 'zod';
import { runtimeApiUrl } from '../runtime/runtime-bridge.js';
import { PluginApiError } from './plugin-api.js';
import {
  githubManagedPreviewSchema,
  githubPluginSourceInputSchema,
  managedCatalogSchema,
  managedHeadSchema,
  managedIssueSchema,
  managedMutationResponseSchema,
  managedPreviewSchema,
  type ManagedCatalog,
  type GithubManagedPreview,
  type ManagedCatalogObservation,
  type ManagedMutationResponse,
  type ManagedPlugin,
  type ManagedPreview,
  type ManagedReview,
  type PreparedManagedRequest,
} from './managed-plugin-types.js';

const managedPath = '/plugins/managed';
const errorResponseSchema = z.strictObject({ error: managedIssueSchema });
const errorStatuses: ReadonlyMap<string, number> = new Map([
  ['plugin-invalid-request', 400],
  ['plugin-artifact-invalid', 400],
  ['plugin-artifact-unsupported-file', 400],
  ['plugin-artifact-too-large', 400],
  ['plugin-github-invalid', 400],
  ['plugin-github-too-large', 400],
  ['plugin-github-unavailable', 502],
  ['plugin-github-rate-limited', 429],
  ['plugin-github-timeout', 504],
  ['forbidden-origin', 403],
  ['plugin-installer-disabled', 404],
  ['plugin-authority-not-found', 404],
  ['plugin-preview-stale', 409],
  ['plugin-authority-conflict', 409],
  ['plugin-authority-request-conflict', 409],
  ['plugin-authority-activation-required', 409],
  ['plugin-managed-id-conflict', 409],
  ['plugin-managed-namespace-unavailable', 409],
  ['plugin-managed-review-required', 409],
  ['plugin-artifact-unavailable', 409],
  ['plugin-artifact-capacity', 409],
  ['plugin-request-too-large', 413],
  ['unsupported-media-type', 415],
  ['plugin-preview-capacity', 429],
  ['plugin-management-failed', 500],
  ['plugin-authority-busy', 503],
  ['plugin-installer-unavailable', 503],
]);

function invalidResponse(): PluginApiError {
  return new PluginApiError('plugin-invalid-response', '插件响应的格式不正确', 200);
}

function requestFailed(status: number): PluginApiError {
  return new PluginApiError('plugin-request-failed', '插件请求失败', status);
}

function postJson(body: string): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
}

async function fetchResponse(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(url, signal === undefined ? init : { ...init, signal });
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    throw new PluginApiError('plugin-network', '无法连接到本地服务', 0);
  }
}

async function readJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error: unknown) {
    if (signal?.aborted) throw error;
    return undefined;
  }
}

function responseError(status: number, payload: unknown): PluginApiError {
  const parsed = errorResponseSchema.safeParse(payload);
  if (parsed.success && errorStatuses.get(parsed.data.error.code) === status) {
    const { code, message } = parsed.data.error;
    return new PluginApiError(code, message, status);
  }
  return requestFailed(status);
}

function parseSuccess<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

async function decodeResponse<T>(
  response: Response,
  schema: z.ZodType<T>,
  signal?: AbortSignal,
): Promise<T> {
  const payload = await readJson(response, signal);
  if (response.status !== 200) throw responseError(response.status, payload);
  return parseSuccess(schema, payload);
}

export async function fetchManagedCatalog(
  signal?: AbortSignal,
): Promise<ManagedCatalogObservation> {
  const response = await fetchResponse(runtimeApiUrl(managedPath), { method: 'GET' }, signal);
  const mediaType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (response.status === 404 && mediaType === 'text/plain') {
    let text: string;
    try {
      text = await response.text();
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      throw requestFailed(response.status);
    }
    if (text === '404 Not Found') return { kind: 'legacy' };
    throw requestFailed(response.status);
  }
  const payload = await readJson(response, signal);
  if (response.status === 200) {
    return { kind: 'enabled', catalog: parseSuccess(managedCatalogSchema, payload) };
  }
  const error = responseError(response.status, payload);
  if (error.code === 'plugin-installer-disabled') return { kind: 'disabled' };
  throw error;
}

export async function previewManagedPlugin(
  sourceDirectory: string,
  signal?: AbortSignal,
): Promise<ManagedPreview> {
  const response = await fetchResponse(
    runtimeApiUrl(`${managedPath}/preview`),
    postJson(JSON.stringify({ sourceDirectory })),
    signal,
  );
  return decodeResponse(response, managedPreviewSchema, signal);
}

export async function previewGithubManagedPlugin(
  source: unknown,
  signal?: AbortSignal,
): Promise<GithubManagedPreview> {
  const parsed = githubPluginSourceInputSchema.safeParse(source);
  if (!parsed.success)
    throw new PluginApiError(
      'plugin-github-invalid',
      '请输入有效的 GitHub 仓库、完整提交和子目录',
      0,
    );
  const github = parsed.data;
  const response = await fetchResponse(
    runtimeApiUrl(`${managedPath}/github/preview`),
    postJson(JSON.stringify(github)),
    signal,
  );
  const preview = await decodeResponse(response, githubManagedPreviewSchema, signal);
  if (
    preview.github.repository !== github.repository ||
    preview.github.commit !== github.commit ||
    preview.github.subdirectory !== github.subdirectory
  )
    throw invalidResponse();
  return preview;
}

function expectedHead(value: number): number {
  const parsed = managedHeadSchema.safeParse(value);
  if (!parsed.success) {
    throw new PluginApiError('plugin-invalid-request', '受管插件请求的序号无效', 0);
  }
  return parsed.data;
}

function prepare(
  requestId: string,
  pluginId: string,
  target: PreparedManagedRequest['target'],
  fields: object,
): PreparedManagedRequest {
  const route =
    target.kind === 'import' ? '/import' : `/${encodeURIComponent(pluginId)}/${target.kind}`;
  return Object.freeze({
    url: runtimeApiUrl(managedPath + route),
    body: JSON.stringify({ requestId, ...fields }),
    requestId,
    pluginId,
    target: Object.freeze(target),
  });
}

export function prepareManagedRequest(
  review: ManagedReview,
  requestId: string,
): PreparedManagedRequest {
  if (review.kind === 'import') {
    const { candidate, previewId, expectedInstallSequence } = review.preview;
    return prepare(
      requestId,
      candidate.manifest.id,
      { kind: 'import', digest: candidate.digest },
      {
        previewId,
        expectedInstallSequence: expectedHead(expectedInstallSequence),
      },
    );
  }
  const { kind, pluginId } = review;
  const expectations = {
    expectedInstallSequence: expectedHead(review.expectedInstallSequence),
    expectedTrustSequence: expectedHead(review.expectedTrustSequence),
  };
  switch (kind) {
    case 'activate': {
      const { digest, manifest, previousSelection, intent } = review;
      return prepare(
        requestId,
        pluginId,
        { kind, digest, intent },
        {
          digest,
          manifest,
          previousSelection,
          ...expectations,
          intent,
        },
      );
    }
    case 'enable':
      return prepare(
        requestId,
        pluginId,
        { kind, digest: review.selectedDigest },
        {
          selectedDigest: review.selectedDigest,
          ...expectations,
        },
      );
    case 'disable':
    case 'revoke':
    case 'uninstall': {
      const { selectedDigest, immediate } = review;
      return prepare(
        requestId,
        pluginId,
        { kind, digest: selectedDigest, immediate },
        {
          selectedDigest,
          ...expectations,
          immediate,
        },
      );
    }
  }
}

function sameTarget(
  left: PreparedManagedRequest['target'],
  right: PreparedManagedRequest['target'],
): boolean {
  if (left.kind !== right.kind || left.digest !== right.digest) return false;
  if ('intent' in left) return 'intent' in right && left.intent === right.intent;
  if ('immediate' in left) return 'immediate' in right && left.immediate === right.immediate;
  return true;
}

function sameGeneration(
  left: ManagedCatalog['generation'],
  right: ManagedCatalog['generation'],
): boolean {
  return (
    left.id === right.id &&
    left.acceptingRuns === right.acceptingRuns &&
    left.blocked?.code === right.blocked?.code &&
    left.blocked?.message === right.blocked?.message
  );
}

function sameActive(left: ManagedPlugin['active'], right: ManagedPlugin['active']): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.pluginId === right.pluginId &&
    left.digest === right.digest &&
    left.version === right.version &&
    left.activationSequence === right.activationSequence
  );
}

export async function sendManagedRequest(
  request: PreparedManagedRequest,
): Promise<ManagedMutationResponse> {
  const response = await fetchResponse(request.url, postJson(request.body));
  const receipt = await decodeResponse(response, managedMutationResponseSchema);
  const { decision, current } = receipt;
  if (
    decision.requestId !== request.requestId ||
    decision.pluginId !== request.pluginId ||
    !sameTarget(decision.target, request.target)
  ) {
    throw invalidResponse();
  }
  if (receipt.kind === 'committed') {
    const active =
      current.plugins.find(({ pluginId }) => pluginId === decision.pluginId)?.active ?? null;
    if (
      !sameGeneration(receipt.application.generation, current.generation) ||
      !sameActive(receipt.application.active, active)
    ) {
      throw invalidResponse();
    }
  }
  return receipt;
}
