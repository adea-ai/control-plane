# M11 managed-cloud candidate verification — 2026-09-07

## Status

In progress. These observations establish staging deployment and connectivity, not completion of
Milestone 11, production activation, managed Pi certification, or the independent audit.

## Frozen source and publication

- Integration PR: <https://github.com/adea-ai/control-plane/pull/412>.
- Merged source: `a76f27453e558525a05089e3c88085153a63a528`.
- Required PR gates passed before normal squash merge; no branch-rule bypass was used.
- Post-merge release/version workflow `34165417905` and shared-package publication workflow
  `34165417522` succeeded. This is not evidence that every milestone acceptance gate passed.

## Staging deployment

- Railway project: `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`.
- Staging environment: `3beb119e-1b23-4fa6-9af3-2c6b9976708f`.
- API successful deployment: `edf04ab7-f1d4-4a80-b86e-2555f26a479a`.
- Worker successful deployment: `fc592d2a-7321-4c22-8be6-66b75ac9d805`.
- Public `/ready` returned `ready`, the API deployment ID above, environment `staging`, and the
  exact merged source SHA. Worker startup logs reported the same source SHA.
- Worker startup logs confirmed Restate request-signature validation was enabled.
- Both application source configurations were pinned to the merged SHA on `main`; the previous
  staging branch configuration was obsolete.
- Production configuration, credentials, migrations, and deployments were not changed.

Initial CLI source uploads failed to provide required commit metadata. The worker upload failed;
the exact API upload was canceled and verified removed. Subsequent Git-source builds exposed stale
staging application database credentials (`28P01`). Each application's staging `DATABASE_URL` was
replaced with the existing Neon staging application-role connection string, without resetting any
password or granting application privileges. The final deployments above then succeeded.

## Database

- Neon project: `muddy-firefly-58711535`.
- Staging branch: `br-young-shadow-ayi1124s`.
- Additive migrations `0032` and `0033` were applied through `control_plane_migrator`.
- The new context-authoring and execution-validation command tables were confirmed present, with
  application SELECT/INSERT/UPDATE/DELETE privileges.
- A connection using the worker's updated configured URL authenticated as `control_plane_app`
  against `neondb`. No connection strings or credential values are included in this evidence.

## Restate observations and outstanding verification

Read-only queries from the deployed worker over Railway private networking observed:

- Admin health: HTTP 200.
- `SELECT status, count(*) AS count FROM sys_invocation GROUP BY status`: no rows.
- Existing deployment: `dp_15PPui4pzvigZQjyeTsQDf3`, registered 2026-08-28, workflow
  `execution-lifecycle`, private worker endpoint on port 9080.
- Registration metadata still reported SDK `1.16.9`, whereas the new worker uses SDK `1.17.0`.
- Registration with `force: false` returned the existing deployment and old SDK metadata. This did
  not prove rediscovery. After a second query confirmed exactly zero invocations, staging-only
  rediscovery with `force: true` succeeded: the same deployment ID, revision 2, SDK `1.17.0`, and
  the same three workflow handlers. No invocation was deleted. This drained staging update does
  not establish a safe in-flight production upgrade strategy.

## Live bounded execution

The API trust-key deployment `b47e1548-7ca0-4d02-ad83-f3ee59fedb3d` reached SUCCESS and its public
readiness endpoint reported that exact deployment and merged source before the harness started.
The repository harness passed from `2026-09-07T22:24:48.482Z` to `2026-09-07T22:25:04.264Z`:

- Execution: `exe_3WSV0BMYRH03XTEE9BXGGTZ92C`.
- Artifact: `art_3WSV0BMYRH03XTEE9BXGGTZ92C`.
- Command and execution: `completed`; attempt count: 1; replayed: true.
- Object digest: `sha256:16af8dc5aa14032aa1320bc4baceb6cbc38962a88b181f8d856756a7eb78c79c`.
- Object key:
  `m9/certification/executions/exe_3WSV0BMYRH03XTEE9BXGGTZ92C/f24fde23bcf7719a1f52df29bbb6617b0f3a206fd17f2de09c40c85ea557308b.json`.

This proves authenticated acceptance, authoritative terminal state, retained R2 content integrity,
and idempotent replay for one bounded deterministic execution. It is not managed Pi certification.
The harness regression tests also passed (4 tests, 19 assertions), and the 41-package build passed
with cached outputs. Restart, load, isolation, and all remaining M11 profile/audit gates still
require fresh evidence on this candidate.

## Resource ledger

Staging services remain running for the ongoing certification task. The integration worktree and
live-certification branch remain intentionally retained. No new subagents or local servers were
started for this verification segment. A temporary local Ed25519 signing key was generated in a
mode-0700 task directory; its public key `m11-cert-a76f274-20260907` was appended to the staging API
trust set without replacing existing entries. Deployment `b47e1548-7ca0-4d02-ad83-f3ee59fedb3d`
passed verification. After the passing execution, the exact temporary trust entry was removed;
configuration readback confirmed its absence and three retained pre-existing keys. The local private
key and its temporary directory were deleted and absence verified. Cleanup deployment
`3105c082-1ffb-467e-8fd0-b518812668a9` reached SUCCESS, and public readiness reported that exact
deployment and merged SHA. Unrelated services, worktrees, and Neon preview branches were preserved. The worktree
prune dry run reported no stale registrations.
