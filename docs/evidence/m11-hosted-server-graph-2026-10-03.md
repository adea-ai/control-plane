# Hosted Server graph launcher acceptance — 2026-10-03

## Result

The opt-in Hosted Server graph path passed its public API acceptance, persisted approval, cold
restart, effect, accounting, and replay checks. The acceptance used PostgreSQL 18.6 and Restate
1.7.13 in task-owned Docker containers, while the Hosted process ran through the exported
environment-configured `start()` launcher on the test host. It did not exercise the Docker Compose
Hosted image with graph configuration enabled.

The main run was:

```sh
bun test --timeout 120000 ./src/hosted-graph.integration.test.mjs
```

from `apps/hosted-control-plane`, with the database and Restate integration flags enabled. Result:
**1 test passed, 0 failed, 38 assertions**. The dedicated PostgreSQL operations regression passed
**5 tests, 0 failed, 18 assertions**; the unit checks for the PostgreSQL tool limiter passed
**1 test, 0 failed, 2 assertions**. The Task-local logs and resource ledger retain the individual
run receipts; no credentials or private key material are part of this record.

## What the run exercised

The negative control submitted the same fully populated graph request with the normal launcher
feature selector absent. Hosted validation rejected it with a client error before creating an
acceptance receipt. The enabled run used `CONTROL_PLANE_HOSTED_GRAPH_ENABLED=true` and a temporary
operator configuration file through the normal `start()` environment. It did not inject a graph
runtime or graph activity adapter. The test seeded the published graph, execution plan, profile,
and related catalog records through the PostgreSQL repositories, then used the public
`/v1/executions/accept` endpoint and the registered Restate `execution-lifecycle` service.

Canonical execution admission and `RuntimeDiscoveryAttemptRouter` remained enabled. The test
provided a fresh, healthy, connected, eligible mock discovery projection for the selected runtime
route because this graph-specific acceptance has no native model/provider runtime attached. That
fixture only satisfies routing admission: the graph operation, Restate workflow/activity,
PostgreSQL checkpoint, tool registry, approval interaction, object write, and usage ledger all ran
through their production implementations. No provider or model call was made.

The graph reached a persisted `awaiting_approval` tool call before any artifact or tool charge
existed. The test restarted the Hosted process while the Restate invocation was suspended, observed
the same PostgreSQL checkpoint and pending interaction after startup, and approved through the
public interaction endpoint. The Restate resume re-read persisted interaction state, continued the
same graph operation, and wrote the accepted JSON input bytes once. The test checked the stored
content digest and workspace/project metadata, one 25-microunit tool charge and settled
reservation, terminal completion, and a replay returning the same execution without another write
or charge.

Before startup, the isolated application database role attempted `CREATE TABLE` and `ALTER TABLE`
inside transactions. PostgreSQL denied both with SQLSTATE `42501`; the probes rolled back. The
ordinary Hosted startup then verified the already-migrated checkpoint schema and completed using
that same application-role database. Migrations were applied separately through the migration
role.

The PostgreSQL operations regression also exercised same-receipt replay, concurrent admission at a
limit of one, an earlier caller timestamp following a future-dated admitted event, unequal-clock
concurrent calls, and immutable tool/tariff configuration across restarts. The post-fix runs passed.
An earlier run configured the Restate endpoint as `127.0.0.1`, which the Docker-hosted Restate
process could not reach; it failed at deployment registration before creating an execution. The
successful runs used the Docker-reachable `host.docker.internal` endpoint URI. Both attempts shut
down their Hosted listeners and dropped their isolated database. The task-owned PostgreSQL and
Restate containers and private Restate journal remain retained for root's final review and orderly
cleanup.

## Limits

This certifies one graph shape and one internal JSON artifact operation. The runtime-route metadata
is a test fixture, not certification of a native provider, managed Pi, ACP, or model execution.
The application was launched with the exported host `start()` API, not the production image's
Compose entrypoint. This is not capacity, soak, generic Linux, cloud-provider, or complete M11
acceptance evidence. Graph execution remains opt-in, and unsupported operation kinds remain
disabled.
