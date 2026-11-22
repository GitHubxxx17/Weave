# Plugin marketplace indexes and publication

Date: 2026-11-22. Status: approved product direction; implementation contract.

The owner approved borrowing DeepSeek Harness's index mechanism after reviewing
its current implementation. This extends the in-progress Stage 6.5 marketplace,
not the separately preserved Stage 6.4 acquisition change. No external publication,
repository creation, commits, or merging are required to implement this contract.

## Reference and choices

Verified Harness master `d98f5d68519215da48f3002da2cb9c9d2068d81d`:
[index guide](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/docs/user/guide/plugin-market.zh.md),
[generator](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/apps/plugin-market-generator/README.zh.md),
and [optional market](https://github.com/deepseek-ai/deepseek-harness/blob/d98f5d68519215da48f3002da2cb9c9d2068d81d/packages/experimental/plugin-market-bundle/README.zh.md).
Adopt independent static catalogs, multiple sources, fixed installation targets,
and separation of discovery from installation. Harness has no official online
index at this revision. Weave adds a repository-maintained default directory and
a GitHub PR collection workflow. Directory inclusion never certifies authors or
grants runtime trust. Existing Foundation Codex/Kiro policy and generation choices
continue to apply; no external sandbox guarantees transfer.

Keep GitHub single-file ESM payload support: npm installation, lifecycle scripts,
mutable Git installation refs, Git credentials, account publishing servers and
arbitrary browser code remain outside this change. An index GitHub blob URL may
be normalized to raw JSON; other HTTPS JSON endpoints are supported. An arbitrary
Git clone transport is unnecessary for static indexes and is not introduced.

## Boundaries and format

Server owns index reading, settings persistence, fetching and projection. Runtime,
Session, plugin authority and plugin-host loading contracts do not change. Studio
uses HTTP only, with its own Zod DTOs. Developer tooling lives in Server and shares
its strict index validator. No new dependency or new package boundary is needed.

Retain the existing schemaVersion 1 catalog: at most 512 KiB, 100 plugins,
20 releases per plugin, 10 tags. Each release contains the complete validated
managed manifest and canonical GitHub repository, full lowercase 40-hex commit,
and explicit subdirectory. Reject duplicate IDs/versions, reserved IDs and
manifest identity mismatches. Server computes compatibility; index cannot claim
official category or publisher verification. A source may additionally supply a
bounded title; source settings name remains available when the index fails.

## Catalog service and HTTP

Keep legacy `pluginMarketplace` cached catalog support for createApp callers.
Add an optional `pluginMarketplaceManager` to the app options. Its service owns:

- A built-in `weave` source: actual code-owned official builtins plus the checked-in
  `marketplace/index.json` community directory. The directory starts honestly empty.
- An `operator` source when the existing absolute catalog option/environment is set.
- At most ten user-added remote sources. Canonical URL identity prevents duplicate
  additions. HTTPS only, no credentials or fragments; normalize GitHub blob URLs
  to raw JSON. Configuration performs no network request.

GET `/plugins/marketplace/sources` returns
`{schemaVersion:1, sources:[{id,name,url,kind:'builtin'|'local'|'remote',
status:'ready'|'unfetched'|'unavailable',stale:boolean,removable:boolean,
fetchedAt?:ISODate,errorCode?:string}]}`. File paths are not exposed: builtin/local
URL is null. GET `/plugins/marketplace?sourceId=...` projects only that source plus
actual builtins, and adds optional `indexSource:{id,name,url}` to the existing DTO.
Unknown source returns 404. GETs use cached memory only, with no network or file IO.
No query preserves the legacy default (operator when configured, otherwise weave).

POST `/plugins/marketplace/sources/add` accepts `{name,url}`; POST
`/plugins/marketplace/sources/remove` accepts `{id}`; POST
`/plugins/marketplace/refresh` accepts `{sourceId}`. Return the sources envelope
after successful mutation/refresh. Every POST uses the existing JSON, loopback
Host, Origin and Sec-Fetch-Site guard and bounded JSON parsing. Source mutations
do not alter plugin trust, selection, generations or agent state. No agent tool
can manage index sources. Builtin/operator entries cannot be removed.

Only explicit refresh fetches remote content. Use HTTPS GET, omit credentials,
reject redirects, 15-second total timeout including response body, and a streaming
512-KiB cap independent of Content-Length. Strict UTF-8/JSON/schema checks precede
cache publication. Requests to explicitly chosen HTTPS endpoints use no host
credentials or authorization headers. Do not follow index-provided URLs while
reading the catalog. Failure reports a safe code, keeps last successful data as
stale, and does not affect agent startup. Source identity is shown in the page
and detail; content remains attributed third-party data.

Serialize settings mutations and refresh application. Persist source add/remove
facts append-only in a bounded, validated log beside the Server database, sync
before publishing memory state, and replay on restart. Refuse writes after log
corruption rather than overwrite it; cached builtin discovery and agent startup
remain usable. Bound active remote count and log length, reject symlink files.
No cross-process shared-writer support is claimed. Closing the manager synchronously
rejects new work, aborts in-flight network work and drains queued persistence;
Server owns close/drain on both normal and failed startup.

## Studio

Add a source picker and source management area to Discover, with add/remove,
explicit refresh, useful failure/retry state and source attribution. No source
configuration or plugin acquisition on mount. GET reads on mount are allowed.
Clear selected plugin details when switching source; prevent late GET responses
from replacing newer source data. Keep previous catalog on refresh failure and
label stale data. Preserve the App-owned plugin management gate and exact frozen
manifest/source handoff. Source removal never uninstalls plugins or revokes trust.
Installed and all chat/terminal navigation behavior from Stage 6.5 remains intact.

## Maintained directory and developer workflow

The canonical in-repository collection is `marketplace/submissions/`; generated
`marketplace/index.json` is checked in and packaged with the repository. Do not
fabricate plugin listings or publish a remote URL that does not yet exist.
Each submission is one strict catalog plugin entry containing fixed releases.
The generator validates and deterministically sorts entries/releases and rejects
duplicate identities. It never imports plugin code, builds dependencies or runs
scripts. Output is written only after all input passes validation.

Provide `pnpm marketplace:generate` and `pnpm marketplace:check` backed by a
Server CLI. Check compares deterministic expected output with the checked-in
index and fails on invalid submissions or drift. Integrate check into CI after
the normal build, without external network dependencies. A CLI entry helper
accepts explicit metadata and a pinned GitHub source, acquires it through the
existing read-only bounded acquirer, reads the actual descriptor, and emits a
validated submission for review. It does not install, trust or activate code.

Document developer build responsibilities, submission format, exact commands,
source/version update process, reviewer identity/permissions/source checks, and
GitHub PR target in this repository. Add a dedicated submission PR template.
External Pages deployment or a separate catalog repository can follow explicitly;
the local collection and validation are fully useful before hosting is enabled.

## Verification

Behavior tests cover persistence/restart/corruption and failed writes, concurrent
operations/close, input guards, duplicate URL/limit/remove rules, bounded timeout
and stream reads, redirects/schema/UTF-8 errors, stale cache retention, reserved
IDs, pure GET, source switch races, UI source management and exact install handoff.
Tool tests cover deterministic generation, invalid/duplicate submissions, drift,
non-execution and actual acquired-manifest validation. Run root pnpm check,
independent review and real browser desktop/mobile smoke. Record limits honestly:
no live third-party plugin population, hosted deployment or author certification.
