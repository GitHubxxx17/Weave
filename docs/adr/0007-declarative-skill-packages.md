# ADR 0007: Declarative Skill packages

- Status: Accepted
- Date: 2026-11-22

A pure Skill distribution must not require a dummy ESM entry. Introduce a strict
schema-2 `kind:skills` descriptor with `host:declarative`, only the skill capability,
explicit Skill names and empty permissions. The host validates bounded text data
and uses its own adapter to register frozen contributions in the existing kernel.
It never imports author code. A package has at most 16 Skills, 64 aggregate text
resources and 2 MiB resource bytes; ordinary per-file and artifact limits apply.

Reuse immutable artifact storage, fixed GitHub sources, exact manifest/digest
review, separate activation, authority replay, namespace and Generation retention.
The current full manifest already binds the new host, so no redundant persisted
artifact type, default normalization, request fingerprint migration or marketplace
schema revision is introduced. Legacy schema-1 ESM semantics remain unchanged;
old strict hosts reject the additive vocabulary before import.

The alternative of copying into user Skills roots loses managed selection and
revocation. A fake executable entry misrepresents data and creates an unnecessary
execution path. A new pinned-disk contribution seam for large or binary resources
adds lifecycle contracts without a present use case. Those alternatives are not
adopted in this release. CLI authoring and custom panels remain separate topics.

The [cross-package design and plan](../superpowers/specs/2026-11-22-declarative-skill-packages-design.md)
defines the payload, compatibility, ownership and acceptance before implementation.
