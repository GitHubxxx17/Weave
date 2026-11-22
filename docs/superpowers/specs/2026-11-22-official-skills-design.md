# Weave-maintained Skills and exact official release identity

Date: 2026-11-22. Follow-up after the declarative panel SDK merge.

## Scope and evidence

Ship the self-contained `plugins/official/weave-official-skills` schema2 text bundle with four separately selectable Skills: weave-guide, weave-plugin-author, weave-skill-author, weave-mcp-guide. Weave maintains original text; Codex/Harness/Kimi reference commits are already verified in docs/learning/2026-11-22-official-plugin-references.md. Reuse exact pinned evidence; do not represent curated third parties as upstream-authored, copy unlicensed text, or claim inherited security.

Update panel references only after the actual SDK merge, bind source-notes to that actual full SHA, and verify examples with actual CLI/schema. Root README installation, trust, activation and per-turn Skill delivery are distinct. No ESM,permissions,entry,executable resources,network installers or dependency changes. Resources self-contained within bundle; root docs references are provenance only, never required runtime lookups.

## Official identity

Current builtin entries remain code-owned official and kindbuiltin. Index files remain strict schema1 with no category input. GitHub entries gain host-derived categoryofficial/community; kindgithub always uses acquisition/install/review/activate, including official.

Create code-owned official release families, each with id, display name/description/tags/publisher and an append-only array of exact released manifest/source tuples. Source is canonical lowercase repository, full40hexcommit, and exactsubdirectory. Compare complete normalized parsed manifest JSON recursively; do not reduce to name/version/capabilities alone. Repo source type remains existing github shape.

Protected distributed official IDs are reserved even before first release, but distinct from builtin reservedIDs which reject all index entries. Unknown versions, altered source or manifest, and mixed known/unknown release arrays reject the whole index at admission. Ordinary community entries containing publisherWeave, authorWeave, weave-prefix or source-nameWeave remain community. An exact official tuple mirrored by a custom index remains official maintained content while index provenance remains displayed. The host overrides display metadata of official entries so an index cannot spoof the official package name/maintainer text. The badge changes no engine/trust/permission/approval rule.

Use one reusable `assertOfficialMarketplaceEntry`/classifier in the shared indexschema refinement so local snapshots, fetched indexes, submission validation, generator/check and live projection agree. Avoid schema/module cycle: official release module can depend on `artifactManifestSchema` and `githubPluginSourceSchema`, never on marketplace schemas; classification receives already-parsed structural entry. Deep freeze code-owned release records. Runtime projection rechecks family match fail-closed, including callers bypassing load with typed fixtures.

Empty first-release family is valid hostconfiguration but admits no index release. Immutable actual first content merge SHA is not yet known and MUST NOT be guessed, zeroed or replaced with a branch/tag.

## Delivery stages

A. New feature branch from latestmain: content+host classification mechanism, docs, empty allowlist; tests may inject private fixture release table in pure classifier tests but production has no fabricated release. Actual built schema2 validation, inert example compile, local managed import/reviewactivation and actual Skill body/resourceEOF + durable audit/restart verify content. Review23scenario rubric independently using fixed original content+actualsource. No claim live model universally obeys.

B. After A squashed, fetch actualmainfullSHA; fresh release-index branch. First read the actual committed descriptor at the content merge SHA and register its complete parsed manifest plus canonical repo/full SHA/subdirectory in the code-owned family. Then run the real existing marketplace:entry helper to independently acquire pinned bytes and verify that exact identity; shared index admission otherwise rejects an empty protected family. Add only the actual generated submission/index after this gate. Preserve old release tuples on future updates. All generator/check paths pass and actual GitHub acquirer provenance verified. Packageddefaultindex becomes installable in newbuild; no external marketplace deployment claim absentactualdeployment.

## UI contract

Server githubEntry category enumofficial/community, Studio same independentmirror. Official github detail says Weave维护/需要安装; button routes remain githubselection; builtin shows已内置. Index source independently shown. Existing selected managed activeversion remains actual managedcatalog authority. Test actual UI fixture official github not builtin.

## Validation

- CLI artifact/source inspectors read all4body/25resources and crossreference paths. Tool+Command examples compile/build against trueSDK; MCP JSON trueServer schema; no execute resources.
- Official classifier negativecommunity spoofing and protectedID wrongrepo/commit/path/fullmanifest/version/mixed. Exact release fixtures as pure injected test identities, never realindex pins.
- Shared index entry admission through local/fetch/generator/prepare helpers; no category inputaccepted. BothSchemas and actualUI officialgithub installflow.
- Real SQLite/HTTP/SSE managedimport remains inert, explicitreviewactivation yields4Skills. Exact catalogrefs bodyEOF/resources via normalPipeline+durableaudit. Resourcechanged stale; disable/revoke newturn unavailable; restart after author dir removed staysworking immutableartifact; oldGenerationturn retained where existingcontracts require.
- Content evaluation independent rubric positive/negative/missingcapability23cases; document evidence limits, no keywordgrep as modelperformance.
- Full pnpmcheck and marketplacecheck after relevant focused gates; realSHA acquisition as separate networkgate.

## Explicit compatibility and reservation decisions

Protected distributed IDs belong only to marketplace admission, not builtin/startup/installer reserved IDs. Explicit local installation remains subject to ordinary namespace and review rules and gains no official attribution. A protected unknown release rejects the complete index. An older host retains its last-good cached index with unavailable/stale status, or has no catalog on first invalid fetch; it does not silently downgrade/drop releases. Packaged indexes ship with matching host policy. A later per-release attribution design would be required to relax this.

Both response schemas require publisher Weave when categoryofficial, while kindgithub stays installable. Selected-index status uses generic wording and appears in official filter too. Source notes cite the already-existing product-contract/panel merge SHA; the release record externally pins the later content SHA, avoiding self-reference. The content scenario rubric must reflect the actual merged panel SDK.
