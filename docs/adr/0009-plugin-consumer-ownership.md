# ADR 0009: Plugin consumer and contribution ownership

- Status: Accepted
- Date: 2026-11-22

Before panels use plugin event namespaces and commands, repair actual SDK owner
binding. Capture and freeze parsed manifest identity. Governed standard seams
record only synchronous owner acceptance, with explicit false for skip, and close
the contributor API when collection ends. A rejected attempt is no contribution.

Add registration-owned `ServiceImpl.forConsumer` and apply it to both direct
plugin use and service factory dependencies, binding the latter to the factory's
provider. Host resolution stays raw; raw lifetime and per-consumer view caches
remain separate. Standard builtins supply owner-bound Session writers and event
readers without registry mutation or implementation exposure. Session store
injection requires its associated event registry.

No new package, dependency, durable event envelope or Runtime behavior is needed.
Existing own-event plugins retain their workflow; cross-owner writes, raw registry
mutation, mutable identity and failed-contribution attribution are corrected.
The exact API constant stays 1.0.0 under the current pre-release policy; affected
public helper/guard contracts require the migration documented in the design.
Historical events gain no retroactive producer, artifact or Generation attestation.
This is logical governance of the SDK, not isolation of trusted Node code.

See the [design](../superpowers/specs/2026-11-22-plugin-owner-boundary-design.md)
and [implementation plan](../superpowers/plans/2026-11-22-plugin-owner-boundary.md).
