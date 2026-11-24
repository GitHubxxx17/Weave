# Studio Explorer rendering design

Base: conversation rendering PR #111, origin/main bf7ab25.

## Studio Explorer rendering contracts (PR2)

PR2 begins from the latest merged conversation-rendering main and changes only browser presentation and synthetic performance tooling. Server tree/file/diff DTOs, max50,000 listing cap and2,000,000-byte viewer cap remain the authority.

The browser index sorts children once and caches normalized search paths per loaded listing. `createFileTreeModel(files,truncated)` and `fileTreeRows(model,expanded,query)` produce exact path/name/depth/parentPath/isFile/siblingPosition/siblingCount metadata. Directory and search rows use the same fixed28px window, overscan8, stable path keys and one focused path pin. Roving keyboard navigation resolves a logical path, scrolls it into the mounted range, then focuses only that exact current row. Diagnostic data attributes expose counts/path/height without execution access.

FileTreePanel preserves its existing keyed ComposerOwner lifetime and captured onAddFile callback. Each tree refresh and selected-content effect creates a fresh AbortController and monotonically increasing epoch. Completion checks the effect owner, Project and exact selection before publishing; A→B→A cannot accept A's previous response. fetchFileContent/fetchFileDiff gain optional AbortSignal arguments with no response change. Unmount aborts network observation and fences highlight/diff preparation; no server work/cancellation authority is added.

Filtering defers the expensive result projection while keeping input urgent and exposing pending. A truncated listing is explicit. Existing splitter, attachment8-file limit, lazy content/diff and panel keepAlive:false remain. No tree cache outlives the keyed panel. Viewer worker/line window is outside this change and measured only as a diagnostic.

Synthetic tree fixtures validate file counts1000/10000/50000, wide-root/wide-src shape and exact listed paths, return existing HTTP DTOs and never read real workspace paths. Before/after18sample matrices use fresh isolated fixtures/browsers,1440×1000,no-store and3repeats. Contention uses one5000tool-history+50k-tree+100×20ms execution sample and verifies stream/draft/filter/selected path together. Viewer diagnostic covers100KiB/400KiB/near2MB ASCII/multibyte single/multi-line with exact UTF8 bytes. Plain/highlight/diff timings are separately identified; they are synthetic and do not prove filesystem or model throughput.

Tree model validation preserves Server path identity rather than applying attachment eligibility. It rejects only structural noncanonical paths (empty, absolute POSIX path, empty/dot/dotdot components), NUL and file/directory conflicts. Colon, backslash, non-NUL controls, Unicode composition and long readable filenames remain exact; attachment filePathSchema may still disable adding them to a prompt. No display normalization is used to construct requests.


Execution acceptance and reporting:

- True fixed-window bound is ceil(viewportHeight / 28) + 17 + focusPin, allowing one partial row at a fractional scroll offset; focusPin is at most one extra row.
- Preserve exact Server listing order for filtered files; sort only the tree's directory-first sibling arrays. Structural validation rejects nonrelative/empty/dot segments, NUL and file/directory conflicts; it does not reuse the stricter attachment eligibility schema or normalize valid POSIX names.
- The before tree matrix is measured against PR1's frozen production dist. Copy its source/dist manifest and actual failures, then run after with the same fixture and probe actions. Per-stage timing excludes separately recorded correctness traversal cost; report that distinction.
- Viewer diagnostics are observational. Content highlighting gates UTF-16 code units at 400000. Existing diff generation has its own >2000-lines syntax and >=1000-code-unit intraline safeguards, and synchronous patch construction remains main-thread work. Do not claim these safeguards impose an overall CPU bound. The current diff response lacks the content truncation marker; record this existing limitation rather than promising full-file comparison near the viewer cap.
- Synthetic contention must verify all 100 ordered text tokens, tool summary, durable reload, composer draft, query and exact Project/path after simultaneous edits. Missing/failed samples remain visible in raw artifacts and reports.
- Final checks include full pnpm check, independent review, 50k tree first/middle/last exact selection and Home/End/Arrow keyboard behavior in a real browser. Timing thresholds remain diagnostic, outside deterministic CI.
