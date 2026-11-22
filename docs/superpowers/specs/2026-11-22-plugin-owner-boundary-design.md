# Plugin contribution and consumer ownership repair

Date: 2026-11-22. Prerequisite for declarative right-side panels, not a panel implementation. Product references remain the pinned Codex/Harness/Kimi audit; this change enforces Weave's own Plugin/Session/Pipeline boundaries. No new dependencies, durable schema, permissions, API-version matching policy or OS isolation claim.

## Problem and required behavior

Reproductions against actual Kernel/builtins show a plugin with store permission can append another registered namespace through env.use or service factory deps, receive full registry define, mutate live event definitions, and catch owner errors while being recorded as a successful command contributor. Mutable parsed/original manifests can disagree on plugin identity. Before panels use namespace and command ownership, correct these facts in a separate fix branch.

All plugin consumer identities come from a detached frozen parsed manifest. All standard governed contribution accounting records only accepted additions. Standard Session/Event service consumers receive owner-bound views through both resolution paths. Host resolution/lifetime remains full. Existing Session events are retained and receive no retroactive attestation.

## Immutable identity and successful contribution

Deep-freeze the Zod-parsed manifest before setup, including arrays and nested declarations/engines. Setup, usage checks, error attribution, registrations, Generation.pluginIds and PluginInfo all use this captured identity, never later reads from author plugin.manifest. Do not freeze or mutate the original author object.

ContributionCheck adds an overload `(name, accept)`; the existing one-argument form performs declaration validation only. The synchronous overload validates capability/declaration/duplicate rules, calls accept exactly once and records only on a non-throwing undefined result. The callback has the exact synchronous return type void|false. Runtime accepts only undefined (success) or false (skip); other values and thenables reject without recording. Observe rejection of a returned thenable without blocking collect; do not await an unbounded plugin Promise or claim owner side effects rollback. Also reject/observe async contributor callbacks and close every guarded API when its collect callback returns/throws; retained or late adds must fail without reaching the owner. This preserves synchronous candidate assembly. An owner returns false to signal skip; void remains successful for existing owners. Every standard governed seam migrates to this overload. Legacy custom guards can continue declaration validation with check(name), but must migrate to atomic acceptance to report successful provides. This is an explicit tightening of governance, not permission to infer ownership from declared names.

Skill duplicate reservation occurs after acceptance; a rejected attempt can retry and a genuinely accepted duplicate fails. A callback that successfully added one entry before another fails retains the first fact; candidate rollback remains host-owned. Tool/Provider owners with existing:skip return false. Recheck canonical collection-point capabilities at collect, because a contributor can construct a different reference with the same id. Freeze defineExtensionPoint's detached governed metadata so SDK point policy cannot be replaced through a nested mutable object. Contributor identity is kernel-owned.

Standard seams capture their governance name once and pass the owner a detached
wrapper with that same name; author getters cannot change identity between checks,
registration and accounting. Provider IDs with surrounding whitespace are rejected
at contribution instead of allowing Registry trimming to create a different name.

## Consumer-aware generic service resolution

Add optional `ServiceImpl<T,D>.forConsumer(value:T,consumer:{readonly pluginId:string}):T|Promise<T>`. This is a provider registration policy, selected from the actual registration, never from a requesting ServiceRef. Host ScopeContext.resolve/resolveAll keep their raw behavior. Add resolveForPlugin/resolveAllForPlugin; env.use().get invokes them using captured identity. Each dependency in a service factory resolves through the same path with that factory registration's pluginId, rather than the outer requester. Across parent scopes and multi registrations each raw value receives its actual consumer view.

Capture actual registration ref identity/scope/multi, deps and policy at registration; resolve uses actual registration metadata rather than requester ref.scope. Raw and consumer caches key by registration object identity, never mutable list index. Raw factory instances remain cached/disposed once with existing scope semantics. Cache consumer promises per owning scope, registration and consumer; reject view failures without raw fallback and wrap them with the actual consumer identity even if the original exception claims another pluginId; preserve factory/dependency failures' actual provider/consumer attribution. Cache failed view promises for the scope lifetime. Parent scopes retain consumer identity; same-id request scope/multi metadata must match actual registration or reject. Scope close rejects new resolution and late view publication without attempting to cancel arbitrary author Promises. Unconfigured ordinary services retain exact value identity. Do not dispose a view as though it owned raw resources. No author-facing method permits choosing another caller ID.

## Standard store and event service views

Factory error provenance is bound at the actual execution boundary too. A direct
factory exception cannot choose another provider through `PluginError.pluginId`.
Keep dependency failures outside the factory catch. Wrap the factory's supplied
`context.collect` to remember errors actually thrown by the host collector during
that invocation together with a detached snapshot of their kernel attribution,
code and message; if the factory propagates that same error, retain the captured
contributor attribution even if the author changed its public fields. Other factory exceptions are forced to the registered
provider, preserving error code and original cause. This needs no author-facing
brand or public error helper semantic change.

hostServicesPlugin with a Session store requires the associated Generation event registry. Its raw provider returns the real host store; forConsumer produces an owner-bound createPluginSessionStore(store,events,pluginId). A missing registry fails explicitly before offering a raw fallback. Runtime core facts continue using the original host store.

createPluginSessionStore's owner is required. Validate every input type against captured namespace before any schema callback, parse the entire batch, then verify each parsed type still equals its input type and owner namespace. Append exactly once after all checks; rejection writes zero. Use stable captured names so plugin schema callbacks cannot change type identities by mutating inputs. Registered/schema validation remains mandatory. Reads intentionally retain existing shared Session transcript semantics; close remains noop. No history isolation is claimed.

eventRegistryPlugin's registration supplies forConsumer returning a frozen PluginEventReader. The reader has get/list metadata containing only stable type and, if needed, host boolean projection availability; it never returns schema/project implementation references. parse/project remain bound internal operations; define is absent. Public pluginEventsRef describes this reader. The full Registry extends Reader and also narrows its own get/list to frozen metadata; implementations remain private and define exists only on Registry. This keeps raw provision structurally valid without casts or a same-id admin reference. The full registry remains a host-owned closure; do not expose it through a plugin-requested alias or fake ref. If get/list metadata is type-only, raw registry structurally satisfies the reader interface for host provision.

Registry.define captures/validates stable type, stores a new frozen wrapper and copied projection callback structure. Later edits to author definition or returned reader metadata cannot relabel internal events. parse returns the stable Map key. It does not deep-freeze third-party Zod implementation internals or promise isolation from arbitrary trusted Node code. Host keeps raw registry for definition/collection; Server only resolves service to trigger event collection and can retain its existing registry closure.

## Cross-package changes

Plugin owns generic scope/view machinery, captured manifest, standard reader/writer helpers, SDK types and governed acceptance. Plugin-builtins own standard service-view policies and skip outcomes. Server supplies the correct raw store+registry pair, updates any affected types, and verifies actual catalog ownership and append behavior. Runtime/Session schemas/HTTP routes remain unchanged. Update Foundation before implementation. The full flow remains protocol -> Session/Runtime -> Plugin -> builtins -> Server.

## Verification

Tests stay in package/app test directories. Reproduce RED then GREEN for direct and dependency foreign writes, registry define/implementation leakage, live definition relabel, manifest mutation, caught duplicate and skip ownership. Generic service tests cover host raw, stable/concurrent view identity, factory provider consumer, recreated same-id refs, multi/parent scopes, errors, missing mapper and raw dispose once. Writer checks cover own/foreign/core/unknown/batch/pre-schema callback counters and post-transform identity; read/close remain compatible. Kernel checks cover canonical capability spoofing, immutable nested policy and legitimate ordinary plugins.

Server integration uses actual Kernel plugins/Pipeline/store: own report accepted, foreign and undeclared writes rejected via both paths, command catalog has only accepted owner, and historical facts remain readable after unload. A real loopback SQLite/HTTP acceptance verifies persistence is not forged. Independent cross-review and pnpm check plus marketplace:check/plugin:verify precede PR/CI/squash. These checks establish logical SDK governance, not a sandbox for in-process JavaScript.
