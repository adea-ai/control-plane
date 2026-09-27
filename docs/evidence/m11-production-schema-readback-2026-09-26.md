# M11 production schema repair — 2026-09-26

## Finding and scope

Owner: M11 implementation agent. Severity: high operational rollout gap. Remediation
date: 2026-09-26; release-gate regression prevention remains required before the next
candidate promotion. This is not a completed M11 operations or security acceptance.

The deployed `workspace-v1.58.3` source
`03e7bfc646a1d4377e65b8ec7b4d840d3f409405` includes database migrations
`0047` and `0048`. The production database initially had 47 canonical journal
entries, ending at `0046`. Container Promotion deploys images but, at that
revision, has no database migration step. `/ready` reporting ready does not
prove the feature schema is current. This establishes a deployment/schema gap,
not a demonstrated loss of user data.

Railway deployment-variable readback independently confirmed both services:

| Resource                         | Verified identity                                                         |
| -------------------------------- | ------------------------------------------------------------------------- |
| Railway project                  | `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`                                    |
| Production environment           | `52f5b0ac-2af0-4792-aa56-30d80e5db31e`                                    |
| API                              | `9167a33b-af0f-4780-8614-a5a161697c9c`                                    |
| Worker                           | `d733ec0d-bda5-4be5-86b9-637154d282eb`                                    |
| Neon project / production branch | `muddy-firefly-58711535` / `br-rough-tooth-ay4q6u73`                      |
| Direct migration endpoint        | `ep-crimson-bird-ay77m275.c-5.us-east-2.aws.neon.tech`                    |
| Runtime binding                  | Same endpoint with `-pooler`, database `neondb`, role `control_plane_app` |
| Migration role                   | Direct connection, `control_plane_migrator`, TLS required                 |

Both services have `APP_ENV=production`. The API's catalog approval configuration
is `true`, required since `2026-09-25T00:00:00.000Z`. Configuration readback alone
does not establish the complete deployed approval behavior matrix. Credentials
were handled in memory; no connection strings or secret values belong in this record.

## Isolated rehearsal

A task-owned, expiring child `br-wispy-rice-ayt3ipgo`
(`m11-audit-schema-20260926`) was created from the exact protected production
branch. Its inherited 47-entry journal matched the entire canonical prefix.
The repository's `migrateDatabase` applied `0047`, `0048`, and candidate-only
`0049` on that child; the 50-entry readback matched every timestamp and SQL SHA-256.
Repeated migration was unchanged. Both candidate reference-clock columns are
nullable. This was a normal isolated branch rehearsal, not a production deployment.

All eight individual `SELECT`, `INSERT`, `UPDATE`, and `DELETE` grants on
`catalog_approvals` and `retired_execution_event_ids` were verified, rather than
relying on PostgreSQL's comma-list privilege check (which tests any privilege).
The migrator owns both tables. Runtime role schema `CREATE` is denied; superuser,
database creation, role creation, and RLS bypass are all false. Runtime reads of
the new tables and columns succeeded. Context/plan counts were both zero before
and after: this proves unchanged counts for this branch, not a populated-corpus
migration or full data-integrity acceptance.

## Released production repair

After rehearsal and exact service/database binding verification, only the
immutable released revision's migration directory was exported and used with
the unchanged repository migrator. Production mutation was guarded by a
session advisory lock `(1295070001, 11)`, direct TLS migration credentials,
10-second lock and 60-second statement timeouts, and a fresh full canonical
prefix check. The guard and clients were released in `finally` blocks.

| Applied migration          | Timestamp       | SQL SHA-256                                                        |
| -------------------------- | --------------- | ------------------------------------------------------------------ |
| `0047_blushing_demogoblin` | `1790269239619` | `4c0029b12262f8d97910f81f797a4f5032f5efa0e8dbd5b4eb84a8c75da7612d` |
| `0048_tense_thor`          | `1790300980766` | `0bb385e62db234e126552c62377ab61eebee769719f206d4ef687da8f7e3c088` |

Production now has 49 canonical entries through `0048`; the exact complete
readback and repeated migration passed. Runtime reads of both new tables,
all eight individual CRUD privileges, and schema `CREATE` denial passed.
Runtime elevated-role capabilities remain false. Context/plan counts remained
zero. Production has **zero** `unreferenced_since` columns: unmerged `0049`
was deliberately not applied. These additive migrations require no image
redeployment and no destructive schema rollback was attempted.

## Rehearsal cleanup

The dedicated `NEON_PRODUCTION_MIGRATION_URL` secret was provisioned in GitHub's
`control-plane / production` environment, with name-only metadata readback.
It uses the existing direct-TLS production migration role, not an administrator,
OAuth token, runtime role, or CI staging password. No database role/password,
branch protection, or environment approval policy was changed. The environment
currently has no reviewer protection rules; environment scoping is not a claim
of human deployment approval. The prepared workflow must validate the final
tagged main source and runtime target before using this credential.

The gate credential was subsequently tightened to `sslmode=verify-full`, after
an actual read-only connection verified the production certificate and exact
migrator/database identity. This matters because the installed PostgreSQL
driver's `require` mode alone disables certificate verification (unless other
configuration upgrades it). No runtime service variables were changed; this
gate-credential check must not be reported as runtime TLS hardening.

The exact task-owned rehearsal branch was deleted after evidence capture.
Subsequent branch inventory verified it absent and confirmed production,
staging, and both unrelated preview branches remain. No production data was
deleted. The rehearsal can be recreated from the preserved production parent
and canonical migration source; the disposable child's transient state was
not retained.

## Runtime authority closure

At `2026-09-27T00:34Z`, a separate read-only connection using the existing
production `control_plane_app` role verified the exact direct endpoint,
`neondb`, and certificate-verified TLS. Catalog queries returned:

- No role memberships, including potential `SET ROLE` authority.
- No ownership of the current database or any public `pg_class` objects.
- No effective `TRUNCATE`, `REFERENCES`, `TRIGGER`, or PostgreSQL 18 `MAINTAIN`
  privileges on public application tables/views.

The connection used `default_transaction_read_only=on`, a 20-second statement
timeout, and a 10-second connection timeout. No role, grant, schema, or service
changes were requested; the client closed and the owned credential-reader
processes exited. Initial helper setup attempts failed before SQL because the
CLI writes a bare URI even with `--output json`, and Bun's `postgres` export
is an ESM namespace with a callable default. Neither was an authentication or
unsafe-production-authority finding. The corrected readback passed; credentials
stayed in memory and were never printed or stored.

Independent review found that the proposed gate omitted these authority checks,
and the actual runtime probe exposed the same driver-initialization gap in its
session factory. Both proposed-gate defects remain assigned for regression
repair before integration. This live readback is not execution of the new gate,
deployment of PR #740, service runtime TLS hardening, or full profile acceptance.

## Remaining gates

- Add and independently review a fail-closed tagged-source migration step before
  any Railway deployment mutation; use dedicated production-scoped migrator
  credentials, runtime target binding checks, serialization, and full journal
  readback. Do not reuse CI staging/admin credentials.
- Validate the integrated candidate locally and through required current-head
  checks, then promote its exact released image digests and schema.
- Complete the original M11 profile, retention, security, documentation,
  recovery, evaluation, skill, and independent human acceptance gates. This
  repair does not close those issues.
- Clean up task-owned local helpers and test resources after validation. The
  Neon rehearsal child is already removed; production, staging, and unrelated
  preview branches are not cleanup targets.

See also [released image promotion readback](m11-release-promotion-readback-2026-09-26.md).
