# Pi Durable frozen receipt snapshot — issuer boundary and reader

Status: local source and tests only. Nothing here is wired into construction, startup,
recovery, a composition root or the package index, and no activation is implied.

## Decision this implements

A native abort receipt may be read from stored state only through an **opaque,
SDK-issued, detached, coherent snapshot**. The reader never accepts a caller-supplied
path, hash or "coherent" boolean, never reads a live database or WAL, only reads
(SELECT-only) and fails closed.

## What exists

- `native-receipt-snapshot.ts` defines the opaque handle `PiIssuedReceiptSnapshot`, the
  refusing-by-default issuer port (`UnavailablePiReceiptSnapshotIssuer`), the issuer seam
  `sealPiReceiptSnapshot` and the reader `readPiFrozenReceipt`.
- The handle exposes no path, hash, store, statement or flag. A plain object, JSON clone,
  prototype child or proxy of a real handle is refused.
- The issuer must attest, as sealed provenance and not as caller input, that the cut is
  detached, coherent and read with SELECT only, and names the session, conversation,
  restore generation and owner epoch. The ledger is copied and frozen when sealed.
- The reader validates the whole ledger before any result: every entry must be a
  strict, well-formed receipt and `(conversation, request)` must be unique, else
  `LEDGER_INVALID`. The same request in another conversation is
  `CROSS_CONVERSATION`, never absent. It then checks the session and every request
  pin (digest, target, expiry, turn, inference) and returns `found` or `absent`.
  `absent` is not proof that the effect never happened live.
- A result is historical evidence. It never authorizes an effect or settles a journal.

## What does not exist

- No production issuer. Quiescent capture (owner closed and checkpointed, or an SQLite
  backup under exclusive lock), who attests it and how the SDK replays
  `pi.guarded-abort-receipts` from `documents` / `document_revisions` without opening
  the store writable are undecided and belong to the SDK or a separately authorized
  change. The compat patch is untouched.
- `sealPiReceiptSnapshot` is not exported from the package index, so nothing in production
  can mint a handle. The brand is encapsulation, not cryptography, so a real issuer must
  also be trusted by construction.
- No backup/restore, upgrade, drain or rollback acceptance (#1025, #942) is claimed.

## Relationship to the publication classifier

This module is independent of `classifyPiNativeCancellationPublication` (CP #1311):
neither imports the other, and each builds and tests alone. A future consumer could feed
a `found` receipt to the classifier, but nothing does, and neither grants authority.
Nobody acts on a `receipt_unpublished` label in this increment; recovery stays advisory
and unwired until all-writer coverage, fencing/authority validation and a separate
root review exist. The caller pins carry no attempt identity, so cross-attempt checks
belong to the classifier, which sees the journal record.
