# M9 Cloud standby closeout — 2026-08-29

## Scope and result

This record closes M9.14 by preserving the M9.6-certified Railway + PostgreSQL + Cloudflare R2 + Restate
Cloud profile in a zero-running-compute standby posture for the Local-first MVP. It supplements, and
does not replace, the live sandbox certification in
[`m9-cloud-certification-2026-08-28.md`](m9-cloud-certification-2026-08-28.md).

The accepted Cloud activation topology is exactly:

- public `control-api`;
- private `workflow-worker`;
- private pinned `restate` with persistent storage where provisioned.

`runtime-worker`, `runtime-gateway`, and `tool-gateway` are not Railway Cloud services. Their former
five-process topology is not a compatibility target. Production was not activated or certified by
this closeout.

## Standby mechanism and provider constraint

Railway rejected a configured replica count of zero through both its TypeScript Infrastructure as
Code validator and live service-instance API. `.railway/railway.ts` therefore owns the explicit
one-replica activation shape. `infrastructure/railway/cost-policy.json` owns the zero-running-compute
baseline, and `scripts/railway-standby.mjs` applies it by:

1. requiring an exact `sandbox` or `production` confirmation for mutation;
2. failing closed on missing, duplicate, or unexpected Cloud services;
3. disconnecting application sources;
4. removing exact active and reactivatable nonterminal deployment revisions;
5. verifying zero running/active replicas, no connected application source, and no pending revision
   that could reactivate compute;
6. preserving Railway services, settings, and volumes.

Railway Serverless remains off. Cold-start, first-request, outbound-connection, worker-registration,
and Restate semantics have not been accepted under a sleep model. Applying `.railway/railway.ts` is
an activation operation, not a standby reconciliation operation.

## Fresh Railway build and activation check

The bounded activation used Git `sandbox` commit
`88b7bba3575853e3783d728237b8807dcd2d3a2b`, the M9.6-certified candidate after PR #270 merged.

- `workflow-worker` deployment `3f4915fa-8ac2-499f-9156-8cbd2afc681d` completed 25/25 clean
  dependency-aware build tasks and published image digest
  `sha256:9baba9cf3f8f5dfed215ff7674c84b8c7c91e073784469e0829476398a6757ed`.
- The worker container started successfully, composed PostgreSQL/Restate dependencies, and passed Railway's
  `/ready` health check. Railway's provider incident `8GL2R2U5` delayed its build/deployment status:
  Railway reported a single-host networking failure and cross-region deployment backlog beginning
  at 2026-08-28 23:59 UTC.
- `control-api` deployment `ea396f85-7e03-4e03-9e9c-fdd204590526` reached terminal `SUCCESS`,
  became the active revision with one running replica, and reported image digest
  `sha256:69c15462cd20be9b361cdf7563ef4db552b099dd5e6c8f6871da021a2220e557`.
  Its public `/health` and `/ready` probes both passed and identified commit `88b7bba3575853e3783d728237b8807dcd2d3a2b`
  before standby removal.
- `workflow-worker` reached terminal `SUCCESS` at 2026-08-29 00:53 UTC and became the active healthy
  revision with one running replica. Railway reported active image digest
  `sha256:ee575b6e516e8ff61f70ce9e4b7c589a39d27c6c99d2c2904859b70c0cffa19a`.

The active-profile resource limits are versioned as:

| Service           | CPU limit | Memory limit |
| ----------------- | --------: | -----------: |
| `control-api`     | 0.25 vCPU |      256 MiB |
| `workflow-worker` | 0.25 vCPU |      256 MiB |
| `restate`         | 0.25 vCPU |        1 GiB |

Each service has one configured activation replica and `sleepApplication: false`.

## Final Railway standby state

| Environment | Service           | Source disconnected | Configured | Running | Active/pending revision |
| ----------- | ----------------- | ------------------: | ---------: | ------: | ----------------------: |
| sandbox     | `control-api`     |                 yes |          1 |       0 |                    none |
| sandbox     | `workflow-worker` |                 yes |          1 |       0 |                    none |
| sandbox     | `restate`         |                 n/a |          1 |       0 |                    none |
| production  | `control-api`     |                 yes |          1 |       0 |                    none |
| production  | `workflow-worker` |                 yes |          1 |       0 |                    none |

Production has no instantiated Restate service or volume. This is configured-not-running state, not
production availability. Production activation requires an explicit release operation and all gates
listed in `docs/operations.md`.

The retained sandbox Restate volume was `READY` before transition:

- volume `ef284217-970d-4314-9ce9-43a5391ad188`;
- instance `603d595c-07d7-4a43-8705-17513e284e8c`;
- 500 MB in `ams`, mounted at `/restate-data`;
- 0.688128 MB observed in use;
- not pending deletion.

After the transition, Railway again reported the same volume instance `READY`, 500 MB, mounted at
`/restate-data`, using 0.688128 MB, and not pending deletion.

## PostgreSQL and R2 preservation

PostgreSQL project `jolly-sea-69660331` remained branch-isolated and idle:

| Environment | Branch                              | Endpoint                 | CU range  | Provider state |
| ----------- | ----------------------------------- | ------------------------ | --------- | -------------- |
| production  | `main` / `br-odd-voice-av06vija`    | `ep-jolly-frog-avwc5i25` | 0.25–0.25 | idle           |
| sandbox     | `sandbox` / `br-late-frog-ava7dzwp` | `ep-damp-pine-avv3jcdj`  | 0.25–0.25 | idle           |

Both endpoints retained `suspend_timeout_seconds: 0`, PostgreSQL's provider-default scale-to-zero policy.
No branch, endpoint, role, schema, or authority change was made for standby.

Cloudflare R2 bucket `ctrl-plane` remained private and intact. Wrangler 4.127.1 reported 13 objects
and 8.37 kB at the snapshot. The following enabled lifecycle rules remain:

- abort incomplete multipart uploads after seven days for all prefixes;
- expire only `m9/certification/` objects after 30 days.

No object, lifecycle rule, bucket policy, credential, or CORS setting was changed during standby.
M9.6 already recorded live adapter put/get/head/delete integrity evidence.

## Usage controls

The Railway billing snapshot before final shutdown reported `$0.04197948592030864` current usage:

| Line item |             Current USD |
| --------- | ----------------------: |
| CPU       |   0.0006934356558641975 |
| Memory    |     0.04121531505777778 |
| Egress    |  0.00004962630000000001 |
| Volume    | 0.000021108906666666666 |

The workspace contained exactly one project, `control-plane`, and had no workspace compute usage
limit. The current trial plan rejected a `$5` soft / `$10` hard limit with `Usage limits require an
active subscription`. The versioned paid-plan policy applies those values only after reconfirming
that the workspace still contains no other project. Railway Agent's separate `$1.50` credit limit is
not a compute usage limit and is not treated as one.

## Reactivation boundaries

sandbox may be activated only for a bounded Cloud integration, recovery, load, or release check:

1. review `railway config plan` against sandbox;
2. reconcile the one-replica activation profile and reconnect sandbox sources;
3. verify PostgreSQL schema/roles, R2 mapping, Restate volume/identity/registration, private networking,
   `/health`, `/ready`, and the required smoke/certification case;
4. capture evidence;
5. preview and apply `bun run railway:standby --environment sandbox --apply --confirm sandbox`.

Production activation is not a scale-only action. It additionally requires reviewed promotion,
production secrets and identities, explicit PostgreSQL migration, a production Restate volume and stable
identity, worker registration, R2 isolation, health/smoke/observability, and rollback verification.

## Repository verification

Before the live transition, the M9.14 candidate passed:

- `bun run format:check`;
- `bun run lint`;
- `bun run type-check`;
- `bun run build`;
- `bun run test` — 511 unit tests and 79 end-to-end tests, with 88.28% line and 83.39% function
  coverage against the 80% minimum;
- `bun test tests/infrastructure.test.mjs` — 8/8;
- `bun run infra:typecheck`;
- `bun run infra:validate`;
- `git diff --check`.

The guarded sandbox apply disconnected the two application deployment triggers and removed these
exact active revisions:

- `control-api`: `ea396f85-7e03-4e03-9e9c-fdd204590526`;
- `workflow-worker`: `3f4915fa-8ac2-499f-9156-8cbd2afc681d`;
- `restate`: `c25875b6-3a6c-4e13-abf8-05625e6e999a`.

Railway's high-level source metadata continues to display the repository name after disconnect, so
the verification uses the authoritative per-service deployment-trigger collection. At 2026-08-29
02:43 UTC, both application collections were empty, all three sandbox services had zero active
deployments and zero running instances, and both of these idempotence previews returned
`"actions": []`:

- `bun run railway:standby --environment sandbox`;
- `bun run railway:standby --environment production`.

Post-transition repository verification passed `bun test tests/infrastructure.test.mjs` with 8/8
tests. The full repository gates are rerun on the finalized evidence revision and in PR CI.
