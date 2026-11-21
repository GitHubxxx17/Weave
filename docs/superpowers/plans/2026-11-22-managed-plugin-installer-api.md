# Managed Plugin Installer API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let loopback clients preview bundled local ESM content, import an exact candidate without running it, perform reviewed selection, and read durable and published managed plugin state.

**Architecture:** The shared plugin-host performs read-only preview and review-bound artifact staging. Server composes the existing registered-store lease, append-only authority and ordered Generation coordinator, and serves allowlisted JSON from fresh decision captures or memory-only GET projections.

**Tech Stack:** TypeScript ESM, Zod, Hono, Node.js >=24.4.0, Node SQLite, Vitest, pnpm >=10.13.1.

**Spec:** [Stage 6.2d Managed Plugin Installer API Design](../specs/2026-11-22-managed-plugin-installer-api-design.md)

## Global Constraints

- Use `feat/managed-plugin-installer-api` from merged Stage 6.2c.2 at `917996f`. Review and commit the tracked cross-package contracts before code.
- Use the installed dependencies, one acquired owned wrapper, the existing coordinator queue and no new durable row/schema, Runtime dependencies, acquisition, build, filesystem GC, or Studio/Desktop feature.
- Readonly local artifacts are already bundled. Import publishes exact verified bytes and a durable candidate without execution, trust, selection, reload, or removal of payloads.
- Preserve lease checking, old turn pin paths, manual working routes, paired ESM/MCP source adoption, and legacy catalog compatibility.
- Preserve strict normalized review and authority request semantics. Preview lifetime 10 minutes, at most 64 live previews and one pending inspection. Managed write size at most 256 KiB of actual bytes. Use fixed public errors and no-store.
- Use test files in the appropriate package `test/`, and use reviewed Chinese Conventional Commits only when the parent task's authorized branch workflow calls for them.

---

## File Map and Build Order

1. **Artifact preview and reviewed staging** changes plugin-host store/types/index and its owned Server wrapper in one compatible unit.
2. **Detached namespace observation** changes the shared manual scanner and local/MCP adapters.
3. **Managed ticket results and actual membership** extends the private Generation pipeline and adapts selection.
4. **Owned installer** composes Tasks 1–3 into preview and import and wires managed lifecycle.
5. **Managed HTTP** projects exact saved/current state, registers guarded routes, and maps the legacy sticky rejection.
6. **Owned loopback integration** verifies storage, publication, restart and shutdown with real entry points.

Task 2 can be reviewed independently of Task 1. Task 3 follows the same serialized coordinator contract, independent of the new installer method. Task 4 consumes the outputs of all three. Task 5 mounts only after Task 4 supplies a complete owned manager. Both intermediate units and the full feature must pass their applicable regression suites.

### Task 1. Preview and reviewed artifact staging

**Files.** Modify `packages/plugin-host/src/artifact-types.ts`, `packages/plugin-host/src/artifact-store.ts`, `packages/plugin-host/src/artifact-copy.ts` for source versus copy-destination error handling, `packages/plugin-host/src/index.ts`, and `apps/server/src/owned-plugin-artifact-store.ts`. Extend `packages/plugin-host/test/artifact-store.test.ts` and `apps/server/test/owned-plugin-artifact-store.test.ts`, including its typed store doubles, gate wrappers, and exact public method list.

**Interfaces.** The package exports the following additive contracts and `pluginArtifactSourceIdentitySchema: z.ZodType<PluginArtifactSourceIdentity>`. The Server wrapper implements the same store interface and consumes the shared schema. Existing stage/read callers keep their call signatures. Task 4 uses the wrapper's `preview` and `stage`.

```ts
interface PluginArtifactSourceIdentity {
  readonly sourceDirectory: string; // normalized, internal to the caller of the store
  readonly digest: string;
  readonly manifest: PluginManifest;
  readonly files: number;
  readonly bytes: number;
}
interface PreviewPluginArtifactOptions {
  readonly sourceDirectory: string;
  readonly signal?: AbortSignal | undefined;
}
interface StagePluginArtifactOptions extends PreviewPluginArtifactOptions {
  readonly expectedSource?: PluginArtifactSourceIdentity | undefined;
}
// On PluginArtifactStore and via OwnedPluginArtifactStore.
preview(options: PreviewPluginArtifactOptions): Promise<PluginArtifactSourceIdentity>;
```

- [ ] Add red filesystem checks using the existing `fixture()`, directory manifest fixtures and fs spy patterns.

  ```ts
  const { sourceDirectory, managedRoot } = await fixture();
  const store = host.createPluginArtifactStore({ directory: managedRoot });
  const reviewed = await store.preview({ sourceDirectory });
  await expect(access(managedRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path.join(sourceDirectory, 'index.mjs'), '// edited');
  await expect(store.stage({ sourceDirectory, expectedSource: reviewed })).rejects.toMatchObject({
    code: 'plugin-artifact-source-changed',
  });
  await expectNoPublication(managedRoot);
  ```

  Parameterize with invalid descriptor/entry, unsupported source file, bounds, ignored files and no setup. On the existing-object and new-object paths, pause a real source at an awaited publication precheck using the existing fs spy patterns, edit the source or repoint its ancestor, resume, assert reviewed stage fails and does not create a new digest object. Reuse identical existing content at capacity, verify deep-frozen identity and clean staging on abort or source mismatch. Test wrapper preview loss checks and quiesce accounting with a held underlying read.

- [ ] Run `pnpm exec vitest run packages/plugin-host/test/artifact-store.test.ts apps/server/test/owned-plugin-artifact-store.test.ts`. Expect preview/mismatch assertions to fail against the current interface.
- [ ] Implement the same normalized-source overlap check for both operations. Parse the source identity with strict `pluginManifestSchema` plus required artifact contributions and permissions, 64-lowercase-hex digest, positive safe files, nonnegative safe bytes and absolute source path without NUL. Use one `HostQueue` of discriminated preview/artifact results local to the artifact store. Deep-freeze detached preview output. Perform the pre-copy review comparison before operation mkdir. Translate only review-invalidating source failures into source-changed. Check copy/reuse/final-staged manifest with `isDeepStrictEqual`; move the reviewed post-copy source traversal after destination, reuse/quota and staged checks. Re-normalize the request path immediately after that traversal, then compare and abort-check synchronously just before reuse or rename.

  ```ts
  const matchesMeasurement = (
    actual: Pick<PluginArtifact, 'digest' | 'files' | 'bytes'>,
    expected: PluginArtifactSourceIdentity,
  ) =>
    actual.digest === expected.digest &&
    actual.files === expected.files &&
    actual.bytes === expected.bytes;
  // The caller combines this with normalized path and normalized manifest equality.
  ```

- [ ] Build dependency outputs with `pnpm --filter @weave/plugin-host... build`; rerun the two tests and run plugin-host and Server lint/typechecks. Last-slot, cleanup, and legacy standalone tests must pass. Review and optionally commit this unit as `feat: 增加插件制品预览和复核暂存` under authorized branch workflow.

### Task 2. Detached namespace observations

**Files.** Modify `packages/plugin-host/src/discovery.ts`, `packages/plugin-host/src/index.ts`, `packages/plugin-host/src/explicit-local-selection.ts`, `packages/plugin-host/src/local-plugin-source.ts`, `apps/server/src/local-extension-source.ts`, and `apps/server/src/mcp-source.ts`. Extend `packages/plugin-host/test/discovery.test.ts`, `packages/plugin-host/test/explicit-local-selection.test.ts`, `apps/server/test/mcp-source.test.ts`, and `apps/server/test/managed-plugin-composition.test.ts`.

**Interfaces.** Add one exported package function, derived from the existing declaration scanner. Add two private adapter functions. Ordinary source refresh, its diagnostics and legacy MCP configure/reservation read behavior remain in their current paths.

```ts
interface LocalPluginDeclarationClaims {
  readonly pluginIds: readonly string[];
  readonly complete: boolean; // missing root is a completed empty scan
}
inspectLocalPluginDeclarationClaims(
  options: DiscoverOptions, signal?: AbortSignal,
): Promise<LocalPluginDeclarationClaims>;

// On createLocalExtensionSource return value.
inspectDeclarationClaims(signal: AbortSignal): Promise<LocalPluginDeclarationClaims>;
// On createMcpExtensionSource return value.
inspectDeclaredPluginIds(signal: AbortSignal): Promise<readonly string[]>;
```

- [ ] Add tests for a complete missing root, real parsed declaration with invalid/missing entry, incompatible manifest, lexically matching directory name with malformed descriptor/no descriptor, a non-followed directory link, candidate truncation, and mocked declaration lstat/read returning EACCES. Verify the read-only helper reports incomplete and preserves manual discovery diagnostics. Verify managed eligibility withdraws on incomplete discovery while unaffected manual rows keep their existing semantics.

  ```ts
  const claims = await inspectLocalPluginDeclarationClaims({
    directory: manualRoot,
  });
  expect(claims).toEqual({ complete: true, pluginIds: ['declared-id'] });
  const prior = mcp.declaredPluginIds();
  expect(await mcp.inspectDeclaredPluginIds(new AbortController().signal)).toContain('mcp-draft');
  expect(mcp.declaredPluginIds()).toEqual(prior);
  ```

  For MCP, exercise a newly persisted disabled or untrusted declaration not yet installed into the cached source, removed records, and malformed or non-append-only persisted log. Assert no observer callback, connection, or local paired publication occurred. For manual, assert detached scan reads no plugin entry/payload when gathering claims.

- [ ] Run `pnpm exec vitest run packages/plugin-host/test/discovery.test.ts packages/plugin-host/test/explicit-local-selection.test.ts apps/server/test/mcp-source.test.ts apps/server/test/managed-plugin-composition.test.ts`. Expect missing detached inspection and incomplete scan behavior.
- [ ] Refactor `scanLocalPluginDeclarations` to use shared raw descriptor enumeration with the existing candidate cap. Its private result extends `DiscoveryResult` with `readonly complete: boolean`; `finalizeLocalPluginDiscovery` and `discoverLocalPlugins` keep the existing public result shape. Use a fixed-size read of at most `maxDescriptorBytes + 1` to detect descriptor growth, with handle cleanup, and reuse `parseDescriptor`. Preserve current legacy diagnostics and exclude managed eligibility whenever raw discovery is incomplete. The local adapter passes its existing `options.discovery` to the detached helper. In the MCP source use `const knownPrefix = log.events` and `validateMcpAuthorityLog(await options.store.read({ knownPrefix }), knownPrefix)`. Check cancellation before and after the read, then share the current nonremoved-ID mapping with `declaredPluginIds` without installing the log.
- [ ] Build plugin-host outputs and rerun the focused tests. Run Server and plugin-host typecheck/lint. Review and optionally commit as `feat: 增加插件命名空间只读检查`.

### Task 3. Ordered completion, exact published identity and cancellable selection

**Files.** Modify `packages/plugin-host/src/local-source-types.ts`, `packages/plugin-host/src/local-plugin-source.ts`, `packages/plugin-host/src/index.ts`, `apps/server/src/extension-types.ts`, `apps/server/src/extension-coordinator.ts`, `apps/server/src/local-extension-source.ts`, `apps/server/src/managed-selection-manager.ts`, and `apps/server/src/managed-plugin-composition.ts`. Add `apps/server/src/managed-command-commit.ts` and `apps/server/src/managed-plugin-installer-errors.ts`. Extend `apps/server/test/extension-coordinator.test.ts`, `apps/server/test/managed-selection-manager.test.ts`, `apps/server/test/managed-plugin-integration.test.ts`, `apps/server/test/managed-plugin-composition.test.ts`, `apps/server/test/support/managed-plugin-composition-fixture.ts`, and `packages/plugin-host/test/explicit-local-selection.test.ts`.

**Interfaces.** On `PreparedLocalPlugin`, `PreparedExtensionItem`, and `ExtensionMember`, add `readonly managedIdentity?: ManagedPreparedIdentity`. Export `ManagedPreparedIdentity` from plugin-host with readonly `digest: string` and `activationSequence: number`. Populate it for every managed prepared item and carry it through publication and retained arrays. Manual and MCP rows omit it. Tasks 4 and 5 consume the capture, commit routine, and selection facade below.

```ts
interface ManagedRuntimeObservation {
  readonly generation: ExtensionGenerationSnapshot;
  readonly members: readonly ExtensionMember[];
}
type ManagedMutationStep<Replay, Saved> =
  | { disposition: 'skip-rebuild'; replay: Replay }
  | { disposition: 'committed-no-rebuild'; saved: Saved }
  | { disposition: 'rebuild'; saved: Saved }
  | { disposition: 'committed-failed'; saved: Saved; cause: unknown };

type ManagedApplicationFailureKind = 'adoption' | 'preparation' | 'publication';
// The coordinator retains the existing attributed failure shape
// (sourceId, pluginId, identity, optional origin, and cause).
type ManagedMutationOutcome =
  | { kind: 'not-required' }
  | { kind: 'completed'; attributedFailures?: readonly ManagedAttributedFailure[] }
  | { kind: 'failed'; failureKind: 'adoption' | 'publication'; cause: unknown };
type ManagedMutationCompletion<Replay, Saved> =
  | { kind: 'replayed'; replay: Replay; observed: ManagedRuntimeObservation }
  | { kind: 'committed'; saved: Saved; outcome: ManagedMutationOutcome; observed: ManagedRuntimeObservation };

type ManagedSelectionResult =
  | {
      kind: 'replayed';
      operation: RecordedManagedOperation;
      currentAuthority: PluginAuthoritySnapshot;
      observed: ManagedRuntimeObservation;
    }
  | {
      kind: 'committed';
      operation: RecordedManagedOperation;
      savedAuthority: PluginAuthoritySnapshot;
      observed: ManagedRuntimeObservation;
      application:
        | { status: 'applied' }
        | { status: 'failed'; failureKind: ManagedApplicationFailureKind; cause?: unknown };
    };
type ApplyManagedSelection = (
  input: ManagedSelectionRequest, signal?: AbortSignal,
) => Promise<ManagedSelectionResult>;
// On createManagedPluginComposition result.
cachedAuthoritySync(): PluginAuthoritySnapshot;
// In managed-plugin-installer-errors.ts, shared by Tasks 3 through 5.
class ManagedInstallerError extends Error {
  constructor(
    readonly code:
      | 'plugin-installer-unavailable'
      | 'plugin-installer-disabled'
      | 'plugin-artifact-unavailable'
      | 'plugin-invalid-request'
      | 'plugin-request-too-large'
      | 'plugin-preview-stale'
      | 'plugin-preview-capacity'
      | 'plugin-managed-id-conflict'
      | 'plugin-managed-namespace-unavailable',
    options?: ErrorOptions,
  );
}
// In managed-command-commit.ts.
class ManagedCommitFailure extends AggregateError {
  constructor(primary: unknown, additional: readonly unknown[]);
  readonly cause: unknown; // primary, also first in errors
}
commitManagedCommandSync(
  authority: Pick<PluginAuthorityDatabase, 'commitSync' | 'snapshotSync'>,
  input: ManagedCommitInput,
  observedBefore: PluginAuthoritySnapshot,
  invalidateSync: (cause: unknown, stickyIds: ReadonlySet<string>) => void,
): ManagedCommit;
invalidateManagedCommandAuthoritySync(
  coordinator: Pick<ExtensionCoordinator, 'blockManagedAdoptionFailureSync'>,
  composition: Pick<ReturnType<typeof createManagedPluginComposition>, 'invalidateAuthoritySync'>,
  cause: unknown,
  stickyIds: ReadonlySet<string>,
): void;
```

- [ ] Add a fake coordinator source with counters and a competing mutation ticket. Assert fresh no-rebuild and replay never call either refresh or assembly, and that captured runtime state has exact membership of the evaluated ticket. Preserve existing managed selection failure tests including thrown `undefined`. Add selection cancellation and replay tests with deferred evidence.

  ```ts
  const completed = await coordinator.mutateManaged('local-esm', async () => ({
    disposition: 'committed-no-rebuild',
    saved: 'durable',
  }));
  expect(completed).toMatchObject({
    kind: 'committed',
    outcome: { kind: 'not-required' },
  });
  expect(coordinator.generationSnapshot()).toEqual(before);
  expect(refresh).toHaveBeenCalledTimes(0);
  ```

  Test fresh select precommit abort leaves operation head unchanged, identical replay skips reads despite an aborted signal, and client abort from inside a commit stub does not cancel adoption or prevent application. A later Generation must not overwrite a prior ticket's membership result. In a setup with a currently published managed member, make a commit throw after a real revoke, then fail synchronous authority readback as closed. Assert admission is blocked synchronously and the original error is preserved. In a second setup make a busy/rolled-back commit throw with matching healthy authority readback and verify prior admission survives.

- [ ] Run `pnpm exec vitest run apps/server/test/extension-coordinator.test.ts apps/server/test/managed-selection-manager.test.ts apps/server/test/managed-plugin-integration.test.ts`. Expect missing capture/no-rebuild behavior.
- [ ] Copy typed digest/activation sequence from the concrete prepared managed candidate through the adapter into the published membership record. Keep the opaque identity for equality and rechecks. In `mutateManaged` use `{ generation: generationSnapshot(), members: structuredClone(members) }` captured before releasing all ticket dispositions. Replay and committed-no-rebuild skip refresh and assembly. Use the private failure discriminator in the interface and spec. Preserve an own `cause` on caught or attributed failures even when the thrown value was undefined; omit it for issue-only missing membership. Adapt existing literal expectations in coordinator, selection and managed integration tests to the `observed` envelope, replacing `application.generation` with `observed.generation`. Preserve exact target attribution tests.
- [ ] Keep early authority replay lookup before precommit assertions. Combine coordinator lifetime and caller signal only for fresh preparation. Check current reviewed heads, selection, candidate and required exact enable trust against one authority snapshot, then use the existing evidence read and `commitSync`. Never pass the request signal into rebuild. Cache latest validated authority, including a known committed snapshot written synchronously before fallible adoption. Expose that memory-only cache. Identify selected payload identity errors as artifact verification errors, retaining genuine filesystem I/O internally.
- [ ] Add `commitManagedCommandSync` shared by selection and import. Invoke the DB commit once and, on a throw, synchronously read back validated authority. Compare install/trust heads with the latest observed precommit heads. A successful matching readback preserves admission and rethrows the original. On readback error or changed heads, use the prior sticky IDs and prepared import ID, if present. The shared invalidation helper calls `coordinator.blockManagedAdoptionFailureSync` first, then `composition.invalidateAuthoritySync`, even if the first throws. The latter always throws the failure marker; distinguish that expected marker from additional withdrawal/observer failures and preserve the raw values of any additional failures. Rethrow the primary unchanged when there are no secondary failures. Otherwise use `ManagedCommitFailure` so Task 5 can read the original from `cause` without unwrapping unrelated aggregate errors.
- [ ] Build plugin-host outputs, rerun focused tests and Server typecheck/lint. Review and optionally commit as `feat: 记录受管决策的实际代际成员`.

### Task 4. Owned installer, exact import and lifecycle

**Files.** Add `apps/server/src/managed-plugin-installer.ts` and `apps/server/test/managed-plugin-installer.test.ts`. Modify `apps/server/src/local-plugin-host.ts`, `apps/server/src/main.ts`, `apps/server/src/server-shutdown.ts`, `apps/server/test/support/managed-plugin-composition-fixture.ts`, and `apps/server/test/server-shutdown.test.ts`.

**Interfaces.** Add `readonly installerStore?: Pick<OwnedPluginArtifactStore, 'preview' | 'stage'>` to the private `ServerExtensionOptions`. `main.ts` supplies it from its acquired owned wrapper; the existing read-only `ManagedPluginCompositionOptions.executionStore` stays narrow. `createServerExtensionCoordinator` returns `installer: ManagedPluginInstaller | undefined` alongside its existing private `applyManagedSelection`. Wire the installer only when local adapter, owned store and selection authority are present. Server shutdown receives `installer?: Pick<ManagedPluginInstaller, 'closeSync'>` in `ServerShutdownResources`.

```ts
type ManagedImportRequest = ManagedRequest & {
  readonly command: Extract<ManagedCommand, { kind: 'import' }>;
};
interface ManagedImportPreview {
  readonly previewId: string;
  readonly expiresAt: string;
  readonly expectedInstallSequence: number;
  readonly candidate: Omit<PluginArtifactSourceIdentity, 'sourceDirectory'>;
}
type ManagedImportResult =
  | {
      kind: 'replayed';
      operation: RecordedManagedOperation;
      currentAuthority: PluginAuthoritySnapshot;
      observed: ManagedRuntimeObservation;
    }
  | {
      kind: 'committed';
      operation: RecordedManagedOperation;
      savedAuthority: PluginAuthoritySnapshot;
      observed: ManagedRuntimeObservation;
      application:
        { status: 'not-required' } | { status: 'failed'; failureKind: 'adoption'; cause: unknown };
    };
interface ManagedPluginInstaller {
  preview(sourceDirectory: string, signal?: AbortSignal): Promise<ManagedImportPreview>;
  import(request: ManagedImportRequest, signal?: AbortSignal): Promise<ManagedImportResult>;
  applySelection: ApplyManagedSelection;
  snapshot(): {
    authority: PluginAuthoritySnapshot;
    observed: ManagedRuntimeObservation;
  };
  closeSync(): void;
}
interface ManagedPluginInstallerOptions {
  readonly coordinator: ExtensionCoordinator;
  readonly authority: Pick<PluginAuthorityDatabase, 'lookupSync' | 'commitSync' | 'snapshotSync'>;
  readonly store: Pick<OwnedPluginArtifactStore, 'preview' | 'stage'>;
  readonly composition: Pick<
    ReturnType<typeof createManagedPluginComposition>,
    | 'assertCommandLeaseSync'
    | 'adoptCommittedAuthoritySync'
    | 'cachedAuthoritySync'
    | 'invalidateAuthoritySync'
    | 'managedAuthority'
  >;
  readonly inspectLocalClaims: (signal: AbortSignal) => Promise<LocalPluginDeclarationClaims>;
  readonly inspectMcpIds?: (signal: AbortSignal) => Promise<readonly string[]>;
  readonly reservedIds: ReadonlySet<string>;
  readonly applySelection: ApplyManagedSelection;
  readonly monotonicNow?: () => number;
  readonly wallNow?: () => number;
}
function createManagedPluginInstaller(
  options: ManagedPluginInstallerOptions,
): ManagedPluginInstaller;
```

Use the Task 2 declaration inspectors, Task 3 typed errors and commit helper, and the composition's `managedAuthority.ownershipLossSignal`. Build the snapshot from `cachedAuthoritySync` and `coordinator.snapshot()` in a single synchronous stack.

- [ ] Write failing tests for one pending preview, 64 live previews, exact expiry, wrong request head retaining a valid token, advanced install head invalidating it, no-op token consumption, duplicate request replay ahead of expired review, and different body/request-ID conflict. Use actual SQLite and filesystem when storage order matters, fake the clocks only, and gate stages through injectable narrow function seams. Assert source manifest/path sentinels cannot escape the preview result. Instrument assertions around the first/second namespace scans and commit. Test an explicit throwing commit leaves the token retired, while a transient precommit scan or staging failure retains it.

  ```ts
  const review = await installer.preview(sourceDirectory);
  const input = {
    requestId: 'first-import',
    command: {
      kind: 'import' as const,
      previewId: review.previewId,
      expectedInstallSequence: review.expectedInstallSequence,
    },
  };
  expect(await installer.import(input)).toMatchObject({
    kind: 'committed',
    application: { status: 'not-required' },
  });
  expect(await installer.import(input)).toMatchObject({ kind: 'replayed' });
  expect(coordinator.generationSnapshot()).toEqual(before);
  expect(authority.snapshotSync().trustEvents).toHaveLength(0);
  ```

  Exercise abort before publication, after publication before commit, and immediately after successful commit. Postpublication/precommit can leave inert files. Force the transactional replay after initial lookup misses and assert a second request ID cannot reuse the resolved token. Assert replay under observed ownership loss performs no artifact or refresh side effect and preview admission is closed. Exercise lease held during shutdown while preview or import is draining and assert the lease closes before authority.

- [ ] Run `pnpm exec vitest run apps/server/test/managed-plugin-installer.test.ts apps/server/test/server-shutdown.test.ts`. Expect absent installer and shutdown hook.
- [ ] Implement the preview table and one pending slot. Clear on lifetime abort and ownership-latch event. Use a monotonic expiration and UTC display sampled at successful issuance. Preview validates its own direct input before a filesystem call; the owned wrapper validates again at its input boundary.
- [ ] Implement import as `mutateManaged` ordered preparation. Use strict canonical request first, then early replay, then fresh lifetime/ownership checks. Compare preview head to live install head before comparing the submitted head. Review exact candidate by stage with internal expected identity. Confirm returned digest/manifest/counts, derive prepared identity from the verified artifact and local provenance from the reviewed normalized path. Collision checks run for a first import before/after stage, detached from live sources. Check retained same-ID members by `coordinator.retainedGenerations()` and manual/MCP source IDs. After staging and the second detached scan return, make the last live install head check and final cached namespace observations synchronously. Assert expiry, request, open queue and lease before commit. Distinguish stale, namespace-unavailable, known collision, artifact capacity/I/O, and ownership errors.

  ```ts
  const committed = (() => {
    try {
      return commitManagedCommandSync(
        authority,
        { request, prepared },
        before,
        (cause, stickyIds) =>
          invalidateManagedCommandAuthoritySync(coordinator, composition, cause, stickyIds),
      );
    } finally {
      previews.delete(command.previewId);
    }
  })();
  if (committed.kind === 'replayed') {
    return {
      disposition: 'skip-rebuild',
      replay: {
        kind: 'replayed',
        operation: committed.operation,
        currentAuthority: committed.currentSnapshot,
      },
    };
  }
  const saved = {
    operation: committed.operation,
    savedAuthority: committed.afterSnapshot,
  };
  try {
    composition.adoptCommittedAuthoritySync(saved.savedAuthority, () =>
      coordinator.blockManagedAdoptionFailureSync(
        localExtensionSourceId,
        new Set(saved.savedAuthority.installations.map(({ pluginId }) => pluginId)),
      ),
    );
    return { disposition: 'committed-no-rebuild', saved };
  } catch (cause: unknown) {
    return { disposition: 'committed-failed', saved, cause };
  }
  ```

- [ ] Integrate the closure at the single Server composition. Add optional installer shutdown resource and close admission before the owned coordinator drain and wrapper quiescence. Request abort/teardown generation order cannot reopen or issue tokens. Run focused Server ownership, installer, shutdown and selection tests, typecheck and lint. Review and optionally commit as `feat: 安装本地候选制品并保留运行代际`.

### Task 5. Managed HTTP routes, path-free DTOs and legacy sticky refusal

**Files.** Add `apps/server/src/managed-plugin-api.ts`, `apps/server/src/managed-plugin-catalog.ts`, and `apps/server/test/managed-plugin-api.test.ts`. Modify `apps/server/src/app.ts`, `apps/server/src/plugin-api.ts`, `apps/server/src/main.ts`, `apps/server/src/plugin-trust-sqlite.ts`, `apps/server/src/plugin-authority-store.ts`, `apps/server/src/local-extension-source.ts`, and `apps/server/src/plugin-authority-types.ts`. Extend `apps/server/test/plugin-management-api.test.ts` and `apps/server/test/plugin-write-guard.test.ts`.

**Interfaces.** Add `managedPluginInstaller?: ManagedPluginInstaller` and `assertManualPluginIdSync?: (id: string) => void` to `PluginAppOptions`. Add `registerManagedPluginRoutes(app: Hono, installer: ManagedPluginInstaller | undefined): void` and call it within `registerPluginRoutes` under its shared write guard. `projectManagedCatalog(authority: PluginAuthoritySnapshot, observed: ManagedRuntimeObservation): ManagedCatalog` projects Task 3/4 internal state into the strict spec schema. `projectManagedMutation(result: ManagedSelectionResult | ManagedImportResult): ManagedMutationResponse` does the same from a ticket. The catalog module exports these types and projection functions and `importPreviewResponseSchema: z.ZodType<ImportPreviewResponse>`. Add `ManagedReviewRequiredError extends PluginTrustStoreError` in `plugin-trust-sqlite.ts` with the same code and message as the existing denial. Export the existing `pluginIdSchema`, `digestSchema`, `opaqueIdSchema`, `headSchema`, `intentSchema`, and `artifactManifestSchema` from `plugin-authority-types.ts` for request parsing.

- [ ] Add red `createApp` tests with injected installer counters and full request fixtures. Test exact and wildcard write guard, untrusted Origin/Host/fetch-site, media type, query parameters, invalid route IDs, id/body mismatch, strict nested manifest shape, well-formed disabled 404, and no-store on successful/rejected/disabled managed responses. Test 256 KiB byte counts with chunked streaming, misleading Content-Length and multibyte bodies and assert service never called on rejected input. Use a no-op `ReadableStream` cancel spy to verify overflow stops consuming. Confirm both well-formed and rejected requests keep current CORS behavior. Round-trip a near-64 KiB descriptor with replacement characters in free-form manifest text through preview and activation.

  ```ts
  const response = await app.request('/plugins/managed/sample/activate', {
    method: 'POST',
    headers: { Host: 'localhost', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...validActivate,
      manifest: { ...manifest, id: 'other-id' },
    }),
  });
  expect(response.status).toBe(400);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(applySelection).not.toHaveBeenCalled();
  ```

  Test GET against an authority snapshot whose internal fields contain path sentinels and whose historical manual trust is unrelated to its current selection. Verify stable order, imported timestamp from event joins, and historical decision after-state differing from current state on replay. Test every success and failure variant with private path/cause/lease/durable provenance sentinels. Legacy trust and every related legacy mutation get 409 for sticky ID while malformed ordinary trust remains 400 and ordinary disabled handling stays 404.

- [ ] Run `pnpm exec vitest run apps/server/test/managed-plugin-api.test.ts apps/server/test/plugin-management-api.test.ts apps/server/test/plugin-write-guard.test.ts apps/server/test/plugin-catalog-projection.test.ts`. Expect absent routes/DTO projections and legacy sticky HTTP 400.
- [ ] Implement the strict allowlist schemas and public projections from the spec. Use measured candidates, imported facts and exact published member metadata. Project exact selected managed trust, sanitized Generation blocks, import application `not-required`, fixed failure classification, and replay `unknown`. Classify `ManagedCommitFailure` by `cause`; retain ordinary typed MCP authority mapping on legacy MCP routes.
- [ ] Register the managed handlers inside the existing plugin registration. Install exact and descendant no-store middleware in `createApp` before CORS and the common write guard. Parse actual body bytes once and enforce the cap even with declared Content-Length. Reject all managed write query parameters before dispatch. Validate static inputs before installer presence and normalize optional immediate via authority. Pass `context.req.raw.signal`.

  ```ts
  const body = new Uint8Array(256 * 1024);
  let size = 0;
  const reader = context.req.raw.body?.getReader();
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
  } finally {
    reader?.releaseLock();
  }
  const raw: unknown = JSON.parse(new TextDecoder().decode(body.subarray(0, size)));
  ```

  Wrap data decoding/parsing failures as the fixed managed invalid request signal. Distinguish abort, namespace failures and typed store/authority failures. Keep disabled-route parsing precedence stated in the tracked design. The same private managed-review-required error extends the source and append backstop with compatibility preserved. Use fallback sticky check after strict manual ID/body validation when no local manager is wired. Existing manual routes with a manager continue to rely on ordered assertions and SQLite.

- [ ] Run focused API, legacy plugin/MCP and projection checks, Server typecheck and lint. Review and optionally commit as `feat: 提供已复核的本地插件管理接口`.

### Task 6. Owned HTTP lifecycle and final verification

**Files.** Add `apps/server/test/managed-plugin-installer-integration.test.ts`. Modify `docs/architecture/foundation.md` to record the verified stage after implementation. Reuse fixture functions from `apps/server/test/support/managed-plugin-composition-fixture.ts` and `apps/server/test/support/plugin-authority-fixtures.ts`.

**Interfaces.** Exercise the public `startServer(0, { databaseFile, pluginsDirectory, managedPluginStore: { initialBinding: 'allow-unbound' } })`, actual HTTP with ephemeral loopback, and restart with binding option omitted. Verify behavior through HTTP bodies, persistent SQLite readback and captured turn events where appropriate. Existing startup entrypoint and registration remain unchanged.

- [ ] Cover the following request and storage scenarios. Add them in the earlier red tests when that tests one interface in isolation, reserving this suite for real composition behavior.

  ```ts
  const preview = await post('/plugins/managed/preview', { sourceDirectory });
  const operation = {
    requestId: 'import-v1',
    previewId: preview.previewId,
    expectedInstallSequence: preview.expectedInstallSequence,
  };
  const first = await post('/plugins/managed/import', operation);
  expect(first.application.status).toBe('not-required');
  expect(first.current.generation.id).toBe(initial.generation.id);
  await expect(access(executedMarker)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await running.stop();
  // Restart the same root with no allow-unbound option. Remove only the external source.
  const replay = await postAfterRestart('/plugins/managed/import', operation);
  expect(replay).toMatchObject({
    kind: 'replayed',
    decision: first.decision,
    application: { status: 'unknown' },
  });
  ```

  1. Confirm same-ID manual and MCP races are ordered, including a manual declaration introduced during stage, a retained member after its declaration is removed, and disabled/untrusted MCP. Assert no trust/selection on import and no plugin code executes before activation. Compare payload quota for stale reviewed source before publication and confirm postpublication canceled import leaves an inert reusable artifact.
  2. Enable after disable with exact heads, reject stale CAS and enable after revoke, activate v2 then explicitly rollback v1, revoke and uninstall even with missing bytes, and preserve old pinned import.meta.url file paths. Assert operation/install/trust link sequences, actual membership digests and activation sequences. Assert immediate requests cancel once on fresh command including durable no-op. Replay does not cancel later turns.
  3. Inject a real registration/setup failure and an isolated missing target versus terminal publication failure. Inspect blocked admission, captured actual old/missing members, committed decision and replay unknown state. Check every response for private path/cause sentinels.
  4. Send concurrent identical real requests and reused request IDs with changed canonical commands. Exercise precommit disconnect by destroying a real HTTP client's socket while preparation is held, then test postcommit disconnect by pausing application. Verify persisted state with the exact original command and request ID after restart. Test stale preview token after restart and durable replay after deleting/replacing source and corrupting a retained object.
  5. Exercise owned shutdown with paused artifact or queued admin work and retained turns, verifying no more preview admission, drain-before-release and retries through existing shutdown phases. Confirm GET cache observes no discovery, artifact reads or execution and survives observed store loss while authority connection remains valid.

- [ ] Run `pnpm exec vitest run apps/server/test/managed-plugin-installer-integration.test.ts`, `pnpm --filter @weave/plugin-host test`, and `pnpm --filter @weave/server test`. Confirm real loopback smoke, restart and channel disconnect outcomes. Correct any behavior mismatch before full gate.
- [ ] Run root `pnpm check` from the prepared branch and record its result. Recheck global spec coverage and artifact path redaction, inspect `git diff --check`, then use the authorized PR workflow and CI gate. Studio/Desktop workflow verification is tracked separately in Stage 6.3.
