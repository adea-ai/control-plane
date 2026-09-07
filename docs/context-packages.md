# ContextPackage compilation

A `ContextPackage` is an immutable, content-addressed execution input owned by the Control Plane. It
is not mutable memory, an Adea product-state copy, a workflow checkpoint, model conversation
history, or a runtime-native session. Runtime adapters receive this normalized package and translate
it at their boundary.

## Reproducible inputs

Compilation records the compiler semantic version, compile time, objective, exact workspace/project
and ProjectState revision, exact item IDs and item revisions, Artifact IDs and digests, sensitivity,
freshness, provenance, permissions, success criteria, return contract, and byte/token budgets. The
normalized payload is hashed with SHA-256; its opaque `ctx_` identifier is deterministically derived
from that digest. Recompiling unchanged inputs with the same compiler version returns the same bytes,
digest, and ID.

`ContextPackageRepository` persists immutable packages by `{ contextPackageId, contentDigest }` and
verifies the content hash before accepting a write. The in-memory implementation is a test adapter;
durable implementations must enforce the same content-addressed uniqueness.

## Selection and budgets

Candidates are ordered by required before optional, descending priority, then opaque item ID. The
compiler validates each candidate against the supplied ProjectState snapshot and authorization result.
It counts selected JSON value/key bytes with a fixed envelope allowance, counts referenced Artifact
bytes once, and estimates tokens deterministically at one token per four bytes rounded up.

Required context that is stale or cannot fit fails compilation. Optional stale inputs are excluded as
`STALE_OPTIONAL`; optional inputs beyond either budget are excluded as `BUDGET_LIMIT`. The package
records usage and every exclusion. Selection never depends on repository order.

## Fail-closed classifications

Compilation returns stable codes for stale ProjectState revisions, missing items, item-version drift,
unauthorized sensitivity or references, stale required inputs, missing/revoked Artifacts,
contradictory duplicate references, and required-context budget overflow. Authorization booleans are
trusted policy-decision inputs; the compiler never invents authority or resolves provider credentials.

## Pre-validation authoring service

`ContextAuthoringInputsSchema` in `@control-plane/contracts` defines the shared caller-selection
shape. `ContextPackageAuthoringService` extends it with host-bound scope and revision, separating
caller selection from trusted inputs. Its strict request
schema accepts scope, the pinned state revision, candidate IDs/revisions, objective, result contract,
success criteria and requested budgets. It does not accept authorization flags, Artifact metadata,
permissions, ProjectState content or a caller-controlled compilation clock. The host supplies the
authenticated principal separately and injects a `ContextAuthoringAuthority`, scoped state repository,
package repository and trusted clock.

The authority adapter must obtain policy decisions and Artifact lifecycle evidence from their
respective owners. The service checks decision scope/principal/expiry, repository scope, Artifact
identity/scope/authorization and availability, intersects requested budgets with policy ceilings,
compiles and persists an immutable reference for the existing execution-validation operation.
`unverified` and `quarantined` inputs are unavailable; the service is not a scanner or a replacement
for product authorization. A resolver must map all non-admissible product states to unavailable
states, never translate an arbitrary caller flag into `available`.

Optional-item freshness selection and compilation use one trusted timestamp, so expired optional
items are excluded before their Artifact references are resolved. Policy expiry is checked again
after asynchronous resolution. Artifact decisions are observations during authoring, not leases:
revocation after authoring still requires an execution-time check or an authoritative revision/lease
contract. Persisted package integrity alone does not prove continuing Artifact authorization.

This service has focused no-provider contract tests and a file-backed SQLite test that creates from
persisted ProjectState and resolves the same package by digest and ID after close/reopen. These are
not production composition evidence.
Deployment wiring, authoritative adapters, pinned optional-provider enrichment, durable all-profile
acceptance and the entrypoint's authentication/idempotency contract remain required before the
context-authoring reachability gap can close. Calling the service with a fixture is not proof that a
shipped application exposes a supported authoring path.

The execution-validation contract now accepts exactly one of a package reference or `contextInputs`.
The input form invokes a composition-supplied authoring service with the authenticated principal,
envelope scope, pinned state revision and idempotency key. The complete original validation payload
is hashed before authoring; recorded final results replay without rereading authoring inputs. The
authoring service separately retains its first package, so a retry between package persistence and
plan persistence does not recompile context. Missing authoring composition returns 503, rather than
inventing policy or Artifact authority. Both/neither source forms and caller authority fields are
rejected. The generated OpenAPI describes the alternatives; the v3 baseline remains unchanged.

The execution-validation controller now forwards the principal established by its service-authentication
guard separately from the body. The durable validation service rejects a missing or mismatched
principal before reading evidence or persisting a plan. This is an explicit composition boundary,
not credential verification inside the service: non-HTTP callers must supply a principal from their
own trusted authenticator. The protected HTTP route remains responsible for credential, scope and
revocation checks. Reference-only validation now records and replays its command/plan pair through
the durable repository in each composition; see [execution-plan replay](execution-plans.md#validation-command-replay).
The Local reopen test now also creates inline context through the real authoring service and SQLite
repositories with a no-provider authority fixture. The HTTP test checks principal/scope forwarding,
503 when unconfigured, replay and conflicts. These do not certify the cloud/Hosted API restart matrix
or production authority composition. Inline authoring still needs authoritative adapters wired from
supported entrypoints across profiles; fixture injection is not proof of that production reachability.

`createForCommand` supplies internal authoring replay through an injected
`ContextAuthoringCommandRepository`. Its scope includes authenticated principal, workspace, project,
the `context.author` operation and idempotency key. The service computes a canonical request hash;
same-key different-input requests conflict, while an existing result is returned without rerunning
policy or compilation. Authentication and current permission to resolve/read the returned reference
remain host responsibilities on every request; replay is not a renewed authorization lease.

`SqliteContextAuthoringCommandRepository` atomically stores the first winning command and package.
Concurrent compilation may occur, but losing candidates are not persisted. Reads verify the stored
scope and package integrity. Records currently have no deletion path and remain retained; bounded
cleanup/retention policy is not implemented. This is not the complete `execution.validate` command
inbox: that boundary must bind the full execution payload and final plan result, not only context
inputs. Application wiring remains open.

`PostgresContextAuthoringCommandRepository` implements the same contract using migration
`0032_groovy_surge.sql`. Its transaction-scoped advisory lock serializes commits for a hashed command
scope; full scope equality is still verified from the stored record. The package and command are
inserted in one transaction, with a foreign key retaining referential integrity. A lock-hash collision
can serialize unrelated commands but cannot make their command records equivalent. Migration must
run before using this adapter.

Portable manifests now include `context-authoring-command` records with their referenced packages.
Import validates canonical command identity and package ID/digest/workspace/project binding. The
portable key is a bare SHA-256 digest; SQLite retains its existing `r-` physical-key prefix while
PostgreSQL uses the bare key. PostgreSQL import orders packages before commands to satisfy the
foreign key. Updated importers are required; older parsers may reject the new record category.

On 2026-09-07, the real SQLite-to-PostgreSQL-to-SQLite integration test preserved the authoring
record's scope, payload hash and package reference, with direct repository lookup on both sides and
equal portable record digests after the round trip. The first run caught a missing SQLite `r-`
translation; the corrected run passed all 27 integration tests and existing recovery drills. Full
validation passed 773 unit, 52 smoke and 98 E2E tests, lint, type-check and formatting (87.28% line,
83.85% function coverage). This covers the exercised quiescent subset, not live migration,
production cutover, authoring-command crash recovery or entrypoint idempotency.

A disposable PostgreSQL 18.3 run on 2026-09-07 passed 27 integration tests, including eight
concurrent authoring commits through the fixture's four-connection pool, duplicate/hash-conflict
handling, principal isolation, repository reconstruction and injected transaction rollback. This
includes review-requested corruption checks for workspace, project, package-ID and stored-principal
scope metadata: each fails closed on read and is restored within the isolated test database. This
authoring test is not a process-restart test. The separate service-restart drill now also verifies
the exact committed authoring record and complete package through application repositories before
and after PostgreSQL stops/restarts. The backup/restore drill compares both restored JSON values
and checks package integrity after restoring into a different isolated database. Because that drill
excludes privileges, its admin SQL checks establish stored-data recovery, not application replay
readiness or restored role grants. Both drills passed on 2026-09-07; their disposable Docker
container, volume and network were removed and the loopback port was verified closed.

The SQLite regression exercises eight concurrent calls with differing trusted timestamps, confirms
exactly one stored package/command, reopens the file and replays without invoking authorization or
the clock, rejects changed input, and isolates another principal's lookup. Injected failure of the
command-record write rolls back the package write too. This is same-provider concurrency evidence,
not multi-process contention or cross-profile migration certification. Full candidate validation on
2026-09-07 passed lint/type/format and 772 unit, 52 smoke and 98 E2E tests (87.50% line and 83.98%
function coverage).

## Child derivation

A child package references its parent package ID and digest. Its state items and Artifacts must be
subsets of what the parent actually contains, and its byte/token ceilings cannot exceed the parent.
An item cannot retain provenance for an Artifact removed from child authority. Objective, success
criteria, and return contract may be specialized without widening the pinned ProjectState baseline or
permissions.

The exported future Pi, ACP, and LangGraph serialization fixtures all use this same normalized schema.
They contain no adapter SDK types, credentials, local paths, or native-session configuration.
