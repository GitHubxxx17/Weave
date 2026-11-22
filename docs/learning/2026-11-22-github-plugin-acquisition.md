# GitHub plugin acquisition

Stage 6.4 extends the managed installer to public GitHub sources. The source is a
repository URL, a full commit SHA and an optional plugin subdirectory. The selected
directory must already contain `weave-plugin.json` and its bundled ESM entry.

## Use from Studio

Start a bound Server profile as described in [local plugin installation](../../README.md#local-plugin-installation).
Open Plugins, choose GitHub as the source, enter the repository URL, full commit
and subdirectory, then preview. The review shows the fetched manifest, declarations,
permissions and actual directory SHA-256, together with the canonical source.
Confirm import to save a candidate; review and activate that candidate separately.

Use a URL such as `https://github.com/owner/repository`. The first version accepts
public repositories only, without credentials, branch names, tags, Git URL suffixes
or build steps. Use the complete lowercase 40-character commit from GitHub's commit
page. A monorepo plugin can use a relative path such as `plugins/my-plugin`.
Leaving that field empty selects the repository root. A repository containing only
TypeScript source needs a published bundled directory before it can be imported.

The acquisition makes unauthenticated GitHub API requests. GitHub's rate limit can
temporarily prevent preview or fresh import. A saved import's original request can
still be retried without a network fetch. Preview cancellation stops acquisition;
closing a review does not undo a previously submitted durable decision.

## Identity and lifetime

The acquisition first checks the requested commit object, walks its selected Git
tree and validates each raw blob against the tree's advertised length and Git
SHA-1. The existing artifact validator separately derives the reviewed directory
SHA-256 and validates the Weave descriptor and host compatibility.

Preview removes all downloaded files before returning a token. A fresh import
fetches the same fixed source again and stages only content matching the reviewed
manifest, digest, file count and bytes. Local-directory imports retain their
existing normalized path binding. Both paths then use the same namespace checks,
append-only candidate records, review heads and independent activation.

Candidates retain the first imported provenance when identical content is imported
again from a second source. That second request's operation evidence records its
reviewed source. Source and version text do not grant trust. The installer never
executes acquired code, package managers, Git hooks or build scripts. Loaded
in-process plugins retain Weave's existing execution boundary; acquisition does
not provide OS isolation.

The scratch store is a hidden sibling of the bound artifact store. Acquisitions
are serialized and bounded; recognized abandoned operations are recovered before
the next acquisition. Shutdown aborts and drains acquisition before releasing the
artifact store lease. Immutable published artifacts retain the existing history and
old-turn rules.

## References and validation

The [design](../superpowers/specs/2026-11-22-github-plugin-acquisition-design.md)
records the pinned Harness market/index/manager sources and their differences from
Weave, exact transport limits, error mappings and verification cases.
The [implementation plan](../superpowers/plans/2026-11-22-github-plugin-acquisition.md)
tracks acquisition, Server integration, Studio and integrated verification.

On 2026-11-22, the final root `pnpm check` passed formatting, lint, TypeScript,
3,448 tests and all package/app builds. This includes 84 acquisition tests, 1,238
Server tests and 600 Studio tests. Local HTTP gzip tests verify Node fetch's
decompression behavior alongside raw length and blob checks. The existing Studio
bundle-size advisory remains; no dependencies were added.

A real browser against Vite and the real loopback Server, SQLite and filesystem
verified canonical GitHub review, candidate import with no trust or publication,
separate activation, and active version/source retention after Server restart.
The GitHub upstream transport used deterministic commit/tree/raw fixture responses;
the browser-to-Server requests and artifact/authority operations were real. Scratch
was empty after acquisition. Independent Studio, backend and whole-branch integration reviews passed. Review
reports and browser evidence are retained in the task workspace.

The public fixed-commit smoke attempted Weave's `docs/adr` at commit
`b1fd9ce702e438d284192bb2939a3e166ae1d952`. The anonymous GitHub API reported
`remaining: 0` of 60 and acquisition returned `plugin-github-rate-limited`, cleaning
its temporary files. An earlier direct commit query returned the expected commit
and tree, but a full live acquisition did not complete. No authentication or retry
workaround was used. Full live GitHub retrieval and packaged Desktop distribution
acceptance are not claimed by these checks.
