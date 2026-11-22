# Stage 6.4: GitHub Plugin Acquisition

Date: 2026-11-22. Scope approved in the Stage 6 delivery sequence and the
owner's instruction to continue after the Harness market comparison.

## Scope and references

Acquire already bundled Weave plugins from a public GitHub repository at a full
40-character lowercase commit SHA and an optional relative POSIX subdirectory.
Reuse reviewed import, immutable artifacts, append-only authority and explicit
activation. Catalog discovery remains Stage 6.5. Private repositories, credentials,
branches/tags, npm, builds, Git hooks, submodules and Git LFS resolution are outside
this delivery. A Harness package is not automatically a Weave plugin.

The inspected DeepSeek Harness revision is
`2e39e70496aa02986ca6a820c5d497e816b69d7e`:

- [plugin-market](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/boot/plugin-market/README.zh.md)
  separates configured discovery indexes, compatibility and version display from installation.
- [plugin-market-index](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/util/plugin-market-index/src/types.ts)
  binds Git versions to an HTTPS repository, full commit and optional package path.
- [plugin-manager](https://github.com/deepseek-ai/deepseek-harness/blob/2e39e70496aa02986ca6a820c5d497e816b69d7e/packages/boot/plugin-manager/README.zh.md)
  installs via pnpm and separately authorizes builds. Weave keeps its existing
  prebundled artifact importer and human activation; it does not adopt that package
  execution or HMR model. Marketplace text never grants execution trust.
- GitHub's [Git Trees API](https://docs.github.com/en/rest/git/trees#get-a-tree)
  supplies entry modes, blob IDs and truncation evidence. This implementation
  uses that API and fixed-commit raw file URLs instead of accepting archives.

## Package and network contract

`@weave/plugin-host` exports `GithubPluginSource`, `githubPluginSourceSchema`,
`GithubPluginAcquirer`, `createGithubPluginAcquirer` and `GithubAcquisitionError`.
The source is `{ repository, commit, subdirectory }`; repository is a canonical
`https://github.com/owner/repo` URL without credentials, port, query, fragment or
`.git` suffix. Owner/repository are normalized to lowercase. Subdirectory defaults
to the empty string; nonempty paths have no leading/trailing slash, empty, dot,
dot-dot, backslash or control-character segments. Complete commit input is required;
the installer never resolves a moving ref.

`createGithubPluginAcquirer({ directory, fetch? })` accepts an absolute private
scratch root and an optional transport for deterministic tests. It provides
`withSource<T>(source, use: (directory: string, signal: AbortSignal) => Promise<T>, signal?)`.
One acquirer serializes work and cleans its abandoned UUID operation directories
before a new operation. Unexpected entries, links or non-directory scratch roots
fail closed. Each operation creates a private directory, downloads and checks files,
awaits the callback and removes its operation directory on success or failure.
Cleanup failures are retained, including alongside a primary failure. No source
directory escapes callback lifetime. The caller owns exclusive use of this root.
The Server uses a hidden sibling of its owned store (prefix its basename with `.`
and append `.github-acquisition` in the same parent directory)
so sources do not overlap the immutable artifact store. Other same-user processes
are outside this ownership guarantee, as for the existing local importer.

Only generated HTTPS URLs on `api.github.com` and `raw.githubusercontent.com` are
requested. Requests omit credentials, never add authentication from environment,
and reject redirects. Response-provided URLs are ignored. Traverse the requested
subdirectory using nonrecursive Git tree reads from the exact commit, then obtain
its recursive tree. Reject truncated trees, unexpected entry modes, symlinks,
submodules, duplicate paths, file/directory conflicts and unsafe paths before file
writes. Only regular blob modes 100644/100755 and tree mode 040000 are accepted.
Verify each downloaded file's size and Git blob SHA-1 against its tree entry;
artifact validation then independently computes Weave's directory SHA-256.
The Git blob check binds downloads to the HTTPS tree response; it is not a publisher
signature or sandbox. Write files exclusively, without preserving executable modes.
First fetch the Git commit object and require its SHA to equal the requested
commit; tree-ish IDs alone cannot establish commit identity. Reject portable
case/Unicode-normalization path collisions as well as exact duplicates.

Bounds: at most 8 requested subdirectory segments, 2,000 tree entries, 128 files,
64 payload path segments, 20 MiB aggregate file bytes, 2 MiB per metadata response,
four concurrent file requests, 15 seconds per network request and a 60-second
deadline per acquisition including its callback. The callback receives the effective
signal and must cooperate with cancellation. After deadline/abort, await callback
settlement before removing its files; never leave a live callback racing cleanup.
Enforce actual streamed bytes as well as
declared sizes. Fail on HTTP 403/429 as rate-limited, 404 as unavailable, malformed
or inconsistent data as invalid, and bounds as too-large. Abort cancels outstanding
fetches, waits for workers, then cleans up. Timeouts have their own public code.
The public unauthenticated GitHub API rate limit applies; there is no hidden retry.

## Server authority and HTTP contract

Extend provenance to `LocalDirectoryProvenance | GithubProvenance`, where GitHub
provenance is `{ kind: 'github', repository, commit, subdirectory }`. Existing local
records and table schemas remain valid. A candidate is still identified by plugin
ID and directory digest: importing identical bytes through a second source retains
the first import's provenance and adds only the established no-op operation.
Operation evidence records the actual reviewed source without rewriting history.

Add guarded `POST /plugins/managed/github/preview` with the strict source object as
its JSON body. It performs acquisition and `store.preview` within `withSource` and
issues a normal preview token only after cleanup succeeds. Its response is the
existing preview DTO plus `github: GithubPluginSource`. Existing local preview
responses are unchanged. The preview map keeps canonical remote provenance and
reviewed digest/manifest/files/bytes, but retains no downloaded directory.

Keep `/import` and its durable command unchanged. Durable request lookup runs
before token, network or filesystem requirements, so a saved replay never fetches.
A fresh GitHub import reacquires the same canonical source; the artifact stage
binds the reviewed digest/manifest/files/bytes to this new temporary directory.
Local directory imports retain their exact normalized path binding. A content
mismatch invalidates the preview. Cleanup completes before any authority commit.
Recheck the lease, heads, expiry and namespace after acquisition using the existing
commit protocol. Import never rebuilds or grants trust; activation is unchanged.
Shutdown/ownership loss abort acquisition through the installer's existing lifetime
signal. Track entire preview acquisitions and await their drain before releasing
the owned store lease, including startup failure and unpublished-host cleanup.
`closeSync` blocks admission and aborts; a separate asynchronous drain completes
cleanup. Scratch recovery runs only while that lease is held.
A 60-second bounded request may serialize other management work; current
healthy generations continue serving runs.

Catalog candidate DTOs preserve `provenance: 'local-directory'` for old clients'
local records; GitHub candidates have `provenance: 'github'` and a required `github`
source object. Source URLs/commit/subdirectory are intentionally public review data;
temporary paths, local provenance paths, response bodies and private causes remain
private. GitHub preview DTOs also echo canonical source for client comparison.

New fixed public errors: `plugin-github-invalid` (400),
`plugin-github-too-large` (400), `plugin-github-unavailable` (502),
`plugin-github-rate-limited` (429), `plugin-github-timeout` (504).
Unexpected disk/cleanup failures retain the existing generic management failure.
Delivered caller/lifetime cancellation retains installer-unavailable semantics.

## Studio contract

Add a GitHub source choice next to local directory import. Collect repository URL,
full commit and optional subdirectory. Validate input and the echoed source, show
loading and a cancel action, and discard late responses after edits, closure or
management invalidation. Use the App-owned management gate and existing import
review/receipt/retry flow. Review displays canonical source, full commit,
subdirectory, actual manifest, digest and declarations. Candidate history displays
the first imported GitHub source across refresh/restart. Import and activation remain
separate actions. No browser/desktop token storage or new Electron bridge is needed.

## Verification

Package tests cover exact commit/subdirectory URL generation, no redirects or
credentials, tree/blob/size mismatch, modes, unsafe/duplicate/conflicting paths,
truncation, streamed bounds, timeout/cancel, worker draining, cleanup, recovery and
no execution. Server tests cover provenance persistence/reopen and no-op semantics,
guarded strict routes, canonical preview source, exact staged bytes, mismatch,
no grant/rebuild, fresh cancellation, and saved replay with network disabled.
Studio tests cover source validation, review, cancellation/late response, shared
gate, source history and existing local import compatibility. Run focused checks,
root `pnpm check`, a real loopback/browser smoke, and a public GitHub acquisition
smoke where network availability permits. Live retrieval of a non-plugin file tree
does not demonstrate a third-party Weave plugin's runtime compatibility.
