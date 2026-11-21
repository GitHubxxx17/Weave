# Managed Plugin Source Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal**

Deliver the Stage 6.2c.1 package capability for exact selected ESM preparation,
disposal, and guarded Generation start.

**Architecture**

Carry the validated entry out of the artifact store. Extend the existing local
ESM source with explicit declarations and managed verification using the shared
loader and lifecycle. Check the actual Generation at the Session queue head.

**Tech stack**

TypeScript ESM, Zod, Vitest, Node `>=24.4.0`, pnpm `>=10.13.1`.

**Spec**

[Managed Plugin Source Design](../specs/2026-11-21-managed-plugin-source-design.md),
the package-capability section.

## Global Constraints

Use the existing `@weave/plugin-host` package and its dependencies. Place
tests under `packages/plugin-host/test/`. Preserve the manual public discovery
and loader behavior. Package callbacks accept explicit data independently of
Server authority and receive no SQLite, Runtime, or HTTP types. This topic's
PR contains package capabilities and their design and plan. Stage 6.2c.2
gets its own plan and PR from fresh `origin/main`.

| Task | Owned files under `packages/plugin-host/`                                                                                                                                                                     | Dependency                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1    | `src/artifact-types.ts`, `src/artifact-store.ts`, `test/artifact-store.test.ts`                                                                                                                               | Existing store                                   |
| 2    | `src/generation-runner.ts`, `test/generation-runner.test.ts`                                                                                                                                                  | Existing runner                                  |
| 3    | `src/errors.ts`, `src/loader.ts`, `src/plugin-lifecycle.ts`, `test/explicit-local-loader.test.ts`                                                                                                             | Task 1 entry contract for the real artifact test |
| 4    | `src/discovery.ts`, `src/local-source-types.ts`, `src/local-plugin-source.ts`, `src/explicit-local-selection.ts`, `src/host-types.ts`, `src/host.ts`, `src/index.ts`, `test/explicit-local-selection.test.ts` | Tasks 1 and 3                                    |

Tasks 1 and 2 are file-disjoint. Each task gets a fresh independent review
of contract compliance and code quality after GREEN. For a review finding,
add or adjust a focused regression assertion, rerun, and obtain re-review
before integrating dependent work. Follow the repository's Git authorization
and single-PR workflow.

Build dependency outputs before focused tests if this worktree starts without
a build:

```sh
pnpm --filter @weave/plugin-host... build
```

## Task 1. Return the validated published entry

**Interface.** Add `readonly entry: string` to the existing exported
`PluginArtifact` type.

- [ ] **RED.** In `artifact-store.test.ts`, stage a fixture with
      `entry: 'nested/index.mjs'`. Assert the final entry, its readable content,
      and matching read and duplicate-stage values. Keep the existing
      publication-conflict contract.

  ```ts
  expect(artifact.entry).toBe(path.join(artifact.directory, 'nested', 'index.mjs'));
  expect(await readFile(artifact.entry, 'utf8')).toBe(helloSource);
  expect((await store.read(artifact.digest)).entry).toBe(artifact.entry);
  expect((await store.stage({ sourceDirectory })).entry).toBe(artifact.entry);
  ```

- [ ] Run `pnpm exec vitest run packages/plugin-host/test/artifact-store.test.ts`.
      Confirm the new assertion fails because the entry is absent.
- [ ] Include the already-validated `entry` in `validatePayload`'s frozen
      result. Update the rename result with both final paths.

  ```ts
  const directory = path.join(object, 'payload');
  const entry = path.join(directory, path.relative(finalArtifact.directory, finalArtifact.entry));
  result = Object.freeze({ ...finalArtifact, directory, entry });
  ```

- [ ] **GREEN.** Rerun the focused file and verify existing-object results,
      publication conflicts, cancellation, digest, and frozen fields. Review
      that every successful return carries the verified concrete path.

## Task 2. Check admission at the actual Session queue head

**Interface.** Add
`readonly assertCanStartSync?: (() => undefined) | undefined` to
`RunnerGeneration`. The caller uses the existing `current`, `commit`,
`blockNewRuns` and `dispose` contracts.

- [ ] **RED.** Extend `generation-runner.test.ts` with a blocked fixture
      turn using its existing `gate()` and `source()`. Start a second iterator
      for the same Session and assert its hook and underlying runner have not
      run yet. Arm an error only after it is queued. Permit the first turn to
      finish and observe the second iterator rejection and absence of a second
      underlying invocation. Admit a later same-Session turn.

  ```ts
  const next = queued.next();
  const verdict = next.then(
    () => ({ failed: false as const }),
    (cause: unknown) => ({ failed: true as const, cause }),
  );
  // First turn owns the queue head here. Arm, then let the first turn finish.
  throwAtStart = true;
  finishFirst.resolve();
  expect(await verdict).toEqual({ failed: true, cause: undefined });
  expect(started).toEqual(['first']);
  ```

- [ ] Add deterministic cases for a hook which aborts its request
      synchronously, aborts and then throws `undefined`, disposes the controller,
      blocks it, and replaces current. In the replacement case the old guard is
      consulted for this head, the new runner receives no call for it, and a
      subsequent head consults the new guard. Test a defined return, a rejected
      Promise and a rejected thenable returned across a runtime type boundary.
- [ ] Run `pnpm exec vitest run packages/plugin-host/test/generation-runner.test.ts`.
      Confirm failures show the old runner starts without checking the hook.
- [ ] Before pinning set a per-run guard-in-progress flag. While that flag is
      set, `flush()` for that run defers delivery. Capture the actual current
      state and validate its hook inside the exception boundary, including
      callable/runtime return validation. For a defined return, observe rejection
      through `void Promise.resolve(result).catch(() => undefined)` before
      failing. In the catch use `finish(cause, true)`
      and release only if the head was still queued. Always restore delivery in
      `finally`. After a successful hook, stop if phase is no longer queued.
      Handle blocked/disposed state using the existing queue failure behavior and
      fail the queued head when captured current differs. Pin only the captured
      state that passed those checks.
- [ ] **GREEN.** Rerun the focused file. Review queue removal under reentry,
      admitted pin retirement, `throw undefined` and accidental async hooks.

## Task 3. Verify managed bytes and guard evaluation

**Interfaces.** `loadLocalPlugin` accepts optional
`explicitChecks: { verify(signal: AbortSignal): Promise<Pick<ReadyLocalPlugin, 'entry' | 'digest'>>; assertReadySync(): undefined }`
and requires its existing signal in explicit mode.
`ExplicitLocalAuthorityError` carries the fixed code and message from the
spec with a private cause. Internally extend `createPluginLifecycle` with an
optional fourth argument `{ readonly drainSetupOnDispose?: boolean }`.
Explicit source wiring and package root exports follow in Task 4.

- [ ] **RED.** Add `explicit-local-loader.test.ts`. Stage a real fixture
      through the existing artifact store and call the real loader without an
      `importModule` override in its successful path. A small ESM module writes
      stage markers for evaluation, factory, and setup. In setup exercise its
      normal kernel registration entry. Record that the verifier receives the
      attempt signal and returns the result of `store.read`.

  ```ts
  const signal = new AbortController().signal;
  const calls: AbortSignal[] = [];
  const plugin = await loadLocalPlugin(candidate, {
    trustedDigest: artifact.digest,
    signal,
    explicitChecks: {
      async verify(attemptSignal) {
        calls.push(attemptSignal);
        const { entry, digest } = await store.read(artifact.digest, { signal: attemptSignal });
        return { entry, digest };
      },
      assertReadySync: () => undefined,
    },
  });
  expect(calls).toEqual([signal]);
  ```

- [ ] Add fixtures for an invalid or mismatched verified entry or digest, loss before
      import, loss after a deferred import before factory, and loss after factory
      before setup. Assert the blocked phase does not execute. Load the plugin
      through a real kernel and lifecycle in the setup case and inspect its direct
      setup cause for the marker. Repeat with a guard that synchronously aborts
      the attempt and then throws. Test a synchronously aborting successful
      guard at every handoff and assert the next phase does not execute.
      Use the import hook only for deterministic handoff races.
      Cover rejected Promise and custom thenable returns from an invalid
      synchronous guard, and verify that
      an ordinary module or factory error remains an attributed load failure.
      For substitution of the bounded verifier, decorate its call and arrange a
      legacy digest failure using a low file limit. Assert the real artifact
      succeeds with the callback and fails through the manual loader default.
- [ ] Add a gated lifecycle test. Original managed setup begins and awaits a
      gate, the attempt aborts, and the kernel setup observation settles promptly.
      Start lifecycle disposal, assert the plugin disposer runs once while the
      disposal promise is still pending, release the gate, and verify disposal
      settlement. The manual option default retains the existing timeout behavior.
- [ ] Run `pnpm exec vitest run packages/plugin-host/test/explicit-local-loader.test.ts`.
      Confirm failures relate to missing callback, marker or drain behavior.
- [ ] **GREEN.** Select the existing manual hash or use the checked
      `{ entry, digest }` from the explicit verifier. Require the signal in
      explicit mode and validate the verifier result with a strict Zod object,
      absolute entry and lowercase 64-character hexadecimal digest. Reject invalid
      results and mismatches as
      `plugin-digest-mismatch`. Use one guard function across import, factory and
      setup and wrap all guard failures as the narrow authority marker. Check
      the signal before and after each guard. For any
      defined guard return, observe rejection through
      `void Promise.resolve(result).catch(() => undefined)`. Keep each guard outside
      plugin error attribution and ensure setup checks at the actual user-code
      invocation inside the existing lifecycle microtask. Capture a managed
      setup marker in a synchronous catch around that invocation and prefer it
      when the setup race's catch processes a synchronous guard-triggered abort.
      A setup cancellation without a captured marker keeps its existing path.
- [ ] Track the managed lifecycle's original setup promise synchronously when
      scheduled. In one-time cleanup invoke the existing disposer and await
      settlement of both, independently of the already-settled race.

  ```ts
  const pending = Promise.resolve().then(() => original.setup(guardEnv(env)));
  if (options?.drainSetupOnDispose) {
    setupSettled = pending.then(
      () => undefined,
      () => undefined,
    );
  }
  ```

- [ ] Rerun the focused file and `pnpm --filter @weave/plugin-host test`.
      Review phase ordering, error provenance, signal propagation, and managed
      setup cleanup after cancellation or timeout.

## Task 4. Apply explicit selections in the shared local ESM source

**Interfaces.** Add the exact `ExplicitLocalSelection`,
`ExplicitLocalSelectionInput`, `ExplicitLocalCandidateChecks`,
`LocalSourceCandidate`, `ManagedLocalCandidate`, source snapshot fields, and
controller method from the spec. Export both package helpers,
`eligibleLocalSourceCandidates(snapshot)` and
`localSourceCandidateIdentity(candidate)`, plus the types and authority
marker via `src/index.ts`.

- [ ] **RED.** Add `explicit-local-selection.test.ts` and use real manual
      directories plus a real artifact staged from a separate input root. Build
      ready evidence with `status`, `id`, `manifest`, `digest`, `directory` and
      `entry` from the artifact and use `createMemoryTrustStore` for matching
      recorded trust events. A fixture with manual and managed copies of the
      same bytes asserts the manual row is invalid and no managed copy prepares.
      Repeat with a missing manual entry and a valid conflicting manifest.
      Replace the manual descriptor with unreadable content and check the
      basename no longer claims the ID. Cover a sticky ID without a selected
      row, selected rows without ready evidence, baseline reserved IDs, denied
      IDs and truncation. Adopt an otherwise ready selection before the first
      manual scan and assert it stays ineligible until a successful complete
      scan. Cover a genuinely absent manual root as a completed empty scan.
      Exercise public manual discovery and manual loading through the existing
      source to observe their established behavior.
- [ ] Exercise strict validation and detached inputs. Try duplicate IDs,
      nonsafe activation sequence, mismatched ready identity, ineligible folded
      trust, relative paths and a rolled-back or rewritten trust prefix. Compare
      previous snapshot and observer calls when a projection is rejected.
      After valid adoption mutate the owned test input and verify the cache
      remains frozen. Adopt equivalent input and check the same stamp. Change
      only activation sequence and verify the old preparation no longer
      rechecks. Assert exclusions and prepared item origins using the shared
      helper.

  ```ts
  const current = source.adoptExplicitSelectionSync(input);
  const ready = current.managedEligible[0]!;
  expect(localSourceCandidateIdentity(ready)).toBe(
    JSON.stringify([ready.id, ready.digest, 'managed', selection.activationSequence]),
  );
  const prepared = await source.prepare(current.stamp, {
    signal: new AbortController().signal,
    excluded: new Set([localSourceCandidateIdentity(ready)]),
  });
  expect(prepared.items).toEqual([]);
  ```

- [ ] Exercise source-level authority propagation through
      `source.prepare()`. Put a manual item before a managed fixture in byte ID
      order, throw an authority error from managed verification or its
      synchronous guard and assert rejection of the whole preparation and
      disposal of the previously prepared item. On an intact-authority mismatch,
      assert an identity failure with managed origin. Trigger setup through the
      real kernel for an explicit source item as well.
- [ ] Add a source-level guard test for an invalid rejecting Promise return.
      Assert preparation rejects with the authority marker, the rejection is
      observed, and import stays untouched. Add a gated verifier that calls
      `source.close()` synchronously and then waits on the gate. Assert close
      stays pending while the verifier is pending. Release the gate, then
      assert preparation rejects on cancellation and close settles.
- [ ] Run `pnpm exec vitest run packages/plugin-host/test/explicit-local-selection.test.ts`.
      Verify RED for absent adoption, origin and combined eligibility.
- [ ] Split the discovery scan from its legacy finalizer and reuse the
      existing finalizer for manual behavior. Put explicit input validation and
      effective managed data/identity computation in
      `explicit-local-selection.ts`. Keep trust-prefix adoption, cached snapshot,
      authority notification, lifecycle ownership and queue-free source logic in
      `local-plugin-source.ts`. Use one prefix validator for adopted and read trust
      with the append high-water semantics intact. Omit `explicitChecks` from
      `CreatePluginHostOptions` and from the strict schema in `host.ts`.
- [ ] Recompute merged eligibility on explicit adoption, trust changes and
      manual scans. For a valid matching manual manifest and sticky ID, emit a
      path-free conflict issue attached to the existing manual display row.
      Keep managed rows out of legacy projection. Preserve the stamp when only
      cached, already-ineligible diagnostics change. Use the same eligibility
      and identity helpers in preparation and recheck. Guard manual mutation
      against cached sticky IDs after any awaited reads that lead to success.
- [ ] Bind loader callbacks and the managed lifecycle option only for
      managed candidates. Preserve any defined result from the bound authority
      guard for the loader's validation and rejection observer. On an
      `undefined` result confirm exact current identity and ready data in the
      cached effective snapshot in the same stack.
      In the per-item catch, rethrow the marker before abort handling and
      plugin failure attribution. Let the existing outer
      catch settle the prior items, then rethrow. Include origin on both prepared
      items and failures.

  ```ts
  const lifecycle = createPluginLifecycle(loaded, setupTimeoutMs, signal, {
    drainSetupOnDispose: candidate.origin === 'managed',
  });
  ```

- [ ] Register each preparation before dispatching explicit callbacks. Use a
      microtask handoff for explicit mode so the existing tracker receives
      the promise before the verifier can reenter `close()`. Retain the
      existing settlement removal and close drain.

  ```ts
  const pending = explicitChecks
    ? Promise.resolve().then(() => prepare(stamp, options))
    : prepare(stamp, options);
  preparing.add(pending);
  ```

- [ ] **GREEN.** Rerun the focused file and existing local source, loader
      and standalone host tests through `pnpm --filter @weave/plugin-host test`.
      Review that adoption synchronously updates the observed snapshot, the
      manual projection is compatible, and guard failure transfers no prepared
      candidate ownership.

## Final verification

- [ ] Read the complete diff against the spec's package section and review
      tests for real publication, ESM preparation, late setup, and queue head
      behavior. Confirm the remaining Server work has no implementation files in
      this PR.
- [ ] Run package lint, typecheck, tests and build, then the root gate. Format
      or check the two reviewed documents explicitly because they are ignored by
      the root Prettier configuration.

  ```sh
  pnpm exec prettier --check --ignore-path /dev/null docs/superpowers/specs/2026-11-21-managed-plugin-source-design.md docs/superpowers/plans/2026-11-21-managed-plugin-source-support.md
  pnpm --filter @weave/plugin-host lint
  pnpm --filter @weave/plugin-host typecheck
  pnpm --filter @weave/plugin-host test
  pnpm --filter @weave/plugin-host build
  pnpm check
  ```

- [ ] Record the observed checks in the handoff. Follow the repository's
      explicit commit/PR authorization, Chinese Conventional Commit description,
      and CI policy.
