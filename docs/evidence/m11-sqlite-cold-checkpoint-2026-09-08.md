# SQLite cold-checkpoint sidecar race

The graph/Restate checkpoint test intermittently failed while copying
`control-plane.sqlite-shm` after Local composition shutdown. A focused provider
test reproduced sidecars remaining after `close()` under Bun 1.4.0; an explicit
garbage collection then removed them. This establishes a deferred-close window
that can race directory inventory/copy, rather than evidence that missing files
should be ignored by the checkpoint verifier.

An initial experiment required a cold checkpoint during every provider close.
It removed the sidecars but failed existing multi-connection migration tests.
That approach was not retained. Ordinary close remains unchanged; Local
composition shutdown explicitly requests `close({ checkpoint: true })` after
stopping its runtime/workflow users. The provider truncates the WAL, verifies
DELETE journal mode and closes. Running startup still selects WAL. This uses
SQLite's supported [journal-mode transition](https://www.sqlite.org/pragma.html#pragma_journal_mode),
not direct sidecar deletion or global garbage collection in production.

The cold-close operation fails with `SQLITE_CHECKPOINT_BUSY` if the transition
cannot complete. It still releases its own handle; a competing connection remains
its owner's responsibility. Callers must not treat failed shutdown as a safe
filesystem checkpoint. The generic checkpoint implementation still verifies
every inventoried file and does not skip WAL data, retry through changing source
contents, or claim online-consistent directory snapshots.

Regression coverage checks sidecar absence before garbage collection, committed
data after reopen, ordinary multi-connection close behavior, and failure with an
active competing reader without lost data. The real Local Restate graph test
exercises shutdown, filesystem checkpoint/restore and approval recovery.

This addresses the reproduced SQLite sidecar window; complete quiescence across
all services, crash recovery and the full M11.9 acceptance matrix remain separate
obligations. The architecture refresh changes only the reviewed Local and
hosted-simple composition source digests, not their acceptance classification.

Validation on this candidate passed type checking, lint and formatting; 1,245
unit/E2E/smoke tests (1,050/126/69); and the local PostgreSQL integration runner,
including 31 database tests, service-loss/restart and backup/restore drills.
The scripted remote-node drill passed but does not certify native execution,
active native cancellation, live-provider usage settlement or the full milestone.
