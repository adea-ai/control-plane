# Database package

`/db` is Adea's server-only PostgreSQL boundary. Its public entry point imports
`server-only`, and no database subpaths are exported. Browser, mobile, and desktop code must use
API contracts from `/api-client` and cache/query behavior from `/data`.

## Schema conventions

- Organize schemas by domain (`workspaces.ts`, `events.ts`), not one file per table.
- Use UUID primary keys, `timestamptz`, snake_case SQL names, camelCase TypeScript names, and
  typed JSONB payloads.
- Model lifecycle state with PostgreSQL enums and database constraints. `deleted_at` is reserved
  for domains whose retention rules require soft deletion.
- Put foreign keys, uniqueness, checks, and query-path indexes in the Drizzle schema so they are
  represented in reviewed SQL migrations.

## Connections and transactions

Create one connection per server process with `createDatabase()`, reuse it, and close it during
graceful shutdown. Runtime code uses `DATABASE_URL`; migration commands require the unpooled
`DATABASE_MIGRATION_URL`.

Use `inTransaction()` for a domain mutation that must atomically append a `WorkspaceEvent` or an
outbox/inbox record. Pass the transaction object through repository helpers; never fall back to a
process-global connection inside a transaction.

`createUserWithAuthIdentity()` creates the stable `User` and provider identity in one transaction.
Resolve sessions with `findUserPrincipalsByAuthIdentity()` and pass only the returned user
`PrincipalRef` into authorization code. Provider subjects are authentication keys, never domain
user IDs or workspace foreign keys.

## Migration workflow

1. Change the domain schema and add or update tests.
2. Run `bun run --cwd packages/db db:generate -- --name=<short-name>`.
3. Review the generated SQL and snapshot. Never edit a migration after it has been applied.
4. Run `bun run --cwd packages/db db:check`.
5. Against an isolated database, run `bun run --cwd packages/db db:verify` and
   `bun run --cwd packages/db test:integration`.

The root and package integration runners build the public `remote-content`
and `types/runtime-node-delivery` entries before running the database producer tests, so a fresh checkout needs no
previous workspace build.

Outbound pulls retain the original submission actor, nonce/rate records and
current authorization locks before releasing ciphertext. Migrations 0037/0038
add those records and a distinct runtime-node event actor. Unrecoverable legacy
authority remains withheld. Pull is not execution acceptance or a host receipt.

Migration 0039 is the [relay retention expansion phase](../../docs/evidence/m11-relay-retention-schema.md).
It adds a nullable purge marker, partial expiry index and expiry constraint before
the matching application declaration/operator deploys. During this short staged
rollout the generated snapshot is ahead of the runtime declaration: integrate
the application phase before generating further migrations from that declaration.
Verify the approved target's schema readiness before publishing code that reads
the column; parallel main-push migration and Worker jobs do not establish order.

Production rollback is forward-only: deploy an application rollback while the expanded schema is
compatible, then add a reviewed corrective migration. Point-in-time restore is for data-loss
recovery, not routine schema rollback.

Workspace migrations 0040/0041 are the [workspace schema expansion phase](../../docs/evidence/workspace-schema-expansion.md). They precede application use of personal identity/deletion metadata. Their snapshots preserve retention0039's expansion; runtime declarations remain staged ahead of activation. Do not generate migrations from an older declaration that would remove these columns or constraints. Verify production migration history/catalog before landing the matching application.

Migration 0042 adds the [workspace lead and direct-topic foundations](../../docs/evidence/pi-durable-foundations.md).
It preserves the staged 0041 schema and all legacy identities, history and audiences.
Apply it before the new lead/topic API callers; a designation or canonical message
is not model readiness or execution acceptance.

The opt-in [installed SDK / production-factory consumer proof](../../docs/guides/pi-production-factory-consumer-proof.md)
uses a reviewed CP checkout and actual public candidate packages with an owned restricted
PG database. Its preflight regressions are in the normal DB unit inventory; the connected
fixture requires explicit verified inputs and never substitutes a mocked SDK or live config.

Migration 0045 adds the Agent `revision` that presentation and placement edits check before
writing; see the [lead identity evidence](../../docs/evidence/m11-workspace-lead-identity.md).
It is additive with a default of zero. Apply it before callers that send `expectedRevision`:
until every writer checks the revision, a pre-0045 writer can edit without advancing it, so
complete the rollout before relying on conflicts.

Migration 0046 adds #1207's artifact-reference grant table after 0045. Migration 0047 adds only
the nullable requested lead/child selection column on the immutable lead intent and its strict
check; it follows 0046 and descends from its snapshot. No migration is renumbered on `main`.
Omission retains workspace role defaults; a changed choice on the same message/idempotency
key conflicts. The locked private reader exposes only these requested references; CP validates
workspace/target/readiness and retains accepted runtime selections. A parent child choice
never inherits the lead choice. Child overrides require CP-owned canonical child admission.
The requested references reach CP only through the authenticated lead-product evidence endpoint
(`requestedModelSelections`); the public prepare request stays `{ intentId }`. CP resolves and pins
the selection from that canonical evidence. A prepared model that differs from the requested lead
reference is refused (`REQUESTED_MODEL_MISMATCH`) and never falls back to the workspace default.
The older runtime workspace declaration must never generate a destructive rollback or renumber
an applied migration.

## Permanent workspace deletion

Active permanent deletion is unavailable until server-owned cleanup completion
can be verified. `deleteWorkspace()` is owner-only and checks the current workspace
name and version inside its transaction before refusing completion. Dormant
final-deletion logic would remove memberships and authorization audit
rows explicitly; root foreign-key cascades would prune workspace-owned data, encrypted
replicas, events/outbox records, runtime node registrations and their credentials.
A minimal `workspace_deletions` receipt keeps owner/id/creation-key/deletion time
for safe retries and to prevent old creation keys from being
recreated. Creation, bootstrap, deletion and guest claim transfers serialize on
the owner row. Both guest claim paths transfer deletion receipts to the target
account. The persistent personal workspace cannot be deleted or archived, including via a direct helper or retry; active additional-workspace deletion is blocked pending server-verifiable cleanup completion.

Active-workspace deletion is currently unavailable. Both `beginWorkspaceDeletion`
and `deleteWorkspace` require a server-owned cleanup-completion verifier, which
has not been implemented, and fail closed with `workspace_deletion_cleanup_required`.
No caller boolean, trusted desktop header, owner credential or
`deletion_requested_at` timestamp proves local cleanup completion. New preparation
does not create pending intent. Existing interrupted intent remains visible and
frozen; retries retain the cloud root and local data. Receipt retries are accepted
only when the cloud root is actually absent. Cascade tests use explicit disposable
raw SQL fixtures, not a production authorization bypass.

`control_plane_used_at` conservatively backfills existing workspace scopes.
Mutating Control Plane credentials record external ownership before token issuance,
conditional on no pending deletion. Used/unverified scopes, registered runtime
nodes and queued/running/review tasks remain additional refusal reasons. Shared
host authentication/state is retained. Native recovery cleanup can resume only
from fresh owner proof that a historical cloud root is already deleted; a
`cleanup_pending` response never authorizes archival, local purge or identity
removal. No universal physical purge is claimed.

## Personal workspace bootstrap

`ensureBootstrapWorkspaces()` gives every signed-in user and guest one personal
root, initially Home with a home icon and the established app defaults. The
immutable settings boundary never accepts `isPersonal`. A partial owner unique
index and active-root constraint prevent duplicate personal identities or
archive/pending states. Additional creation produces a box icon and empty data,
appends to the member's list, and never seeds accounts, projects or agents.
All memberships, including Home, remain reorderable; bootstrap's default is the
personal identity rather than list position.

The production API regression uses the `react-server` condition to exercise its
`server-only` database entry; both supported integration runners build that entry
before executing the tests. Workspace migrations 0040/0041 preserve the 0039
retention expansion in their snapshots without activating its runtime declaration.

Migration 0041 recognizes only stable `default-home`/`default` creation metadata;
it preserves customizations and content and restores a proven archived root.
Legacy Work remains. Historical `claimed:<id>` metadata cannot prove which
workspace was originally personal: bootstrap retains all of them and creates a
separate Home once. Guest-to-new-account claims retain their root; existing
account claims keep the account root and preserve the guest workspace as an
additional workspace. Application bootstrap and both claims serialize owner
identity decisions. No migration or onboarding operation connects an account.

`reorderWorkspaces()` locks the member's user row, requires the complete live list
with no duplicates or foreign IDs, and updates only that member's positions. It
shares the creation/claim lock, and neither modifies workspace versions nor
changes another user's membership order.

The opt-in [installed SDK / production-factory consumer proof](../../docs/guides/pi-production-factory-consumer-proof.md)
uses a reviewed CP checkout and actual public candidate packages with an owned restricted
PG database. Its preflight regressions are in the normal DB unit inventory; the connected
fixture requires explicit verified inputs and never substitutes a mocked SDK or live config.

## Project-state promotion and channel provenance

`promoteProjectState()` is the one explicit archived → active transition. It
requires the caller's confirmation and the exact observed `version`, holds
the project row lock, wakes only the channels the project-archive cascade
slept, and appends `project.restored` / `channel.restored`. The pure
`decideProjectStatePromotion` refuses missing, foreign, soft-deleted,
already-active, stale and unconfirmed calls with typed reasons; visibility is
carried through unchanged.

Project revision is the additive integer `projects.version`
(`DEFAULT 1 NOT NULL`, `CHECK (version > 0)`). Every project-row mutation
increments it atomically — update, archive, soft delete, reorder (included),
visibility change and promotion — and `ProjectSummary.version` plus the one
canonical `projectSummary` mapper expose the single shape. A non-safe-integer,
zero/negative or mismatched `expectedVersion` refuses `promotion_stale`;
timestamps are display-only. The membership tables keep their own operation
contracts and are not part of the project-row revision.

Channel archive provenance is explicit in `channels.archive_source`:
`project_cascade` marks the channels a project archive slept, `individual`
marks an explicit channel archive (and the default for historical rows).
Promotion restores exactly the cascade set; a channel archived on its own is
never revived. `archiveProject`, `softDeleteProject` and
`promoteProjectState` share `archiveProjectChannels`/`restoreProjectChannels`,
which lock the project row first and the project's channels in id order, then
compare-and-swap each channel `version`, so a concurrent write rolls the whole
transaction back instead of losing an update. The migration that adds the enum
and column is expand-only; its number is provisional until the `main` journal
confirms it (see the lane handoff
`docs/plans/m14-03-management-action-contract.md`).
