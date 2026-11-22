# Install and maintain a Skills text package

A declarative Skill package contains instructions and text resources. It has no
JavaScript entry and requires no build. Weave validates its bytes, imports an
immutable candidate and asks for an independent trust and activation decision.
Installation alone does not add instructions to a conversation.

## Use the maintained example

The repository includes
`examples/plugins/weave-coding-skills`, authored for Weave. It provides
`review-change` and `verify-change`, each with an actual referenced checklist.
It is source content in this repository, not a claim that a marketplace release
has already been published.

Open the plugin marketplace from the left navigation. Import that local
directory, review the text-package manifest and exact digest, and then activate
the imported version. In a Session, choose the resulting Skills in the composer
or let the model progressively load applicable instructions with the normal
Skill tools. The source is `plugin:weave-coding-skills/<name>` and the existing
history distinguishes requested, prepared, delivered and failed reads.

The same managed controls update, roll back, disable and revoke text packages.
Running turns retain their admitted Generation's immutable data. New turns use
the current eligible version. Resource-only edits change the Skill bundle ref;
a stale selection is rejected instead of silently selecting the new bundle.

## Author a package

```text
my-skills/
  weave-plugin.json
  README.md
  skills/
    review-change/
      SKILL.md
      references/checklist.md
```

```json
{
  "schemaVersion": 2,
  "kind": "skills",
  "manifest": {
    "id": "my-skills",
    "name": "My Skills",
    "version": "1.0.0",
    "apiVersion": "1.0.0",
    "host": "declarative",
    "capabilities": ["skill"],
    "contributes": { "skills": ["review-change"] },
    "permissions": []
  }
}
```

Declare every Skill name explicitly; it maps to `skills/<name>/SKILL.md` and must
match the frontmatter name. Use the
[supported Skill frontmatter and invocation flags](2026-11-22-skills.md).
Only Skills contributions are accepted. There is no `entry`, secondary service,
tool, hook, provider, command, callback or permission declaration in this format.
An ESM plugin that contributes Skills remains an executable plugin and uses the
existing schema-1 descriptor.

Optional root documentation files are `README.md`, `LICENSE` and `NOTICE`, each
at most 64 KiB. Include a license only when the publisher has chosen and can grant
it; Weave does not invent licensing for source examples. Resources are UTF-8 text
without NUL. Scripts remain text resources and are never executed by this loader.
Binary files, symbolic links, special files, missing or undeclared bundles and
unsafe paths are rejected.

A package holds at most 16 Skills, 64 aggregate resources, 256 KiB per resource
and 2 MiB aggregate resource bytes. SKILL.md/frontmatter limits remain 64/8 KiB.
These deliberately fit the current frozen inline contribution contract; the
larger standalone disk Skill inventory limits do not apply to an installable
text package. General artifact and GitHub traversal limits apply as well.

## Publish fixed source and review updates

Push the prepared directory to a public GitHub repository yourself, choose its
actual full commit and exact subdirectory, then use the existing
[marketplace submission workflow](plugin-marketplace-publishing.md). The entry
helper validates the actual fixed payload without importing it. A branch, tag,
local receipt or a future placeholder SHA does not establish a published source.

The full manifest and whole directory digest bind the reviewed package type and
content. Editing a README can require a new artifact review even when the Skill
instruction ref stays unchanged. Do not edit an immutable published version in
place: publish a new version/commit and preserve older release metadata for
reviewable rollback.

An index entry is discovery metadata. A publisher cannot grant itself official
status, trust or activation. Text instructions can influence the Agent, so they
still require review. Their content never grants tools, bypasses approvals or
changes workspace access.

## Compatibility and host API

Plugin API remains 1.0.0. This release adds the recognized declarative host and
schema-2 descriptor. Old strict hosts reject the new vocabulary before import;
existing schema-1 ESM plugins keep their behavior. Persisted candidate and saved
operation semantics remain unchanged, with no automatic default fields added to
historical fingerprints.

`@weave/plugin-host` exports
`inspectPluginPayload(directory,{hostVersion?,signal?,limits?})` for inert
validation. It returns a checked artifact containing the descriptor, digest,
directory, file/byte counts and an entry-or-Skills data union. It creates no
managed store and calls no author module. Omit `hostVersion` for offline payload,
API and host checks; pass it to check the declared engine range as well. Actual
discovery and managed admission still enforce engine compatibility. The same validation supports discovery,
artifact storage and marketplace entry generation. The actual managed lifecycle
continues to verify authority around preparation and Generation publication.

The [repository-local developer CLI](2026-11-22-plugin-developer-cli.md) provides
`plugin:create --template skills`, validation, build and pack commands. Trusted
ESM plugins can also use the [declarative right-panel SDK](2026-11-22-plugin-panels.md).
The main marketplace stays on the left; schema-2 Skill packages remain text data
and do not become panel providers or executable plugins automatically.

## Verification for this release

The final integrated `pnpm check` passed all formatting, lint, type, build and
3,761 behavior tests. `pnpm marketplace:check` confirmed the maintained index is
up to date; its current zero external entries are not a live GitHub download test.
Independent Host, Server and Studio reviews found no unresolved actionable issue.
Review fixed a discovery race that could combine an initially observed manifest
with a newer digest/data snapshot; discovery now rejects the changed identity.

Real loopback HTTP/SSE acceptance used the repository's exact coding example,
actual shared Tool Pipeline and a scripted provider. It verified inert no-entry
import, separate activation, instruction/resource delivery, durable provenance
after SQLite restart, update, rollback and revocation. Separate integration tests
hold a running turn across an update and verify that it reads the old immutable
resources. Fixed GitHub acquisition fixtures exercise the no-entry path and saved
offline replay; no live third-party compatibility claim is made.

Actual Studio fixture browser acceptance passed at 1440×1000 and 390×844 through
market details, source review/import, separate activation, Skill picker/preview,
exact selection submission and restored history. This browser fixture validates
the frontend; the separate loopback flow establishes real backend persistence.
Neither requires a live model. Existing SQLite experimental and Vite chunk-size
advisories remain toolchain advisories and are not failed checks.
