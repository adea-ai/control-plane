# M11 standalone product evidence — 2026-08-30

## Evidence scope correction — 2026-09-08

This is historical candidate evidence, not current M11 certification. In particular,
the broad scenario labels below do not turn component fixtures into native-runtime
or sandbox-isolation proof. The cited runtime tests use `ReferenceAcpTransport`,
managed Pi RPC fixtures, and `GenericRuntimeReferenceClient`; the tools/model/sandbox
suite uses `FakeModelAdapter`, `FakeToolExecutor`, `FakeSandboxProvider`, and an
in-memory usage ledger. They validate adapter and coordinator behavior, not live
provider execution, operating-system isolation, or authoritative native usage.

The later [native ACP probe](m11-native-acp-permission-2026-09-08.md) establishes
bounded native permission/cancellation evidence but explicitly leaves aggregate
usage and process-restart recovery open. The
[task materialization report](m11-acp-task-materialization-2026-09-08.md) adds
repository-backed task input, not a supported standalone ACP launcher or complete
profile/Skill/model configuration. These remaining requirements belong to #188;
none may be closed from the historical table's passing fixture results.

## Candidate and pinned components

- Implementation candidate: `57a7fe4c9529ba56fbeb183d1ce6567c8800b79a`
- Merged `staging` candidate: `d429b311b26a6eb03b0aebbcea4013c04432f5f7`
- Pull request: #325 (`feat/m11-standalone-e2e` -> `staging`)
- Bun CLI: `1.4.1` (`bun test` identifies the bundled runner as `1.4.1-canary.1`)
- Node: `v22.23.1`; package engines remain Node `>=24 <25`, so Node is not the
  certifying package runner in this evidence
- Restate: pinned `1.7.7` image/runtime
- Local/Hosted composition: `1.1.0`
- Managed Pi/ACP adapters: `1.2.0`
- Runtime Gateway: `1.2.0`; workflow worker: `1.4.0`
- SQLite persistence: `1.1.0`; PostgreSQL persistence: `1.7.0`

## Credential-free standalone command

`bun run test:m11-standalone` completed successfully from the candidate:

- 41/41 workspace packages built;
- 68 M3–M11 cross-package acceptance tests passed with 407 assertions;
- 17 context-provider tests passed, including no provider, disabled provider, fake
  alternate providers, scope and budget enforcement;
- 7 repository-local Cortana-compatible adapter tests passed without live Cortana;
- 17 encrypted remote-control relay tests passed, including ciphertext-only durable
  storage, replay, key rotation, recipient/AAD binding, and outbound-only polling;
- 9 profile-portability tests passed and the credential-requiring PostgreSQL case was
  explicitly skipped in this credential-free lane;
- 9 deployment tests passed, including process ownership and filesystem checkpoint
  tamper/symlink rejection.

The Local execution slice uses `LocalControlPlaneComposition`, SQLite, filesystem
Artifacts, `DirectLocalRuntimeTransport`, the real managed Pi and ACP adapter/driver
layers, and the shared durable execution lifecycle. Both adapter families reached a
terminal result and survived a composition close/reopen with execution, attempt, and
command state intact. A separate test launched the pinned single-node Restate runtime,
accepted an execution through the public acceptance service, and observed Restate
suspend/replay before the execution completed. No Runtime Gateway process was started
in the Local lane.

## Self-hosted and database checks

The candidate image was built from a clean Docker build and the supported `simple`
Compose profile was started from an empty temporary data directory. `/ready` returned 200. After a forced container recreation, `/ready` returned 200 again and both the API
token file digest and SQLite database digest matched their pre-recreation values. The
isolated Compose stack was then removed without touching unrelated containers.

The PostgreSQL integration suite was also run explicitly with the repository test
roles and an extended hook timeout necessitated by local Docker latency. All 21 tests
and 132 assertions passed, including migrations, execution/attempt lifecycle,
ProjectState, runtime discovery projections, event effects, and restart-safe durable
repositories. The ordinary 30-second integration hook had timed out during database
creation on this host; the passing extended run showed that this was host latency, not
a semantic assertion failure.

A fresh macOS Docker run of the `server` Compose profile did not certify the profile:
PostgreSQL 18 bind-mounted initialization exceeded the Compose health retry window, so
the application never reached a representative execution. The isolated stack was
removed. The supported Linux Compose workflow and live staging deployment remain the
authoritative certification environments.

The repository-owned Linux Hosted Compose workflow passed for the merged candidate in
GitHub Actions run `33354286908`. It rebuilt and started fresh `simple` and `server`
profiles, ran migrations, and passed the Restate/PostgreSQL disruption and readiness
checks. That workflow does not execute a representative remote runtime through the
Runtime Gateway, so it proves the deployment substrate rather than the complete Hosted
Server execution path.

## Managed-cloud staging certification

Railway staging was first corrected from stale `main` source configuration to the
documented `staging` branch. Both application services then deployed the exact merged
candidate:

- Control API deployment `b8755e97-e301-47db-9919-f63160c14ad8`;
- workflow worker deployment `ec210884-8f3a-4db0-87a9-e7cb8e744101`.

Both `/health` and `/ready` reported commit
`d429b311b26a6eb03b0aebbcea4013c04432f5f7` and environment `staging`. A short-lived
Ed25519 certification key was added to staging only, and the Control API was redeployed
as `701d0ab4-3864-4441-8e34-f35b40be52b6`. `bun run certify:m9-cloud` then passed
against the live Railway, Neon, R2, and Restate services:

```json
{
  "schemaVersion": 1,
  "status": "passed",
  "profile": "cloud",
  "executionId": "exe_1S09087F5YM1X4KWVHF9MA14JW",
  "artifactId": "art_1S09087F5YM1X4KWVHF9MA14JW",
  "commandStatus": "completed",
  "executionState": "completed",
  "attemptCount": 1,
  "replayed": true,
  "objectKey": "m9/certification/executions/exe_1S09087F5YM1X4KWVHF9MA14JW/6557573a52c08409e47efa253e792017be13638e6f9905de514d27d457ab79e4.json",
  "objectSha256": "sha256:7381b43fce143a6b4ff573146c0e629b6a177bf4513a73acd5620ab7318c533c",
  "startedAt": "2026-08-31T03:50:24.288Z",
  "completedAt": "2026-08-31T03:50:39.111Z"
}
```

The original trusted-key JSON was restored byte-for-byte and verified after Control API
deployment `b949a8bf-7d93-455d-9664-be5d8eeda8df`. Staging was then returned to the
repository's guarded standby state: all three active deployments were removed, source
triggers were disconnected, the retained volume was not destroyed, and a second standby
preview returned no actions. Production was never selected for apply and was not
modified.

## Scenario-to-requirement map

| M11.3 scenario                                                                      | Primary executable evidence                                                                                               | Result                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local managed Pi and ACP direct transport, Artifacts, usage, cancellation, recovery | `tests/m11-standalone-e2e.test.mjs`, `tests/m6-runtime-adapters.test.mjs`                                                 | Fixture/component coverage passed; native acceptance open                       |
| Restate durability, retries, interactions, fan-out/fan-in, budgets, promotion       | `tests/m3-durable-execution.test.mjs`, `tests/m8-multi-agent-orchestration.test.mjs`, `tests/m11-standalone-e2e.test.mjs` | Passed                                                                          |
| Tools, models, credentials, policy, sandbox, usage settlement                       | `tests/m7-tools-models-sandboxes.test.mjs`                                                                                | Fake-provider coordinator coverage passed; native isolation and settlement open |
| Runtime Gateway authentication, inventory, delivery, reconnect, redelivery          | `tests/m5-runtime-gateway.test.mjs`                                                                                       | Passed as component E2E; production composition remains open                    |
| No/disabled/fake/Cortana-compatible context providers                               | `@control-plane/context`, `@control-plane/cortana-context-adapter` package tests                                          | Passed                                                                          |
| Encrypted remote-control relay and opaque persistence                               | `@control-plane/remote-control-relay` package tests                                                                       | Passed                                                                          |
| Profile semantics and deployment adapters                                           | `tests/m10-portability-conformance.test.mjs`, `@control-plane/deployment` tests                                           | Passed                                                                          |
| Local SQLite persistence and restart                                                | `tests/m11-standalone-e2e.test.mjs`, SQLite persistence tests                                                             | Passed                                                                          |
| PostgreSQL repository semantics                                                     | `@control-plane/database` integration suite                                                                               | Passed with extended local timeout                                              |
| Self-hosted Simple clean start/restart                                              | fresh Compose run described above                                                                                         | Passed on local Docker                                                          |
| Self-hosted Server clean start/recovery                                             | Linux Hosted Compose run `33354286908`                                                                                    | Substrate passed; remote runtime execution remains open                         |
| Managed-cloud frozen candidate                                                      | `bun run certify:m9-cloud` against live Railway staging                                                                   | Passed at merged `staging` commit                                               |

## Honest remaining gates

This evidence does not promote fixtures or constructor injection to production proof.
The following gates remain before M11.3 or final M11 approval can be claimed:

1. replace or explicitly disposition the certification-only/unconfigured remote
   runtime activity ports in cloud and Hosted Server production roots;
2. prove a live inventory producer reaches the durable RuntimeConnection and
   ExternalSession projections through a supported composition;
3. execute a representative remote runtime through the Runtime Gateway in the supported
   Linux Hosted Server composition;
4. run the PostgreSQL profile migration lane in its supported Linux CI environment;
5. remove the 17 isolated `control_plane_test_*` databases left in the stopped local
   test volume after the destructive-command safety hook blocked their cleanup.
6. remove the short-lived private certification key directory after the same safety
   hook permits that exact temporary path to be deleted; the public key has already
   been removed from Railway staging.

No production environment was modified by these checks. Railway staging was modified
only for the bounded certification above and was returned to verified standby.
