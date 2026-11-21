# Plugin Authority Database

Stage 6.2a is the persistence foundation for managed plugin installation. It
records candidate versions, selected versions and reviewed trust decisions on
one SQLite connection. The installation manager, artifact-root ownership,
Generation integration and Studio controls are later slices; opening this
database alone does not install or load a plugin.

## Server-private usage

The constructor is an internal Server module, not a public SDK export. A Server
caller can inspect durable authority and check a request before doing preparation:

```ts
import { createSqlitePluginAuthorityDatabase } from './plugin-authority-store.js';

const authority = createSqlitePluginAuthorityDatabase({
  filename: '/absolute/weave.sqlite',
});
try {
  const snapshot = authority.snapshotSync();
  const prior = authority.lookupSync({
    requestId: 'import-example',
    command: {
      kind: 'import',
      previewId: 'preview-example',
      expectedInstallSequence: snapshot.heads.installSequence,
    },
  });
  console.log(prior.kind);
} finally {
  await authority.close();
}
```

The example performs no import and creates no preview. On an absent request,
the later manager must resolve an authenticated preview and validate artifacts
before passing evidence to `commitSync`. Database metadata validation cannot
replace those checks.

## One connection, three logs

The Server-private authority owner stores three append-only streams:

| Log          | Durable facts                                                  |
| ------------ | -------------------------------------------------------------- |
| Installation | Imported candidates, reviewed version selections, removals     |
| Trust        | Existing trusted, enabled, disabled and revoked events         |
| Operation    | Every successful managed request, including a successful no-op |

Import records a candidate without selecting it or granting trust. Activation
and rollback append both a new selection and a new exact trust event in one
transaction, including when the chosen digest was previously trusted. Uninstall
appends removal and revocation together. These operations retain candidate
history and never delete artifact files.

Once an ID has been imported, managed ownership is sticky. The old manual trust
facade rejects every write for that ID, including after uninstall or when the
digest matches. Managed enable only changes an already trusted exact selection;
it cannot recreate revoked trust. Activation is the reviewed trust-grant path.

## Static request identity and replay

Each managed request has a database-wide unique request ID. Its canonical command
includes every review field: digest, manifest, previous selection, expected log
heads, preview ID, intent and immediate timing where relevant. Reusing the ID
with different review content is a conflict. Object key order and the documented
default `immediate:false` do not change command identity.

A successful request that needs no authority change still appends one operation
fact. Retrying that exact request appends nothing. The replay returns the original
durable operation and a newly validated current snapshot; it never returns an
old snapshot to restore. A replay after a later revocation must therefore report
the original decision alongside the current revoked state.

The future installation manager must call `lookupSync` after static input
validation and before checking preview expiry or reading an artifact. The owner
checks again inside the write transaction, before parsing preparation or applying
sequence checks. A retry can then succeed after the original preview expires or
the source disappears. It repeats no copy, trust grant, rebuild or cancellation.

## Commit and application are separate

Managed commits verify expected global installation/trust heads and the reviewed
selection. The owner constructs, validates, detaches and freezes the complete
result before COMMIT. A failed insert, history check or result construction rolls
back all three streams. Successful COMMIT is followed directly by returning the
prebuilt result, without another read, callback or asynchronous gap.

This database records a durable authority decision. It has no Generation,
`applied` field or historical Runtime application log. Later integration must
adopt new authority synchronously after a fresh commit and report any application
failure separately. After a restart, historical application is unknown; current
Generation membership is a separate observation. Replay does not attempt to
apply the saved decision again.

## Existing trust API

`createSqlitePluginTrustStore` keeps its original import path, async methods,
four error codes and error class identity. Its append/read results remain mutable
detached copies, so a caller can edit its copy without rewriting persisted facts.
New managed snapshots and results are deeply frozen detached values.

The standalone constructor owns a private authority connection. The authority
owner's `trust` facade borrows that same connection and has no `close` method;
closing the owner closes both interfaces. Neither facade nests an asynchronous
trust append inside a managed transaction.

## Integrity and limits

Readback validates contiguous safe-integer sequences, row/JSON metadata,
canonical request fingerprints, event links, exact transitions and before/after
state. Manual trust records before first import remain valid. Later manual
intervals are checked against ownership at their historical installation prefix.
Damaged logs fail rather than being silently repaired.

The implementation uses Node SQLite and existing dependencies inside Server.
It does not authenticate preview evidence, verify artifact bytes or coordinate
filesystem ownership. Those guarantees belong to the later manager and ownership
guard. Internal log consistency does not protect against arbitrary SQL writes by
another process with the same user's privileges.

The exact interfaces, failure lifecycle and acceptance cases are in the
[authority design](../superpowers/specs/2026-11-21-plugin-authority-design.md)
and its [implementation plan](../superpowers/plans/2026-11-21-plugin-authority-store.md).

Verification uses temporary real SQLite files, explicit event expectations and
reopen checks. It includes 18 integrity/fault cases for three-stream rollback,
precommit result construction, ambiguous COMMIT, poisoned connection cleanup and
public corruption rejection. One test uses a proxy around a real connection to
inject unreadable native state; it does not claim spontaneous native getter
failure was reproduced. The complete root check passes 2,536 tests, including
744 Server tests. This persistence slice makes no browser, Electron, artifact
ownership or managed Runtime application acceptance claim.
