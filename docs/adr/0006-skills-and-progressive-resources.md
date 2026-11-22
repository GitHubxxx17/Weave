# ADR 0006: Skills and progressive resources

- Status: Accepted
- Date: 2026-11-22

Skills are declarative instructions with optional inert resources. Protocol owns
pure refs and metadata; Session owns append-only provenance; Runtime owns actual
turn context and generic loader tools; Plugin owns a governed inline extension;
plugin-host owns bounded filesystem reads; Server composes project/user/builtin
and enabled plugin sources; Studio uses HTTP only.

Choose exact source-qualified identities plus instruction and complete bundle
SHA-256, preparation at actual queued admission, and generation/turn-bound lazy
resource reads. Reject stale refs rather than substituting a same-name source.
Selections do not carry between turns and cannot grant tool or management powers.
Required audit is a host outer Pipeline receipt boundary so isolated observer
failures and recoverable tool catches cannot hide lost provenance.

Keep base plugin API 1.0.0. The skill capability and extension are additive,
optional recognized vocabulary. Existing plugins keep their ABI and behavior;
old hosts reject unknown capabilities before import. An incompatible future SDK
change requires an explicit compatibility migration, not blanket major matching.

The alternative of permanent prompt sections loses progressive loading; command
text expansion loses exact identities; a new script executor duplicates existing
workspace/approval boundaries. All are rejected. Pure skill-only installation is
a following distribution topic and will not require fake executable ESM.

The [design](../superpowers/specs/2026-11-22-skills-design.md) defines contracts,
limits, failure behavior and pinned reference decisions before implementation.
