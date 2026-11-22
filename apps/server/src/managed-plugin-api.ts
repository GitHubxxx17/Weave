import {
  ExplicitLocalAuthorityError,
  PluginArtifactError,
  PluginHostError,
} from '@weave/plugin-host';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { ManagedCommitFailure } from './managed-command-commit.js';
import {
  importPreviewResponseSchema,
  projectManagedCatalog,
  projectManagedMutation,
} from './managed-plugin-catalog.js';
import { ManagedInstallerError } from './managed-plugin-installer-errors.js';
import type { ManagedPluginInstaller } from './managed-plugin-installer.js';
import {
  artifactManifestSchema,
  digestSchema,
  headSchema,
  intentSchema,
  managedRequestSchema,
  opaqueIdSchema,
  pluginIdSchema,
  PluginAuthorityError,
} from './plugin-authority-types.js';
import { pluginErrorResponseSchema } from './plugin-management-types.js';
import {
  absoluteStorePathSchema,
  PluginStoreOwnershipError,
} from './plugin-store-ownership-types.js';

const previewBody = z.strictObject({ sourceDirectory: absoluteStorePathSchema });
const importBody = z.strictObject({
  requestId: opaqueIdSchema,
  previewId: opaqueIdSchema,
  expectedInstallSequence: headSchema,
});
const selectionFields = {
  requestId: opaqueIdSchema,
  expectedInstallSequence: headSchema,
  expectedTrustSequence: headSchema,
};
const activateBody = z.strictObject({
  ...selectionFields,
  digest: digestSchema,
  manifest: artifactManifestSchema,
  previousSelection: digestSchema.nullable(),
  intent: intentSchema,
});
const enableBody = z.strictObject({ ...selectionFields, selectedDigest: digestSchema });
const destructiveBody = z.strictObject({
  ...selectionFields,
  selectedDigest: digestSchema.nullable(),
  immediate: z.boolean().optional(),
});

const issues = {
  'plugin-invalid-request': [400, 'Invalid managed plugin request.'],
  'plugin-artifact-invalid': [
    400,
    'The directory does not contain a valid compatible bundled plugin.',
  ],
  'plugin-artifact-unsupported-file': [
    400,
    'Plugin payloads require regular files and real directories.',
  ],
  'plugin-artifact-too-large': [400, 'The plugin exceeds the artifact size or traversal limits.'],
  'plugin-installer-disabled': [404, 'Managed plugin installation is unavailable.'],
  'plugin-authority-not-found': [404, 'The managed plugin or candidate was not found.'],
  'plugin-preview-stale': [409, 'Review the current plugin directory before importing it.'],
  'plugin-authority-conflict': [409, 'Plugin authority changed. Review the current state.'],
  'plugin-authority-request-conflict': [
    409,
    'The request ID is already associated with a different decision.',
  ],
  'plugin-authority-activation-required': [409, 'Activate the selected plugin before enabling it.'],
  'plugin-managed-id-conflict': [409, 'The plugin ID is unavailable for managed installation.'],
  'plugin-managed-namespace-unavailable': [
    409,
    'The current plugin namespace could not be verified.',
  ],
  'plugin-artifact-unavailable': [409, 'The plugin artifact could not be verified.'],
  'plugin-artifact-capacity': [
    409,
    'The artifact store is full. Existing artifacts are retained and exact matches can be reused.',
  ],
  'plugin-request-too-large': [413, 'The managed plugin request exceeds 256 KiB.'],
  'plugin-preview-capacity': [429, 'Preview capacity has been reached. Retry later.'],
  'plugin-authority-busy': [503, 'Plugin authority is temporarily busy.'],
  'plugin-installer-unavailable': [503, 'The managed plugin store is currently unavailable.'],
  'plugin-management-failed': [500, 'Managed plugin management failed.'],
} as const;

function ownershipUnavailable(error: unknown): boolean {
  return (
    error instanceof PluginStoreOwnershipError &&
    (error.code === 'plugin-store-ownership-lost' || error.code === 'plugin-store-closed')
  );
}

function publicCode(failure: unknown): keyof typeof issues {
  const error = failure instanceof ManagedCommitFailure ? failure.cause : failure;
  if (error instanceof ManagedInstallerError && Object.hasOwn(issues, error.code)) {
    return error.code;
  }
  if (error instanceof PluginArtifactError) {
    switch (error.code) {
      case 'plugin-artifact-invalid':
      case 'plugin-artifact-unsupported-file':
      case 'plugin-artifact-too-large':
      case 'plugin-artifact-capacity':
        return error.code;
      case 'plugin-artifact-source-changed':
        return 'plugin-preview-stale';
      case 'plugin-artifact-conflict':
      case 'plugin-artifact-not-found':
      case 'plugin-artifact-corrupt':
        return 'plugin-artifact-unavailable';
    }
  }
  if (error instanceof PluginAuthorityError) {
    switch (error.code) {
      case 'plugin-authority-not-found':
      case 'plugin-authority-conflict':
      case 'plugin-authority-request-conflict':
      case 'plugin-authority-activation-required':
      case 'plugin-authority-busy':
        return error.code;
      case 'plugin-authority-invalid':
        return 'plugin-invalid-request';
      case 'plugin-authority-closed':
        return 'plugin-installer-unavailable';
    }
  }
  const ownershipCause = error instanceof ExplicitLocalAuthorityError ? error.cause : error;
  if (
    ownershipUnavailable(ownershipCause) ||
    (error instanceof ExplicitLocalAuthorityError &&
      ownershipCause instanceof AggregateError &&
      ownershipUnavailable(ownershipCause.cause)) ||
    (error instanceof PluginHostError && error.code === 'plugin-host-disposed') ||
    (error instanceof DOMException && error.name === 'AbortError')
  ) {
    return 'plugin-installer-unavailable';
  }
  return 'plugin-management-failed';
}

function respondError(context: Context, error: unknown): Response {
  const code = publicCode(error);
  const [status, message] = issues[code];
  return context.json(pluginErrorResponseSchema.parse({ error: { code, message } }), status);
}

function readStatic<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ManagedInstallerError('plugin-invalid-request', { cause: parsed.error });
  }
  return parsed.data;
}

const maxBodyBytes = 256 * 1024;

async function readBody(request: Request): Promise<unknown> {
  const body = new Uint8Array(maxBodyBytes);
  let size = 0;
  const reader = request.body?.getReader();
  try {
    if (reader !== undefined) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.byteLength > body.byteLength - size) {
          void reader.cancel().catch(() => undefined);
          throw new ManagedInstallerError('plugin-request-too-large');
        }
        body.set(value, size);
        size += value.byteLength;
      }
    }
  } catch (error: unknown) {
    if (request.signal.aborted && Object.is(error, request.signal.reason)) {
      throw new ManagedInstallerError('plugin-installer-unavailable', { cause: error });
    }
    throw error;
  } finally {
    reader?.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder().decode(body.subarray(0, size))) as unknown;
  } catch (cause: unknown) {
    throw new ManagedInstallerError('plugin-invalid-request', { cause });
  }
}

const managedPath = '/plugins/managed';

export function registerManagedPluginRoutes(
  app: Hono,
  installer: ManagedPluginInstaller | undefined,
): void {
  function installed(): ManagedPluginInstaller {
    if (installer === undefined) throw new ManagedInstallerError('plugin-installer-disabled');
    return installer;
  }

  app.get(managedPath, (context) => {
    try {
      const { authority, observed } = installed().snapshot();
      return context.json(projectManagedCatalog(authority, observed));
    } catch (error: unknown) {
      return respondError(context, error);
    }
  });

  function write<T>(
    path: string,
    operation: (context: Context, body: unknown, signal: AbortSignal) => Promise<T>,
  ): void {
    app.post(managedPath + path, async (context) => {
      try {
        const request = context.req.raw;
        if (new URL(request.url).searchParams.size !== 0) {
          throw new ManagedInstallerError('plugin-invalid-request');
        }
        const body = await readBody(request);
        return context.json(await operation(context, body, request.signal));
      } catch (error: unknown) {
        return respondError(context, error);
      }
    });
  }

  write('/preview', async (_context, body, signal) => {
    const { sourceDirectory } = readStatic(previewBody, body);
    const { previewId, expiresAt, expectedInstallSequence, candidate } = await installed().preview(
      sourceDirectory,
      signal,
    );
    const { digest, manifest, files, bytes } = candidate;
    return importPreviewResponseSchema.parse({
      previewId,
      expiresAt,
      expectedInstallSequence,
      candidate: { digest, manifest, files, bytes },
    });
  });

  write('/import', async (_context, body, signal) => {
    const { requestId, ...fields } = readStatic(importBody, body);
    const result = await installed().import(
      { requestId, command: { kind: 'import', ...fields } },
      signal,
    );
    return projectManagedMutation(result);
  });

  for (const kind of ['activate', 'enable', 'disable', 'revoke', 'uninstall'] as const) {
    const schema =
      kind === 'activate' ? activateBody : kind === 'enable' ? enableBody : destructiveBody;
    write('/:id/' + kind, async (context, body, signal) => {
      const pluginId = readStatic(pluginIdSchema, context.req.param('id'));
      const { requestId, ...fields } = readStatic<z.infer<typeof schema>>(schema, body);
      const { command } = readStatic(managedRequestSchema, {
        requestId,
        command: { kind, pluginId, ...fields },
      });
      if (command.kind === 'import') throw new Error('Expected a managed selection command');
      const result = await installed().applySelection({ requestId, command }, signal);
      return projectManagedMutation(result);
    });
  }
}
