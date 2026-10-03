# Cost follow-up verification — 2026-10-03

This audit independently checks the cost work merged in [PR #839](https://github.com/adea-ai/control-plane/pull/839), rather than treating the completed authoring session as acceptance evidence. The baseline is `25ae017edafd509d799a6a7a0acf58e89452c72b`.

## Live resource evidence

Read-only Railway configuration, inventory, health, and metrics at approximately 01:35 UTC confirmed:

- Production contains only one running `control-api` replica, with no Railway volumes. There is no running production workflow-worker or Restate placeholder.
- The API is healthy, with no pending production changes or recent failures. Its limits are 0.5 CPU and 1,073,741,824 bytes; its health check is `/health`. The live promoted image is `ghcr.io/adea-ai/control-plane-control-api@sha256:757c5fc77e8c3d12b9a1816a474bf919ec42a6308b2ce072696b58b3382712c3`.
- The last-hour API memory samples ranged up to 615,659,520 bytes, with a current sample of 135,737,344 bytes. This supports the observed limit, but is not a load or long-running qualification.
- All three Railway staging services are offline. The initial status snapshot reported one historical Restate deployment failure and an old empty staged patch; the later inventory returned no staged patch. The later inventory also confirmed that staging has no Restate volume or mount. No staging operation was applied during this audit.

The authenticated Neon CLI project API confirmed that both the production and staging endpoints are idle. Production's recorded suspension time is `2026-10-03T01:00:33Z`, after its last activity at `00:54:58Z`. Three additional active endpoints belong to the current main CI preview branches; they are not abandoned production/staging resources and were left to their workflow's cleanup.

Railway reports $7.995647979911128 of accrued project usage for the billing period September 12–October 12, including historical/deleted resources. Restate accounts for $5.428777358094579 of that accrued total. These are period-to-date amounts, not demonstrated monthly savings or a forecast of the new configuration. The authenticated workspace limit readback on October 3 confirmed an existing $5 soft alert and $10 hard limit with `isOverLimit=false`. Those thresholds were preserved. No spending limits, platform configuration, or production resources were changed by this audit.

## Catalog refresh gap and correction

The existing unchanged-identity shortcut correctly avoids fetching the immutable artifact set again. However, the mutable `catalog-latest.v1.json` is **27,242,051 bytes**, according to authenticated GitHub contents metadata. It is a full catalog, byte-identical to the corresponding immutable catalog, rather than a small metadata pointer. The old shortcut still downloads and parses that body each refresh.

The follow-up retains an ETag only after full snapshot verification, sends `If-None-Match` on subsequent latest-catalog reads, and accepts a bodyless `304` only when revalidating a previously verified snapshot. A changed response still undergoes the existing full verification. A same-identity response must match the verified immutable catalog bytes before its validator is retained. Failures mark the held snapshot stale without replacing its verified validator. Registries without ETags keep the existing unconditional-body fallback and byte caps.

A read-only GET to the actual publication endpoint with its current ETag returned HTTP **304** and downloaded **0 bytes**. This proves provider support, not deployment of this follow-up. Production must receive the verified release before its polling reduction can be claimed.

Focused regression evidence: the conditional-request and validator-binding tests failed before the change; the integrity-failure stale-state regression also failed before correction. The complete marketplace test file then passed, including changed catalogs, no-validator fallback, failed refresh, unsolicited `304`, failed initial verification, identity mismatch, authentication, and streaming byte limits.

## Production source ownership follow-up

The original production IaC omitted the image source; the provider's omit-as-delete behavior could clear the promoted digest. The follow-up requires an immutable control-api image and adds `bun run railway:production-plan`. This read-only helper resolves the linked target, verifies that the source matches the sole active successful deployment and its digest, and supplies the current image to the planner. It rejects stale caller input, other targets, source changes, and image/deployment/linked-target changes during planning. It does not apply a plan.

The actual read-only production plan passed before the subsequent release promotion: it contained no source diff and reported only the existing restart-policy/sleep-setting drift (`null` to `ON_FAILURE`/`false`). That drift was not applied. Sixteen focused tests passed, including stale images, pending promotions, wrong targets, source deletion, concurrent image/deployment/linked-target changes, and unchanged staging Git source. Infrastructure type checking and validation, workspace type checking, build, lint, and formatting passed; lint retained existing warnings.

Adea's stopped-staging example origin was corrected in [PR #978](https://github.com/adea-ai/adea/pull/978), merged as `8a78e5a06c5552635786bb16ea895a4a9a5abeab` after both required checks passed. Its six catalog-proxy tests and build passed. The example now points to the production API and documents local Docker origin/credentials; no runtime credentials or deployment settings changed.

## Docker acceptance and remaining boundaries

Fresh Hosted Simple and Hosted Server Compose builds at `4c3aa3fd03eea91c0acd5f123f28c85b0e2d8e19` passed on Docker Desktop's Linux/arm64 engine. Simple verified persisted credential permissions and authentication across recreation. Server verified 58 migrations, least-privilege database roles, and readiness degradation/recovery after actual PostgreSQL and Restate outages. [The Docker evidence](m11-hosted-docker-2026-10-03.md) records the exact candidate, pinned images, observations, cleanup, and limits.

The user explicitly selected **Docker** for fresh-environment acceptance and stated that no VPS exists or should be created. M11 acceptance must exercise actual supported Docker compositions and functional requirements. This cost audit does not certify graph recovery, native runtime isolation, profile conformance, or the complete milestone. No paid production runtime was reactivated to obtain test evidence.
