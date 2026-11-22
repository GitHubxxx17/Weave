# Plugin ownership repair implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development with separate ownership and independent cross-review.

**Goal:** Make standard event services and successful contribution records bind to immutable kernel plugin identity before building declarative panels.

**Architecture:** Keep generic consumer views on actual service registrations, apply them to env.use and provider deps, and retain host raw lifetime. Standard builtins own restricted view construction. Atomic governed acceptance records actual owner success, not attempts. No durable schema or Runtime feature changes.

**Tech stack:** Existing TypeScript ESM/Zod/Vitest/Node24; no dependency additions.

**Spec:** [Owner boundary contract](../specs/2026-11-22-plugin-owner-boundary-design.md).

## Global constraints

ScopeContext host raw resolution remains full. Only kernel-captured IDs enter consumer binding. No async contribution acceptance. Store owners cannot append foreign/core events; any rejected batch writes zero. Reader has no define or schema/project implementation references. Old Session history is retained without retroactive writer/artifact/Generation attestation. Standard service views are logical SDK restrictions, not Node isolation.

## Task 1 — Root: design and integration contracts

Files: ADR0009, Foundation, this spec/plan, learning guide, Server agent-kernel and integration test/acceptance.

- [x] Record cross-package contracts and dependency/lifetime compatibility before implementation.
- [x] Own public index/SDK export coordination; resolve cross-package collector return migrations.
- [x] Add actual Server regression for correct command owner and event writes through ordinary Pipeline; verify persisted Session and restart with a real loopback SQLite acceptance.

## Task 2 — Core contribution owner: accepted facts and immutable identity

Files: packages/plugin/src/extension-point.ts,seams.ts,kernel.ts; their tests. Do not edit service/plugin-env files owned by service worker.

- [x] RED: caught duplicate command records second falsely; mutable env/original manifest changes identity; canonical same-id fake point can evade capability.
- [x] Add atomic ContributionCheck(name,accept) overload; one-arg validates only. Standard guards validate, call owner and record after synchronous accepted void, never false/throw/thenable. Attribute failures and drain accidentally returned promise without claiming rollback of owner side effects.
- [x] Successful Skills reserve owner/name; rejected attempts can retry. Canonical collection capability and immutable detached governed policy.
- [x] Freeze parsed manifest deeply and use fixed snapshot for every Generation list/error/permission/consumer identity.
- [x] GREEN and check focused Plugin behavior. Record custom guard migration and owner false semantics for root docs.

## Task 3 — Service owner: generic consumer views and event authority

Files: packages/plugin/src/service.ts,plugin-env.ts,plugin-events.ts; new view helper if needed and focused tests. Coordinate index/seams types with root and contribution owner.

Consumes ServiceImpl.forConsumer optional callback and ScopeContext new consumer methods from spec; produces frozen PluginEventReader and owner-required createPluginSessionStore.

- [x] RED: foreign append via env.use and deps; reader raw define/mutable definitions; parent/multi/recreated-ref caller bypass; provider identity versus triggering caller.
- [x] Implement consumer view promise cache on raw registration/scope/consumer; raw factory instance/dispose unchanged, host raw entry preserved. Both resolution paths use fixed actual registration/caller.
- [x] Writer validates stable input type before schema and parsed type after, whole batch once; read passthrough/close noop.
- [x] Registry retains stable frozen definition wrapper; reader get/list returns only frozen metadata, parse/project closed methods and no define. SDK type reader; full registry stays host closure.
- [x] GREEN: binding/cache/lifetime/errors/permission/schema/whole-batch tests; no Runtime imports beyond existing type boundary.

## Task 4 — Builtin owner: install registration policies and skip truth

Files: packages/plugin-builtins/src/host-services.ts,event-registry.ts,tool-registry.ts,provider-registry.ts; corresponding package tests.

Consumes ServiceImpl.forConsumer and reader/writer helpers. Ensure store supply includes real event registry before registration. Return false from existing:skip without counting new owner. Host raw registry can still define/collect; plugin consumers always reader.

- [x] RED: two consumers of store through direct/deps; full event registry available to plugin; skip falsely appears as new contribution.
- [x] Implement safe registrations and explicit error on missing store registry; migrate test fixtures and only necessary false/void collectors.
- [x] GREEN package tests, lint/typecheck/build after Plugin exports are available.

## Task 5 — Root: cross-review and sequential delivery

- [x] Workers cross-review contributions, service views and builtin integration; repair only reproduced issues.
- [x] Run actual Server/Pipeline/SQLite acceptance plus pnpm check, marketplace:check and existing plugin:verify to verify CLI/Skills compatibility.
- [ ] Explicit task-only stage, Chinese Conventional commit, feature push and PR; await both checks, squash, delete feature remote. Panels start from newly verified main.
