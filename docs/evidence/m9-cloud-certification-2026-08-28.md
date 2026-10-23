# M9 managed-cloud sandbox certification — 2026-08-28

## Scope and result

The Railway `sandbox` environment passed a bounded live certification of the managed-cloud profile:
Railway compute, Railway PostgreSQL, Cloudflare R2, and Restate. This evidence applies to sandbox only.
It does not certify production, Agent HQ integration, or the later Local and Hosted profiles.

The live candidate accepted authenticated execution requests, persisted authoritative command,
execution, attempt, and plan state in PostgreSQL, completed the durable lifecycle through Restate, retained
and integrity-checked results through the R2 `ObjectStore`, and returned the original execution and
artifact on replay. The same behavior passed after service and Restate restarts and in a five-request
concurrent sample.

## Candidate identity and topology

- Railway project: `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`.
- Railway environment: `sandbox` (`3beb119e-1b23-4fa6-9af3-2c6b9976708f`).
- Deployed application source: Git `sandbox` at
  `3acb0db9fb4c9d2ad067429161ea9b75864ffe91`.
- Certification harness branch: `codex/m9-railway-sandbox-certification`; harness and infrastructure
  corrections are reviewed in PR #270.
- Public Control API: `https://control-planecontrol-api-sandbox.up.railway.app`.
- `control-api` service/deployment:
  `9167a33b-af0f-4780-8614-a5a161697c9c` / `d84b486f-0495-488b-b42d-87365d216e18`.
- `workflow-worker` service/deployment:
  `d733ec0d-bda5-4be5-86b9-637154d282eb` / `307102f4-6757-4062-a76c-1bc4598aae39`.
- `restate` service/deployment:
  `31dc2df5-9ca8-46f0-ab1b-bf89caeda5d6` / `3a95a094-63af-4aaa-ae47-f02411e12825`.
- Restate image:
  `docker.restate.dev/restatedev/restate:1.7.7@sha256:dd1695b61c9de877d24bf9afe8a0ac5fb0f66d175c1bc397975d2252bd784eb2`.
- Restate volume: `restate-data` (`ef284217-970d-4314-9ce9-43a5391ad188`), 500 MB in `ams`, mounted
  at `/restate-data`.
- Restate deployment registration: `dp_15PPui4pzvigZQjyeTsQDf3`, service
  `execution-lifecycle`, revision 1.
- Private endpoints: workflow worker on
  `http://control-planeworkflow-worker.railway.internal:9080`; Restate ingress on
  `http://control-planerestate.railway.internal:8080`. Restate administration remains private.

The obsolete Railway service resources for tool-gateway, runtime-gateway, and runtime-worker were
removed from the project after explicit operator approval. Their source code remains available; they
are not part of the accepted managed-cloud sandbox topology.

## Build, configuration, and health

- Fresh Railway application builds passed all 25 build tasks for both application services.
- Railway health checks passed for `/health` and `/ready`; the public Control API returned HTTP 200
  for both endpoints.
- The repository-owned Railway configuration declares build commands, start commands, health paths,
  regions, replica counts, the worker port, the pinned Restate image, and the persistent volume.
- The Restate request-identity public key configured on the worker matched the public half derived
  from the volume-backed Restate private key. Secret values were not included in this record.
- Restate registration survived an explicit Restate restart.

Two deliberately retained failed-deployment records demonstrate the safe forward-repair path:
`control-api` deployment `2e215233-1659-402a-a646-22e5a0423c9a` and `workflow-worker` deployment
`c86ae590-dbda-4b79-81bb-f9faca8c2682`. The new revisions failed startup because required managed
configuration was absent or malformed; Railway kept the previous healthy revisions serving. The
configuration was corrected and new healthy revisions were deployed without database rollback.

## PostgreSQL evidence

The live harness read terminal execution state from the sandbox database using the same runtime
repository as the services. A separate read-only privilege audit reported:

- current role `control_plane_app`, database `railway`;
- no superuser, role-creation, database-creation, replication, or row-security-bypass authority;
- `USAGE` but no `CREATE` on `public`;
- no `USAGE` or `CREATE` on `postgres_auth` and zero table grants there;
- 29 Control Plane base tables in `public`.

The audit ran in a read-only transaction and rolled back. This confirms that application code neither
requires nor has runtime access to the unrelated `postgres_auth` schema.

## R2 evidence

- Account: `aa2dc82d7e02aff12b77800a8201df3f`; private bucket: `ctrl-plane`.
- Railway uses a bucket-scoped object read/write credential. No credential values appear here.
- The certification harness performed `get` and `head`, verified exact body and metadata digests,
  and retained the result object.
- A separate adapter smoke used key `m9/synthetic/delete-smoke-1787959486302.json`: put, get, and
  head all returned 32 bytes with digest
  `sha256:e218ba61a8c4a788950c4d95a32902f5ed780e696240de9cb56cd2c718bc863e`, then delete was confirmed by
  the adapter's `OBJECT_STORE_NOT_FOUND` result.
- Lifecycle rule `Expire M9 certification artifacts` expires only the `m9/certification/` prefix
  after 30 days. The bucket's default seven-day incomplete-multipart abort rule remains in place.
- Agent HQ must use separate storage authority; this bucket and its credentials belong to Control
  Plane only.

## Live execution and recovery records

| Scenario                   | Execution                        | Artifact                         | Result digest                                                             | Observed interval (UTC)   |
| -------------------------- | -------------------------------- | -------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| Baseline                   | `exe_1VED72EAAV4QS6RAFP7CCKEN4X` | `art_1VED72EAAV4QS6RAFP7CCKEN4X` | `sha256:aea20741490ebf7260d744f6300d3fb04ef00f11827169cbb4309202a3a4dad0` | 23:06:30.688–23:06:44.346 |
| After Restate restart      | `exe_1CBQH771ER96YX8DHHVRCEMFMQ` | `art_1CBQH771ER96YX8DHHVRCEMFMQ` | `sha256:64f557a4b770575439dfb1ce6f24ef6b0e9b799fc492e2a43f21e0d9fcdde2bd` | 23:10:27.035–23:10:39.347 |
| After application restarts | `exe_39WVBZRJKG3Z9ZBS180FYQ4HAP` | `art_39WVBZRJKG3Z9ZBS180FYQ4HAP` | `sha256:a0638c32d054fd77841747b87561855fc5db0161ebaf3d7f041ed925218fb538` | 23:12:34.659–23:12:47.285 |

Every record reached terminal command, execution, and attempt state with one attempt. Exact R2 digest
verification passed, and replay returned the original logical execution and artifact.

The bounded concurrent live sample passed 5/5 requests with one attempt each. Durations were 12–13
seconds (median 13 seconds). Execution IDs were:

- `exe_3GBA69BG9A1H2210YS8FDCJE48`
- `exe_6K9G8QMNC48PKXZYDVR416DG87`
- `exe_36SANVPEB35S99SS841660ACZ8`
- `exe_338F7A22S5BSBM85ZDA2285B0D`
- `exe_66EG0W02PP73HRY70TWA5QR17W`

This sample demonstrates bounded sandbox concurrency and restart recovery. It is not a claim of
production-scale capacity or a measured 60-minute RTO exercise. No committed logical work or
artifact was lost in the exercised restart scenarios.

## Security and verification

- An unauthenticated live acceptance request returned HTTP 401 with
  `SERVICE_CREDENTIAL_REQUIRED`.
- A malformed bearer credential returned HTTP 401 with `SERVICE_CREDENTIAL_MALFORMED`.
- Exact managed encryption and R2 secret values were compared internally against the latest 500
  application log entries; none were present.
- `bun run test:isolation-matrix` passed 87 tests across 14 production cells.
- `bun run test:secret-canaries` passed 64 tests across seven production sinks.
- `bun run test:load` passed all nine profiles and the telemetry-overhead gate: each profile ran
  2,000 operations with zero failures; measured p95 values ranged from 0.091 ms to 3.868 ms, and
  p50 telemetry overhead was 0.104 ms against the 2 ms threshold.

The isolation, canary, and load suites above are repository synthetic/local gates. The authentication,
restart, execution, R2, PostgreSQL, concurrency, health, and resource observations are live sandbox evidence.

## Resource and cost observations

Railway sandbox metrics collected during deployment, restarts, and certification showed:

| Service         | Average CPU (vCPU) | Peak CPU | Average memory (GB) | Peak memory (GB) |        RX / TX (GB) |
| --------------- | -----------------: | -------: | ------------------: | ---------------: | ------------------: |
| control-api     |            0.00362 |  0.02102 |             0.10273 |          0.10659 | 0.000463 / 0.000219 |
| workflow-worker |            0.00362 |  0.01673 |             0.09773 |          0.12633 | 0.001027 / 0.000641 |
| Restate         |            0.01309 |  0.01873 |             0.58797 |          0.72593 | 0.000170 / 0.000016 |

Project usage for the partial 2026-08-28 billing period was `$0.02617`. Railway's project cost view
aggregates same-named services across environments, so `$0.01703` for control-api and `$0.00655` for
workflow-worker are not sandbox-only values; Restate was `$0.00258`. A short-window projection from
the sandbox metrics and published resource rates is approximately `$8.37/month` plus egress, including
the 500 MB Restate volume. This is an indicative active-window projection, not a reliable monthly
forecast. Railway recommends at least one week of usage before relying on a monthly estimate.

## Remaining boundaries

- Production remains outside this certification and must be promoted only through the reviewed
  `sandbox` to `main` release flow.
- The short observation window does not replace a week-long idle/active cost baseline or a timed
  disaster-recovery exercise. Those values should be refreshed after sustained operation.
- M10 must preserve the accepted execution, persistence, durability, storage-integrity, security,
  and replay semantics while replacing deployment adapters for Local and Hosted profiles.
