# M11.10 Railway live-state readback — 2026-09-29

**Observed at:** status/configuration at 2026-09-29 12:21 UTC; production runtime logs re-read at 12:41 UTC
**Source:** live Railway MCP readbacks. This records provider state only; it is not an M11 deployment-profile acceptance or production certification.

## Production

- Project: `control-plane`.
- The latest `control-api` and `workflow-worker` deployments were `SUCCESS` at 08:39 UTC. A 12:41 UTC runtime-log re-read confirmed both services identify source commit `61700f346663fbb9fb62d1fc27c859362ae2d4f1`.
- Current `main` is `96d8224ac9ef9b2f57d544f04e5358ac617da044`; the deployed application revision therefore predates current `main`.
- The separately deployed Restate service was `SUCCESS`, using Restate 1.7.7 and image digest prefix `dd1695…`; it had one replica and a 500 MB `/restate-data` volume.
- The Control API configuration has a `/ready` healthcheck and a public Railway domain; the worker is private.
- The API runtime log records `GET /ready` returning HTTP 200 in 68 ms at 08:39:17 UTC, immediately after that deployment started.
- API logs also contain hourly `retention.sweep` warnings through 12:39 UTC, blocked by `COMMAND_RETENTION_ELIGIBILITY_REQUIRED` and `EVENT_RETENTION_ELIGIBILITY_REQUIRED`. The blocked classes had no eligible records in the reported sweeps; this is an outstanding retention-policy/operability signal, not evidence of data loss.

Successful deployment status and these log observations do not establish M11 profile acceptance or production availability. The snapshot does not include post-deploy migration, representative execution, recovery, rollback, or full readiness evidence.

## Staging

- No successful active deployment was present in the current status readback. The API and worker showed failed historical status dated 2026-09-16; Restate's last successful status was dated 2026-08-28.
- Deployment inventory includes later attempts through 2026-09-28 that were removed. Those removed attempts are not active deployment evidence.
- Staging remains on-demand: do not keep compute live between qualification runs; retain the Restate volume.

This is a point-in-time snapshot, not a mutation of Railway or Neon. No variable values, credentials, or secret material are included.
