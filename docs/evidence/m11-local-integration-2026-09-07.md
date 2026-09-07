# M11 local integration checkpoint

Decision: incomplete milestone; local integration passed. This is not final release approval.

Validated candidate: `dac6dd6a15272a345aa57f4ad586ed9a5d8de7c4` on local branch
`codex/m11-integration-candidate`. The candidate combines these exact PR heads:

| PR                                                   | Head                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| #392 component disclosure and CI prerequisites       | `b49c63b85623eb72f4cb4c3f85bded7c996dd022` |
| #393 Hosted Restate identity                         | `1c6ff75960377fdd054a7fa1ab222f4f5f8bf2eb` |
| #394 evaluation authority and metrics                | `4624360aae532e9c6100b825b22be7e8c53605a0` |
| #395 canonical source and contributor reconciliation | `b441d8eec339ed2aaad894a456a902fdd4a3bb29` |
| #396 command retention                               | `d85e0b8f7f0c6bef4548507afe5c23e4180c3f5f` |

All local merges completed without conflicts. No branch was merged into `main`, no release
was published, and no deployment or Neon permissions changed.

## Checks on the candidate

`bun install --frozen-lockfile`, `bun run lint`, `bun run type-check`,
`bun run format:check`, and `bun run test` exited successfully. The test command includes
the workspace build. Results: 754 unit, 47 smoke and 98 E2E tests; zero failures.
Coverage: 87.40% lines and 83.83% functions, exceeding the configured 80% minimum.
Requirement validation checked 80 entries and 103 historical issue audits; architecture
validation checked 41 packages, 13 operations and four profiles. Those validator counts
do not establish that all underlying requirements are implemented or accepted.

The signed-request negative test deliberately logs a rejected invalid JWT. Its test passes;
that expected rejection is not an observed authentication failure for valid requests.

## Remaining acceptance

At the initial checkpoint no PostgreSQL integration, live Hosted Compose, Railway/Neon/R2, fresh Linux VPS, load/soak,
adversarial live-provider, human calibration or independent final audit was run on this
combined candidate. Earlier branch-specific evidence must not be relabeled as exact-candidate
evidence. The existing requirements ledger candidate remains a historical audit record, not
this integration checkpoint. M11 issues #188 and #190–#197 remain open acceptance work.

Neon CI requires the build prerequisite already included from #392 and separately has a
role-membership blocker on that PR. Local integration success does not waive remote CI.
Permission approval remains outstanding. Execution-lifetime retention, physical cleanup and
legacy remediation remain separate from the accepted-command retention boundary tests.

The local integration worktree is intentionally retained for subsequent candidate testing.
No new persistent server or database container was created by this checkpoint. Existing
unrelated containers were left untouched.

## PostgreSQL follow-up

At `9a76a046e375f6c18fc9b4870f917655e2524954` (only this report differs from the
validated code candidate), an isolated PostgreSQL 18.3 Compose project ran on an
automatically allocated loopback port with repository-owned local fixture roles.
The direct database suite passed 22 tests. `bun run test:integration` then passed
the 22 database tests, one shared-harness isolation test and one profile-migration
test, with 33 successful build/integration tasks. The backup/restore drill preserved
the asserted evaluation, execution, event and usage evidence.

The migration test covers its named catalog subset; it is not full product-data
migration certification. The integration runner explicitly skipped the disruption
drill because the container was already running when that runner began. That skip
is not a pass, and no database-process interruption is claimed in this follow-up.

Compose project `m11-integration-db` was removed with its container, network and
volume; label-filtered container and volume inventories were empty afterward.
No remote credentials or Neon permission changes were used. Cloud/VPS, full recovery,
physical retention and independent final acceptance remain open.

## PostgreSQL disruption follow-up

At `5a54200` (code unchanged from the combined candidate), the dedicated local
`m11-integration-disruption` project ran `scripts/run-postgres-disruption-drill.mjs`.
The initial attempt failed: Docker changed the ephemeral port from 55005 to 55006
on service restart, leaving the test client aimed at a closed port. That attempt
is not passing recovery evidence. After pinning the same test project's loopback
port to 55005, the unchanged drill exited zero: database access failed while the
service was stopped, and the committed evaluation digest survived restart.

This is a single-instance stop/start test, not replicated failover, full execution
recovery, or a measured production RTO certification. The script enforces its
configured recovery bound but does not emit an exact recovery duration.
The test container, network and volume (including data from the failed first
attempt) were removed; label-filtered inventories were empty. No shared database,
Neon role or production service was modified.

## Named release-command follow-up

At `dc5a48a` (code unchanged from the combined candidate), the documented commands
`bun run test:m10-conformance`, `bun run test:m10-operability` and
`bun run test:m11-standalone` completed successfully in sequence. The standalone
command ran 77 acceptance tests plus context (19), Cortana-compatible adapter (7),
relay (18), profile-portability (13) and deployment (9): 143 passing tests.
The profile package explicitly skipped one PostgreSQL migration test because this
credential-free invocation did not enable database integration. That same named
test passed separately in the PostgreSQL follow-up above; the skip is not counted
as a pass here.

These commands exercise their checked-in reference transports and fixtures,
including Local direct runtime and packaged RPC scenarios. Command success alone
does not prove every #188 scenario, live external providers, fresh VPS deployment,
managed cloud or the independent final #197 acceptance procedure.

## Live Hosted Server signing follow-up

At `3917c80` (code unchanged from the combined candidate), a local isolated server-profile
Compose run built the Hosted image, bootstrapped PostgreSQL roles, migrated the database and
started Restate plus Hosted. `/ready` returned 200 and unsigned `/discover` returned 401.
Restate and Hosted were then force-recreated with the same persisted signing key; readiness
and unsigned rejection passed again. Harness process exited zero.

Project: `m11-integration-signing-80690`. The local test image
`control-plane/m11-signing-test:80690` is intentionally retained for inspection. The temporary
private signing material and database/application data were removed, all five Compose
containers and their network were removed, and a label-filtered container inventory was empty.

This proves the exercised local Hosted Server startup/signing/recreation path. It does not
prove full representative execution, remote runtime identity integration, Hosted Simple,
fresh VPS deployment, cross-product relay or managed-cloud acceptance. The local temporary
harness was `/tmp/m11-hosted-signing-live.mjs`; it is not a versioned release command.

## Live Hosted Simple startup follow-up

At `8522e32` (code unchanged from the combined candidate), isolated Compose project
`m11-integration-simple-83214` built and started the Simple image with one application
container and its embedded Restate runtime. No separate PostgreSQL or Runtime Gateway
service was started. Readiness returned 200 and the SQLite file existed on the bind-mounted
data path. Force-recreation against the same directory passed those checks again.

This checks startup/recreation and file presence, not recovery of an accepted execution,
exactly-once effects, graceful shutdown or fresh VPS behavior. The temporary harness was
`/tmp/m11-hosted-simple-live.mjs`. It exited zero and removed the container, network and
temporary application data, including local credentials. Follow-up checks found no container
with that project label and confirmed the data directory absent. Test image
`control-plane/m11-simple-test:83214` is intentionally retained for inspection.
