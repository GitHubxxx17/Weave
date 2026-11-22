import fs from 'node:fs/promises';
import { join, sep } from 'node:path';
import { computeDirectoryDigest } from '@weave/plugin-host';
import type { WeavePlugin } from '@weave/plugin';
import { createSqliteSessionEventStore } from '@weave/session';
import { afterEach, describe, expect, it, vi, type Mock, type MockInstance } from 'vitest';
import { z } from 'zod';
import type { StartServerOptions } from '../src/main.js';
import {
  type ImportPreviewResponse,
  type ManagedMutationResponse,
} from '../src/managed-plugin-catalog.js';
import { createSqliteMcpAuthorityStore } from '../src/mcp-authority-store.js';
import { mcpMutationResultSchema } from '../src/mcp-management-types.js';
import {
  openOwnedPluginArtifactStore,
  type OwnedPluginArtifactStore,
} from '../src/owned-plugin-artifact-store.js';
import { createSqlitePluginAuthorityDatabase } from '../src/plugin-authority-store.js';
import type {
  ManagedRequest,
  PluginAuthorityDatabase,
  PluginAuthoritySnapshot,
} from '../src/plugin-authority-types.js';
import { pluginMutationResponseSchema } from '../src/plugin-catalog.js';
import { getServerSessionStore } from '../src/runtime.js';
import {
  createFixtureMcpConfig,
  runFixtureTools,
  writeFixturePlugin,
} from './support/managed-plugin-composition-fixture.js';
import { activateInput, decisionInput } from './support/plugin-authority-fixtures.js';
import {
  createInstallerHttpFixture,
  importBody,
  importPath,
  importRequest,
  managed,
  openPost,
  pending,
  selectionBody,
  within,
  type Running,
} from './support/managed-plugin-installer-http-fixture.js';

vi.mock(import('../src/owned-plugin-artifact-store.js'), async (original) => {
  const actual = await original();
  return { ...actual, openOwnedPluginArtifactStore: vi.fn(actual.openOwnedPluginArtifactStore) };
});

const setupFailure = 'private fixture setup exception';
const publicationFailure = 'private fixture publication exception';
const releaseFailure = 'private fixture release failure';
type Committed = Extract<ManagedMutationResponse, { kind: 'committed' }>;

function activation(
  requestId: string,
  snapshot: PluginAuthoritySnapshot,
  preview: ImportPreviewResponse,
  intent?: 'rollback',
) {
  const { candidate } = preview;
  return activateInput(
    requestId,
    snapshot,
    { ...candidate, pluginId: candidate.manifest.id },
    intent,
  ).request;
}

function gate() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: release.resolve,
    async hold() {
      entered.resolve();
      await release.promise;
    },
  };
}

function holdDirectory(directory: string, barrier: ReturnType<typeof gate>) {
  const opendir = fs.opendir;
  let armed = true;
  return vi.spyOn(fs, 'opendir').mockImplementation(async (path, options) => {
    if (armed && path === directory) {
      armed = false;
      await barrier.hold();
    }
    return opendir(path, options);
  });
}

function expectIssue(body: unknown, code: string, message?: string) {
  expect(body).toEqual({ error: { code, message: message ?? expect.any(String) } });
}

function expectCommitted(
  response: ManagedMutationResponse,
  status: Committed['application']['status'],
): Committed {
  expect(response).toMatchObject({ kind: 'committed', application: { status } });
  if (response.kind !== 'committed') throw new Error('Expected a fresh decision');
  return response;
}

function expectReplay(response: ManagedMutationResponse, original: ManagedMutationResponse) {
  expect(response).toMatchObject({
    kind: 'replayed',
    decision: original.decision,
    application: { status: 'unknown' },
  });
}

function expectRecorded(
  snapshot: PluginAuthoritySnapshot,
  request: ManagedRequest,
  result: ManagedMutationResponse,
) {
  const { decision } = result;
  const operation = snapshot.operationEvents.find((event) => event.requestId === request.requestId);
  expect(operation).toMatchObject({
    requestId: request.requestId,
    command: request.command,
    sequence: decision.operationSequence,
    occurredAt: decision.occurredAt,
    decision: {
      changed: decision.changed,
      after: { installSequence: decision.installSequence, trustSequence: decision.trustSequence },
      links: {
        installEventSequence: decision.installEventSequence,
        trustEventSequence: decision.trustEventSequence,
      },
    },
  });
  if (decision.installEventSequence !== null) {
    expect(
      snapshot.installEvents.find(({ sequence }) => sequence === decision.installEventSequence),
    ).toMatchObject({
      operationSequence: decision.operationSequence,
      pluginId: decision.pluginId,
    });
  }
  if (decision.trustEventSequence !== null) {
    expect(
      snapshot.trustEvents.find(({ sequence }) => sequence === decision.trustEventSequence),
    ).toMatchObject({
      pluginId: decision.pluginId,
    });
  }
}

function expectActive(result: Committed, preview: ImportPreviewResponse) {
  const { decision, application, current } = result;
  const member = {
    pluginId: preview.candidate.manifest.id,
    digest: preview.candidate.digest,
    version: preview.candidate.manifest.version,
    activationSequence: decision.selection?.activationSequence,
  };
  expect(member.activationSequence).toBeGreaterThan(0);
  expect(application.active).toEqual(member);
  expect(current.plugins.find(({ pluginId }) => pluginId === member.pluginId)?.active).toEqual(
    member,
  );
  expect(application.generation).toEqual(current.generation);
  expect(current.generation.acceptingRuns).toBe(true);
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  const failures: unknown[] = [];
  try {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    vi.restoreAllMocks();
  }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Installer integration cleanup failed');
});

function fixture() {
  return createInstallerHttpFixture(cleanups, [setupFailure, publicationFailure, releaseFailure]);
}

function turnGate() {
  function arm() {
    const gate = {
      entered: Promise.withResolvers<AbortSignal>(),
      release: Promise.withResolvers<void>(),
      abort: vi.fn<() => void>(),
    };
    pending = gate;
    return { entered: gate.entered.promise, release: gate.release.resolve, abort: gate.abort };
  }
  let pending:
    | {
        entered: PromiseWithResolvers<AbortSignal>;
        release: PromiseWithResolvers<void>;
        abort: Mock<() => void>;
      }
    | undefined;
  const plugin: WeavePlugin = {
    manifest: {
      id: 'installer-turn-gate',
      name: 'Installer turn gate',
      version: '1.0.0',
      apiVersion: '1.0.0',
      capabilities: ['tool'],
    },
    setup(context) {
      context.registerTool({
        name: 'fixture_gate',
        description: 'Wait for the test to release this turn',
        parameters: { type: 'object' },
        inputSchema: z.object({}),
        async execute(_input, { signal }) {
          if (pending === undefined || signal === undefined)
            throw new Error('Expected an armed turn gate');
          const { entered, release, abort } = pending;
          pending = undefined;
          const cancelled = Promise.withResolvers<void>();
          const onAbort = () => {
            abort();
            cancelled.resolve();
          };
          signal.addEventListener('abort', onAbort, { once: true });
          entered.resolve(signal);
          try {
            await Promise.race([release.promise, cancelled.promise]);
            return 'released';
          } finally {
            signal.removeEventListener('abort', onAbort);
          }
        },
      });
    },
  };
  return { plugin, arm };
}

function expectToolValue(events: Awaited<ReturnType<typeof runFixtureTools>>, content: string) {
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool-result',
      result: expect.objectContaining({ content }),
    }),
  );
}

async function flushInstallerQueue(f: Awaited<ReturnType<typeof fixture>>) {
  expectIssue(
    await f.http(
      importPath,
      {
        requestId: 'queue-fence',
        previewId: 'unused-queue-fence',
        expectedInstallSequence: 0,
      },
      409,
    ),
    'plugin-preview-stale',
  );
}

async function watchOwnedStore(
  wrap: (
    store: OwnedPluginArtifactStore,
    input: Parameters<typeof openOwnedPluginArtifactStore>[0],
  ) => OwnedPluginArtifactStore,
) {
  const actual = await vi.importActual<typeof import('../src/owned-plugin-artifact-store.js')>(
    '../src/owned-plugin-artifact-store.js',
  );
  vi.mocked(openOwnedPluginArtifactStore).mockImplementationOnce(async (input) =>
    wrap(await actual.openOwnedPluginArtifactStore(input), input),
  );
}

describe('owned managed installer over HTTP', () => {
  it('leaves a healthy active Generation intact and replays the exact concurrent import after restart', async () => {
    const f = await fixture();
    await f.startUnbound();
    const healthy = await f.source('healthy', 'healthy published tool');
    const healthyReview = await f.preview(healthy.directory);
    await f.import(importBody('healthy-import', healthyReview));
    const healthyActive = expectCommitted(
      await f.select(activation('healthy-activate', f.snapshot(), healthyReview)),
      'applied',
    );
    expectActive(healthyActive, healthyReview);
    const initial = await f.catalog();
    const marker = join(f.root, 'private-module-marker');
    const external = await f.source('notes', 'unselected', { marker });
    const stale = await f.preview(external.directory);
    const existingDigests = await fs.readdir(f.artifacts);
    await fs.appendFile(join(external.directory, 'index.mjs'), '\n// changed after review');
    const staleBody = importBody('changed-source', stale);
    expectIssue(await f.http(`${managed}/import`, staleBody, 409), 'plugin-preview-stale');
    expect(await fs.readdir(f.artifacts)).toEqual(existingDigests);
    expect(f.authority().lookupSync(importRequest(staleBody))).toEqual({ kind: 'absent' });

    const preview = await f.preview(external.directory);
    const competingToken = await f.preview(external.directory);
    const original = importBody('concurrent-import', preview);
    const responses = await Promise.all([f.import(original), f.import(original)]);
    expect(responses.map(({ kind }) => kind).sort()).toEqual(['committed', 'replayed']);
    const first = expectCommitted(
      responses.find(({ kind }) => kind === 'committed')!,
      'not-required',
    );
    expectReplay(
      responses.find(({ kind }) => kind === 'replayed')!,
      first,
    );
    expect(first.application).toEqual({
      status: 'not-required',
      generation: initial.generation,
      active: null,
    });
    expect(first.current.generation).toEqual(initial.generation);
    expect(first.current.plugins[0]).toEqual(initial.plugins[0]);
    expect(first.current.plugins[1]).toMatchObject({
      pluginId: 'notes',
      selection: null,
      trust: null,
      active: null,
    });
    expect(first.decision).toMatchObject({
      changed: true,
      operationSequence: initial.heads.operationSequence + 1,
      installEventSequence: initial.heads.installSequence + 1,
      trustSequence: initial.heads.trustSequence,
      trustEventSequence: null,
    });
    expectRecorded(f.snapshot(), importRequest(original), first);
    expect(f.snapshot().installEvents.at(-1)).toMatchObject({
      digest: preview.candidate.digest,
      provenance: { kind: 'local-directory', sourceDirectory: external.directory },
    });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expectToolValue(await f.run('healthy', 'healthy-after-import'), 'healthy published tool');

    expectIssue(
      await f.http(`${managed}/import`, importBody(original.requestId, competingToken), 409),
      'plugin-authority-request-conflict',
    );
    const staleHead = importBody('stale-import-head', competingToken);
    expectIssue(await f.http(importPath, staleHead, 409), 'plugin-preview-stale');
    expect(f.authority().lookupSync(importRequest(staleHead))).toEqual({ kind: 'absent' });
    expectIssue(
      await f.http('/plugins/notes/trust', { digest: preview.candidate.digest }, 409),
      'plugin-managed-review-required',
    );
    const duplicate = importBody('fresh-duplicate', await f.preview(external.directory));
    const noOp = expectCommitted(await f.import(duplicate), 'not-required');
    expect(noOp.decision).toMatchObject({
      changed: false,
      operationSequence: first.decision.operationSequence + 1,
      installSequence: first.decision.installSequence,
      trustSequence: first.decision.trustSequence,
      installEventSequence: null,
      trustEventSequence: null,
    });
    expectRecorded(f.snapshot(), importRequest(duplicate), noOp);
    expect(noOp.current.generation).toEqual(initial.generation);
    const unused = importBody('unused-after-restart', await f.preview(external.directory));
    const beforeRestart = f.snapshot().heads;
    await f.stop();
    await fs.rm(external.directory, { recursive: true });
    await fs.writeFile(
      join(f.artifacts, preview.candidate.digest, 'payload', 'index.mjs'),
      '// corrupt retained object',
    );
    await f.start();

    const replay = await f.import(original);
    expectReplay(replay, first);
    expect(replay.current.heads).toEqual(beforeRestart);
    expect(replay.current.plugins[0]?.active).toEqual(healthyActive.application.active);
    expectReplay(await f.import(duplicate), noOp);
    expectIssue(await f.http(`${managed}/import`, unused, 409), 'plugin-preview-stale');
    expect(f.authority().lookupSync(importRequest(unused))).toEqual({ kind: 'absent' });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes exact selection identities, preserves pinned files and records reviewed destructive decisions', async () => {
    const f = await fixture();
    const turns = turnGate();
    await f.startUnbound({ plugins: [turns.plugin] });
    const v1Source = await f.source('notes', 'v1 relative payload', { relativePayload: true });
    const v2Source = await f.source('notes', 'v2 relative payload', {
      relativePayload: true,
      version: '2.0.0',
    });
    const v1 = await f.preview(v1Source.directory);
    await f.import(importBody('notes-import-v1', v1));
    const v2 = await f.preview(v2Source.directory);
    await f.import(importBody('notes-import-v2', v2));
    expect(v1.candidate.digest).not.toBe(v2.candidate.digest);

    async function apply(request: ManagedRequest, links: { install: boolean; trust: boolean }) {
      const before = f.snapshot().heads;
      const result = expectCommitted(await f.select(request), 'applied');
      const install = before.installSequence + Number(links.install);
      const trust = before.trustSequence + Number(links.trust);
      expect(result.decision).toMatchObject({
        changed: links.install || links.trust,
        operationSequence: before.operationSequence + 1,
        installSequence: install,
        trustSequence: trust,
        installEventSequence: links.install ? install : null,
        trustEventSequence: links.trust ? trust : null,
      });
      const after = f.snapshot();
      expect(after.heads).toEqual(result.current.heads);
      expectRecorded(after, request, result);
      if (request.command.kind === 'activate') {
        expect(after.installEvents.at(-1)).toMatchObject({
          kind: 'activated',
          trustEventSequence: trust,
        });
      } else if (request.command.kind === 'uninstall') {
        expect(after.installEvents.at(-1)).toMatchObject({
          kind: 'uninstalled',
          trustEventSequence: trust,
        });
      }
      return result;
    }

    const activeV1 = await apply(activation('activate-v1', f.snapshot(), v1), {
      install: true,
      trust: true,
    });
    expectActive(activeV1, v1);
    const pin = turns.arm();
    const oldTurn = pending(f.run(['fixture_gate', 'notes'], 'turn-on-v1'));
    try {
      const signal = await within(pin.entered, 'turn pinned to v1');
      const v2Request = activation('activate-v2', f.snapshot(), v2);
      const stale = selectionBody({ ...v2Request, requestId: 'stale-activation' });
      const activeV2 = await apply(v2Request, { install: true, trust: true });
      expectActive(activeV2, v2);
      expect(activeV2.application.generation.id).not.toBe(activeV1.application.generation.id);
      expect(signal.aborted).toBe(false);
      expectIssue(await f.http(stale.path, stale.body, 409), 'plugin-authority-conflict');
      expect(f.snapshot().heads).toEqual(activeV2.current.heads);
      expectToolValue(await f.run('notes', 'turn-on-v2'), 'v2 relative payload');
      pin.release();
      expectToolValue(await oldTurn, 'v1 relative payload');
    } finally {
      pin.release();
      await Promise.allSettled([oldTurn]);
    }

    const rollback = await apply(activation('rollback-v1', f.snapshot(), v1, 'rollback'), {
      install: true,
      trust: true,
    });
    expectActive(rollback, v1);
    expect(rollback.decision.target).toEqual({
      kind: 'activate',
      intent: 'rollback',
      digest: v1.candidate.digest,
    });
    expect(rollback.decision.selection?.activationSequence).toBe(
      rollback.decision.installEventSequence,
    );
    expect(rollback.decision.selection?.activationSequence).toBeGreaterThan(
      activeV1.decision.selection!.activationSequence,
    );
    const disabled = await apply(decisionInput('disable', 'disable-exact', f.snapshot()).request, {
      install: false,
      trust: true,
    });
    expect(disabled.application.active).toBeNull();
    expect(disabled.decision.trust).toEqual({ digest: v1.candidate.digest, enabled: false });
    const enabled = await apply(decisionInput('enable', 'enable-exact', f.snapshot()).request, {
      install: false,
      trust: true,
    });
    expectActive(enabled, v1);
    expect(enabled.decision.selection).toEqual(rollback.decision.selection);
    expect(enabled.decision.trust).toEqual({ digest: v1.candidate.digest, enabled: true });

    const missing = join(f.artifacts, v1.candidate.digest, 'payload', 'payload.txt');
    await fs.unlink(missing);
    const revoked = await apply(decisionInput('revoke', 'revoke-missing', f.snapshot()).request, {
      install: false,
      trust: true,
    });
    expect(revoked.application.active).toBeNull();
    expect(revoked.decision.selection).toEqual(rollback.decision.selection);
    expect(revoked.decision.trust).toBeNull();
    const forbidden = selectionBody(
      decisionInput('enable', 'enable-revoked', f.snapshot()).request,
    );
    expectIssue(
      await f.http(forbidden.path, forbidden.body, 409),
      'plugin-authority-activation-required',
    );
    expect(f.snapshot().heads).toEqual(revoked.current.heads);
    const removed = await apply(
      decisionInput('uninstall', 'uninstall-missing', f.snapshot()).request,
      { install: true, trust: true },
    );
    expect(removed.application.active).toBeNull();
    expect(removed.decision.selection).toBeNull();
    expect(removed.decision.trust).toBeNull();
    expect(removed.current.plugins[0]?.candidates.map(({ digest }) => digest)).toEqual([
      v1.candidate.digest,
      v2.candidate.digest,
    ]);
    await expect(
      fs.access(join(f.artifacts, v1.candidate.digest, 'payload', 'index.mjs')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(join(f.artifacts, v2.candidate.digest, 'payload', 'payload.txt')),
    ).resolves.toBeUndefined();
    expectIssue(
      await f.http('/plugins/notes/trust', { digest: v1.candidate.digest }, 409),
      'plugin-managed-review-required',
    );
  });

  it('cancels a retired pin once for a fresh immediate no-op while replay leaves later turns running', async () => {
    const f = await fixture();
    const turns = turnGate();
    const running = await f.startUnbound({ plugins: [turns.plugin] });
    const preview = await f.preview((await f.source()).directory);
    await f.import(importBody('immediate-import', preview));
    expectActive(
      expectCommitted(
        await f.select(activation('immediate-activate', f.snapshot(), preview)),
        'applied',
      ),
      preview,
    );
    const abort = vi.spyOn(running.runtime.serverHost.controller()!, 'abortActiveRuns');

    const retired = turns.arm();
    const oldTurn = pending(f.run(['fixture_gate', 'notes'], 'retired-immediate-pin'));
    const fresh = await (async () => {
      try {
        const signal = await within(retired.entered, 'retired-turn gate');
        const disable = decisionInput('disable', 'retire-without-immediate', f.snapshot()).request;
        const disabled = expectCommitted(await f.select(disable), 'applied');
        expect(disabled.application.active).toBeNull();
        expect(signal.aborted).toBe(false);
        expect(abort).not.toHaveBeenCalled();
        const command = decisionInput('disable', 'cancel-retired-turn', f.snapshot(), true).request;
        const result = expectCommitted(await f.select(command), 'applied');
        expect(result.decision).toMatchObject({
          changed: false,
          installEventSequence: null,
          trustEventSequence: null,
        });
        expect(result.decision.operationSequence).toBe(disabled.decision.operationSequence + 1);
        expectRecorded(f.snapshot(), command, result);
        await within(oldTurn, 'cancelled turn settlement');
        expect(retired.abort).toHaveBeenCalledOnce();
        expect(abort).toHaveBeenCalledOnce();
        expect(
          await getServerSessionStore(running.runtime).read('retired-immediate-pin'),
        ).toContainEqual(
          expect.objectContaining({
            type: 'turn.completed',
            payload: expect.objectContaining({ status: 'cancelled' }),
          }),
        );
        return { command, result };
      } finally {
        retired.release();
        await Promise.allSettled([oldTurn]);
      }
    })();

    const enable = decisionInput('enable', 're-enable-for-replay', f.snapshot()).request;
    expectActive(expectCommitted(await f.select(enable), 'applied'), preview);
    const later = turns.arm();
    const laterTurn = pending(f.run(['fixture_gate', 'notes'], 'later-immediate-pin'));
    try {
      const signal = await within(later.entered, 'turn pinned after re-enable');
      const current = await f.catalog();
      const replay = await f.select(fresh.command);
      expectReplay(replay, fresh.result);
      expect(replay.current).toEqual(current);
      expect(signal.aborted).toBe(false);
      expect(later.abort).not.toHaveBeenCalled();
      expect(abort).toHaveBeenCalledOnce();
      later.release();
      expectToolValue(await laterTurn, 'fixture value');
    } finally {
      later.release();
      await Promise.allSettled([laterTurn]);
    }
  });

  it('checks manual descriptor claims again after the reviewed stage begins', async () => {
    const f = await fixture();
    await f.startUnbound();
    const source = await f.source();
    const review = await f.preview(source.directory);
    const request = importBody('manually-claimed-during-stage', review);
    const stage = gate();
    const directorySpy = holdDirectory(source.directory, stage);
    const importing = pending(f.http(`${managed}/import`, request, 409));
    try {
      await within(stage.entered, 'reviewed stage to begin after first namespace observation');
      const declaration = join(f.pluginsDirectory, 'different-directory-name');
      await writeFixturePlugin(declaration, 'notes', 'manual claim');
      await fs.unlink(join(declaration, 'index.mjs'));
      stage.release();
      expectIssue(await importing, 'plugin-managed-id-conflict');
      expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
      await fs.rm(declaration, { recursive: true });
      expectIssue(await f.http(`${managed}/import`, request, 409), 'plugin-preview-stale');
      expectCommitted(
        await f.import(importBody('after-manual-claim', await f.preview(source.directory))),
        'not-required',
      );
    } finally {
      stage.release();
      await Promise.allSettled([importing]);
      directorySpy.mockRestore();
    }
  });

  it('reserves a manual ID while an old turn still holds its removed declaration', async () => {
    const f = await fixture();
    const turns = turnGate();
    const declaration = join(f.pluginsDirectory, 'notes');
    const manifest = await writeFixturePlugin(declaration, 'notes', 'retained manual tool');
    const { digest } = await computeDirectoryDigest(declaration);
    const seed = createSqlitePluginAuthorityDatabase({ filename: f.databaseFile });
    try {
      await seed.trust.append({ kind: 'trusted', pluginId: 'notes', digest, manifest });
    } finally {
      await seed.close();
    }
    await f.startUnbound({ plugins: [turns.plugin] });
    const source = await f.source();
    const pin = turns.arm();
    const oldTurn = pending(f.run(['fixture_gate', 'notes'], 'manual-old-generation'));
    try {
      const signal = await within(pin.entered, 'turn pinned with the manual member');
      const initial = await f.catalog();
      await fs.rm(declaration, { recursive: true });
      const reloaded = pluginMutationResponseSchema.parse(await f.http('/plugins/reload', {}));
      expect(reloaded.plugins.some(({ id }) => id === 'notes')).toBe(false);
      expect((await f.catalog()).generation.id).not.toBe(initial.generation.id);
      const request = importBody('while-manual-is-retained', await f.preview(source.directory));
      expectIssue(await f.http(`${managed}/import`, request, 409), 'plugin-managed-id-conflict');
      expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
      expect(signal.aborted).toBe(false);
      pin.release();
      expectToolValue(await oldTurn, 'retained manual tool');
      const result = expectCommitted(
        await f.import(importBody('after-manual-drain', await f.preview(source.directory))),
        'not-required',
      );
      expect(result.current.plugins[0]).toMatchObject({
        pluginId: 'notes',
        selection: null,
        trust: null,
      });
    } finally {
      pin.release();
      await Promise.allSettled([oldTurn]);
    }
  });

  it.each(['mcp-first', 'import-first'] as const)(
    'orders %s same-ID management with untrusted MCP',
    async (order) => {
      const f = await fixture();
      const mcpReader = createSqliteMcpAuthorityStore({ filename: f.databaseFile });
      cleanups.push(() => mcpReader.close());
      const connect = vi.fn<NonNullable<StartServerOptions['mcpConnect']>>();
      const running = await f.startUnbound({ mcpConnect: connect });
      const config = await createFixtureMcpConfig('notes', f.root, f.launchLog);
      const source = await f.source('mcp-notes');
      const request = importBody('import-versus-mcp', await f.preview(source.directory));
      const configure = { expectedSequence: 0, config };
      const stage = gate();
      let importing: Promise<unknown> | undefined;
      let configuring: Promise<unknown> | undefined;
      try {
        if (order === 'mcp-first') {
          const result = mcpMutationResultSchema.parse(await f.http('/mcp/servers', configure));
          expect(result.servers).toMatchObject([{ state: 'untrusted', enabled: false }]);
          expectIssue(
            await f.http(`${managed}/import`, request, 409),
            'plugin-managed-id-conflict',
          );
          expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
          expect((await mcpReader.read()).records).toMatchObject([
            {
              config,
              removed: false,
              enabled: false,
              trustState: 'untrusted',
            },
          ]);
        } else {
          holdDirectory(source.directory, stage);
          importing = pending(f.import(request));
          await within(stage.entered, 'first installer ticket to enter staging');
          const queued = Promise.withResolvers<void>();
          const manager = running.mcpManager!;
          const original = manager.configure;
          const configureSpy = vi.spyOn(manager, 'configure').mockImplementationOnce((...args) => {
            const result = original(...args);
            queued.resolve();
            return result;
          });
          configuring = pending(f.http('/mcp/servers', configure, 409));
          await within(queued.promise, 'MCP configure queued behind import');
          expect(configureSpy).toHaveBeenCalledOnce();
          expect((await mcpReader.read()).sequence).toBe(0);
          expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
          stage.release();
          await expect(importing).resolves.toMatchObject({
            kind: 'committed',
            application: { status: 'not-required' },
          });
          expectIssue(await configuring, 'mcp-conflict');
          expect((await mcpReader.read()).sequence).toBe(0);
          expect(f.authority().lookupSync(importRequest(request)).kind).toBe('replayed');
        }
        expect(connect).not.toHaveBeenCalled();
        await expect(fs.access(f.launchLog)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        stage.release();
        await Promise.allSettled([importing, configuring]);
      }
    },
  );

  it('treats a trusted but disabled MCP declaration as a claim after restart', async () => {
    const f = await fixture();
    const seed = createSqliteMcpAuthorityStore({ filename: f.databaseFile });
    try {
      const config = await createFixtureMcpConfig('notes', f.root, f.launchLog);
      const configured = await seed.mutate(
        { kind: 'create', config },
        { expectedSequence: 0, knownPrefix: [] },
      );
      const configDigest = configured.records[0]!.configDigest;
      const trusted = await seed.mutate(
        { kind: 'trust', serverId: 'notes', configDigest },
        {
          expectedSequence: configured.sequence,
          knownPrefix: configured.events,
        },
      );
      const disabled = await seed.mutate(
        { kind: 'disable', serverId: 'notes' },
        {
          expectedSequence: trusted.sequence,
          knownPrefix: trusted.events,
        },
      );
      expect(disabled.records).toMatchObject([
        { enabled: false, trustState: 'trusted', removed: false },
      ]);
    } finally {
      await seed.close();
    }
    const connect = vi.fn<NonNullable<StartServerOptions['mcpConnect']>>();
    await f.startUnbound({ mcpConnect: connect });
    await f.stop();
    await f.start({ mcpConnect: connect });
    const source = await f.source('mcp-notes');
    const request = importBody('disabled-mcp-claim', await f.preview(source.directory));
    expectIssue(await f.http(`${managed}/import`, request, 409), 'plugin-managed-id-conflict');
    expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
    expect(connect).not.toHaveBeenCalled();
  });

  it('captures an isolated setup failure with the target missing from the compliant Generation', async () => {
    const f = await fixture();
    await f.startUnbound();
    const marker = join(f.root, 'private-setup-marker');
    const source = await f.source('notes', 'unavailable tool', {
      marker,
      setupError: setupFailure,
    });
    const preview = await f.preview(source.directory);
    await f.import(importBody('setup-failure-import', preview));
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const request = activation('setup-failure-activate', f.snapshot(), preview);
    const result = expectCommitted(await f.select(request), 'failed');
    expect(result.application).toEqual({
      status: 'failed',
      issue: { code: 'plugin-load-failed', message: 'Managed plugin preparation failed' },
      generation: result.current.generation,
      active: null,
    });
    expect(result.current.generation).toMatchObject({ acceptingRuns: true });
    expect(result.current.plugins[0]).toMatchObject({
      selection: { digest: preview.candidate.digest },
      trust: { digest: preview.candidate.digest, enabled: true },
      active: null,
    });
    await expect(fs.readFile(marker, 'utf8')).resolves.toBe('imported');
    expectRecorded(f.snapshot(), request, result);
    const replay = await f.select(request);
    expectReplay(replay, result);
    expect(replay.current).toEqual(result.current);
  });

  it('captures the actual old member and blocks admission when Generation publication fails', async () => {
    const f = await fixture();
    const running = await f.startUnbound();
    const v1 = await f.preview((await f.source('notes', 'working v1')).directory);
    await f.import(importBody('working-v1-import', v1));
    const activeV1 = expectCommitted(
      await f.select(activation('working-v1-activate', f.snapshot(), v1)),
      'applied',
    );
    expectActive(activeV1, v1);
    const v2 = await f.preview(
      (await f.source('notes', 'desired v2', { version: '2.0.0' })).directory,
    );
    await f.import(importBody('desired-v2-import', v2));
    const commit = vi.spyOn(running.runtime.serverHost, 'commit').mockImplementationOnce(() => {
      throw new Error(`${publicationFailure} at ${f.storeDirectory}`);
    });
    const request = activation('desired-v2-activate', f.snapshot(), v2);
    const result = expectCommitted(await f.select(request), 'failed');
    expect(commit).toHaveBeenCalledOnce();
    expect(result.application).toEqual({
      status: 'failed',
      issue: {
        code: 'plugin-reload-failed',
        message: 'Managed plugin Generation publication failed.',
      },
      active: activeV1.application.active,
      generation: {
        id: activeV1.application.generation.id,
        acceptingRuns: false,
        blocked: {
          code: 'plugin-generation-blocked',
          message: 'New runs are blocked pending a compliant Generation.',
        },
      },
    });
    expect(result.current.plugins[0]).toMatchObject({
      selection: { digest: v2.candidate.digest },
      trust: { digest: v2.candidate.digest, enabled: true },
      active: activeV1.application.active,
    });
    expect(await f.catalog()).toEqual(result.current);
    expectRecorded(f.snapshot(), request, result);
    await expect(f.run('notes', 'blocked-after-publication')).rejects.toMatchObject({
      code: 'plugin-generation-blocked',
    });
    const replay = await f.select(request);
    expectReplay(replay, result);
    expect(replay.current).toEqual(result.current);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('abandons a disconnected precommit import while the Server stays live and reuses the inert object', async () => {
    const f = await fixture();
    const running = await f.startUnbound();
    const marker = join(f.root, 'private-inert-marker');
    const source = await f.source('notes', 'inert bytes', { marker, relativePayload: true });
    const preview = await f.preview(source.directory);
    const request = importBody('disconnect-precommit', preview);
    const baseline = f.snapshot().heads;
    const artifact = join(f.artifacts, preview.candidate.digest);
    const payload = join(artifact, 'payload', 'payload.txt');
    const published = gate();
    const originalRename = fs.rename;
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to);
      if (to === artifact) await published.hold();
    });
    const client = openPost(running, importPath, request);
    try {
      client.send();
      await within(published.entered, 'real artifact rename before authority commit');
      expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
      await expect(fs.readFile(payload, 'utf8')).resolves.toBe('inert bytes');
      client.disconnect();
      await within(client.closed, 'server-side response close before commit');
      expect(await within(client.result, 'client disconnect error')).toMatchObject({
        code: 'ECONNRESET',
      });
      published.release();
      await flushInstallerQueue(f);
      expect(f.snapshot().heads).toEqual(baseline);
      expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
      expect((await f.catalog()).plugins).toEqual([]);
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      const identity = await fs.stat(artifact);
      await f.stop();
      await f.start();

      expectIssue(await f.http(importPath, request, 409), 'plugin-preview-stale');
      expect(f.authority().lookupSync(importRequest(request))).toEqual({ kind: 'absent' });
      const reviewedAgain = await f.preview(source.directory);
      expect(reviewedAgain.candidate.digest).toBe(preview.candidate.digest);
      const reused = expectCommitted(
        await f.import(importBody('reuse-inert-artifact', reviewedAgain)),
        'not-required',
      );
      expect(reused.current.plugins[0]).toMatchObject({
        selection: null,
        trust: null,
        active: null,
      });
      expect((await fs.stat(artifact)).ino).toBe(identity.ino);
      expect(rename.mock.calls.filter(([, to]) => to === artifact)).toHaveLength(1);
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      published.release();
      client.cleanup();
      rename.mockRestore();
    }
  });

  it('finishes applying a disconnected postcommit activation before stop and replays its decision after restart', async () => {
    const f = await fixture();
    const mcpStore = createSqliteMcpAuthorityStore({ filename: f.databaseFile });
    cleanups.push(() => mcpStore.close());
    const running = await f.startUnbound({ mcpAuthorityStore: mcpStore });
    const preview = await f.preview((await f.source('notes', 'postcommit tool')).directory);
    await f.import(importBody('postcommit-import', preview));
    const before = await f.catalog();
    const request = activation('disconnect-postcommit', f.snapshot(), preview);
    const { path, body } = selectionBody(request);
    const applying = gate();
    const originalRead = mcpStore.read;
    const read = vi.spyOn(mcpStore, 'read').mockImplementationOnce(async (options) => {
      await applying.hold();
      return originalRead(options);
    });
    const client = openPost(running, path, body);
    try {
      client.send();
      await within(applying.entered, 'MCP refresh after the activation commit');
      const persisted = f.authority().lookupSync(request);
      expect(persisted.kind).toBe('replayed');
      if (persisted.kind !== 'replayed') throw new Error('Expected activation to be durable');
      expect((await f.catalog()).generation.id).toBe(before.generation.id);
      client.disconnect();
      await within(client.closed, 'server-side response close after commit');
      expect(await within(client.result, 'client disconnect error')).toMatchObject({
        code: 'ECONNRESET',
      });
      applying.release();
      await flushInstallerQueue(f);
      const applied = await f.catalog();
      expect(applied.generation.id).not.toBe(before.generation.id);
      expect(applied.generation.acceptingRuns).toBe(true);
      expect(applied.plugins[0]?.active).toEqual({
        pluginId: 'notes',
        digest: preview.candidate.digest,
        version: '1.0.0',
        activationSequence: persisted.operation.decision.links.installEventSequence,
      });
      expectToolValue(await f.run('notes', 'postcommit-before-stop'), 'postcommit tool');
      await f.stop();
      await f.start();

      const replay = await f.select(request);
      expect(replay).toMatchObject({
        kind: 'replayed',
        application: { status: 'unknown' },
        decision: {
          operationSequence: persisted.operation.sequence,
          selection: persisted.operation.decision.pluginAfter.selection,
          target: { kind: 'activate', intent: 'activate', digest: preview.candidate.digest },
        },
      });
      expectRecorded(f.snapshot(), request, replay);
      expect(replay.current.plugins[0]?.active).toEqual(applied.plugins[0]?.active);
    } finally {
      applying.release();
      client.cleanup();
      read.mockRestore();
    }
  });

  it('serves cached GET and exact replay after observed store loss without new reads or execution', async () => {
    const f = await fixture();
    let authorityReads: MockInstance<PluginAuthorityDatabase['snapshotSync']> | undefined;
    let artifactReads: MockInstance<OwnedPluginArtifactStore['read']> | undefined;
    let previews: MockInstance<OwnedPluginArtifactStore['preview']> | undefined;
    await watchOwnedStore((store, input) => {
      authorityReads = vi.spyOn(input.authority, 'snapshotSync');
      artifactReads = vi.spyOn(store, 'read');
      previews = vi.spyOn(store, 'preview');
      return store;
    });
    await f.startUnbound();
    const marker = join(f.root, 'private-loss-marker');
    const source = await f.source('notes', 'still published', { marker });
    const preview = await f.preview(source.directory);
    const original = importBody('loss-import', preview);
    const imported = expectCommitted(await f.import(original), 'not-required');
    const active = expectCommitted(
      await f.select(activation('loss-activate', f.snapshot(), preview)),
      'applied',
    );
    const newSource = await f.source('other');
    expectActive(active, preview);
    await fs.unlink(marker);

    const insideFixture = (file: unknown) =>
      typeof file === 'string' && (file === f.root || file.startsWith(f.root + sep));
    const filesystemReads: string[] = [];
    const { opendir, lstat, open } = fs;
    vi.spyOn(fs, 'opendir').mockImplementation((file, options) => {
      if (insideFixture(file)) filesystemReads.push('opendir');
      return opendir(file, options);
    });
    vi.spyOn(fs, 'lstat').mockImplementation((file, options) => {
      if (insideFixture(file)) filesystemReads.push('lstat');
      return lstat(file, options);
    });
    vi.spyOn(fs, 'open').mockImplementation((file, flags, mode) => {
      if (insideFixture(file)) filesystemReads.push('open');
      return open(file, flags, mode);
    });
    const spies = [authorityReads!, artifactReads!, previews!];
    const clearReads = () => {
      for (const spy of spies) spy.mockClear();
      filesystemReads.length = 0;
    };
    const noReads = () => {
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(filesystemReads).toEqual([]);
    };

    const displaced = join(f.root, 'private-displaced-owner');
    await fs.rename(f.ownerFile, displaced);
    try {
      clearReads();
      expect(await f.catalog()).toEqual(active.current);
      noReads();

      expectIssue(
        await f.http(`${managed}/preview`, { sourceDirectory: newSource.directory }, 503),
        'plugin-installer-unavailable',
        'The managed plugin store is currently unavailable.',
      );
      clearReads();
      const afterLoss = await f.catalog();
      expect(afterLoss).toEqual({
        ...active.current,
        generation: {
          id: active.current.generation.id,
          acceptingRuns: false,
          blocked: {
            code: 'plugin-generation-blocked',
            message: 'New runs are blocked pending a compliant Generation.',
          },
        },
      });
      noReads();
      const replay = await f.import(original);
      expectReplay(replay, imported);
      expect(replay.current).toEqual(afterLoss);
      expect(f.authority().lookupSync(importRequest(original)).kind).toBe('replayed');
      expect(artifactReads!).not.toHaveBeenCalled();
      expect(previews!).not.toHaveBeenCalled();
      await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rename(displaced, f.ownerFile);
    }
  });

  it('closes preview admission, drains accepted work and retries owned release after cancelling the retained turn', async () => {
    const f = await fixture();
    const turns = turnGate();
    const mcpStore = createSqliteMcpAuthorityStore({ filename: f.databaseFile });
    cleanups.push(() => mcpStore.close());
    const previewing = gate();
    const admin = gate();
    const quiesced = Promise.withResolvers<void>();
    const releaseError = new Error(releaseFailure);
    const close = vi.fn<OwnedPluginArtifactStore['close']>();
    const preview = vi.fn<OwnedPluginArtifactStore['preview']>();
    await watchOwnedStore((store) => ({
      ...store,
      preview: preview.mockImplementation(store.preview),
      async quiesce() {
        await store.quiesce();
        quiesced.resolve();
      },
      close: close.mockImplementation(store.close).mockRejectedValueOnce(releaseError),
    }));
    const running = await f.startUnbound({ plugins: [turns.plugin], mcpAuthorityStore: mcpStore });
    const managedSource = await f.source();
    const review = await f.preview(managedSource.directory);
    await f.import(importBody('shutdown-managed-import', review));
    expectActive(
      expectCommitted(
        await f.select(activation('shutdown-managed-activate', f.snapshot(), review)),
        'applied',
      ),
      review,
    );
    preview.mockClear();

    const firstSource = await f.source('first');
    const secondSource = await f.source('second');
    const config = await createFixtureMcpConfig('queued', f.root, f.launchLog);
    const contenders = await vi.importActual<
      typeof import('../src/owned-plugin-artifact-store.js')
    >('../src/owned-plugin-artifact-store.js');
    const assertLeaseHeld = async () => {
      await expect(
        contenders.openOwnedPluginArtifactStore({
          authority: f.authority(),
          directory: f.storeDirectory,
          initialBinding: 'require-bound',
          onOwnershipLost: () => undefined,
        }),
      ).rejects.toMatchObject({ code: 'plugin-store-busy' });
    };
    const originalRead = mcpStore.read;
    const read = vi.spyOn(mcpStore, 'read').mockImplementationOnce(async (options) => {
      await admin.hold();
      return originalRead(options);
    });
    const directorySpy = holdDirectory(firstSource.directory, previewing);
    const client = openPost(running, `${managed}/preview`, {
      sourceDirectory: secondSource.directory,
    });
    const pin = turns.arm();
    const oldTurn = pending(f.run(['fixture_gate', 'notes'], 'shutdown-retained-pin'));
    const runningAdmin = pending(f.http('/mcp/reload', { expectedSequence: 0 }, 500));
    const runningPreview = pending(
      f.http(`${managed}/preview`, { sourceDirectory: firstSource.directory }, 503),
    );
    let queuedAdmin: ReturnType<NonNullable<Running['mcpManager']>['configure']> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const signal = await within(pin.entered, 'turn pinned before shutdown');
      await within(admin.entered, 'admin work in MCP refresh');
      await within(previewing.entered, 'owned preview filesystem dispatch');
      queuedAdmin = pending(running.mcpManager!.configure(0, config));
      client.beginPartial();
      await within(client.accepted, 'partial preview request accepted by the HTTP server');
      stopping = pending(running.stop());
      expect(running.stop()).toBe(stopping);
      client.finishPartial();
      const response = await within(
        client.result,
        'preview response over already accepted connection',
      );
      if (response instanceof Error) throw response;
      expectIssue(f.parse(response, `${managed}/preview`, 503), 'plugin-installer-unavailable');
      expect(preview).toHaveBeenCalledOnce();
      await expect(queuedAdmin).rejects.toMatchObject({ code: 'plugin-host-disposed' });
      expect(signal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await assertLeaseHeld();

      previewing.release();
      await within(quiesced.promise, 'artifact work quiescence');
      expectIssue(await runningPreview, 'plugin-installer-unavailable');
      expect(signal.aborted).toBe(false);
      expect(close).not.toHaveBeenCalled();
      await assertLeaseHeld();
      admin.release();
      expectIssue(await runningAdmin, 'mcp-management-failed');
      await within(oldTurn, 'shutdown turn settlement');
      expect(pin.abort).toHaveBeenCalledOnce();
      await expect(stopping).rejects.toBe(releaseError);
      expect(close).toHaveBeenCalledOnce();
      await assertLeaseHeld();

      const sessions = createSqliteSessionEventStore({ filename: f.databaseFile });
      try {
        expect(await sessions.read('shutdown-retained-pin')).toContainEqual(
          expect.objectContaining({
            type: 'turn.completed',
            payload: expect.objectContaining({ status: 'cancelled' }),
          }),
        );
      } finally {
        await sessions.close();
      }
      await f.stop();
      expect(close).toHaveBeenCalledTimes(2);
      const mcpReader = createSqliteMcpAuthorityStore({ filename: f.databaseFile });
      try {
        expect((await mcpReader.read()).sequence).toBe(0);
      } finally {
        await mcpReader.close();
      }
      await f.start();
      expect((await f.catalog()).plugins[0]?.active?.digest).toBe(review.candidate.digest);
    } finally {
      previewing.release();
      admin.release();
      pin.release();
      client.cleanup();
      await Promise.allSettled([runningAdmin, runningPreview, queuedAdmin, oldTurn, stopping]);
      read.mockRestore();
      directorySpy.mockRestore();
    }
  });
});
