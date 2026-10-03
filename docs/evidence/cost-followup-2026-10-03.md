# Cost follow-up verification — 2026-10-03

This audit independently checks the cost work merged in [PR #839](https://github.com/adea-ai/control-plane/pull/839), rather than treating the completed authoring session as acceptance evidence. The baseline is `25ae017edafd509d799a6a7a0acf58e89452c72b`.

## Live resource evidence

Read-only Railway configuration, inventory, health, and metrics at approximately 01:35 UTC confirmed:

- Production contains only one running `control-api` replica, with no Railway volumes. There is no running production workflow-worker or Restate placeholder.
- The API is healthy, with no pending production changes or recent failures. Its limits are 0.5 CPU and 1,073,741,824 bytes; its health check is `/health`. The live promoted image is `ghcr.io/adea-ai/control-plane-control-api@sha256:757c5fc77e8c3d12b9a1816a474bf919ec42a6308b2ce072696b58b3382712c3`.
- The last-hour API memory samples ranged up to 615,659,520 bytes, with a current sample of 135,737,344 bytes. This supports the observed limit, but is not a load or long-running qualification.
- All three Railway staging services are offline. The inventory still reports one historical Restate deployment failure and an old empty staged patch. Neither was applied or removed as part of this audit.

The authenticated Neon CLI project API confirmed that both the production and staging endpoints are idle. Production's recorded suspension time is `2026-10-03T01:00:33Z`, after its last activity at `00:54:58Z`. Three additional active endpoints belong to the current main CI preview branches; they are not abandoned production/staging resources and were left to their workflow's cleanup.

Railway reports $7.995647979911128 of accrued project usage for the billing period September 12–October 12, including historical/deleted resources. Restate accounts for $5.428777358094579 of that accrued total. These are period-to-date amounts, not demonstrated monthly savings or a forecast of the new configuration. No new spending limits, platform configuration, or production resources were applied during this audit.

## Catalog refresh gap and correction

The existing unchanged-identity shortcut correctly avoids fetching the immutable artifact set again. However, the mutable `catalog-latest.v1.json` is **27,242,051 bytes**, according to authenticated GitHub contents metadata. It is a full catalog, byte-identical to the corresponding immutable catalog, rather than a small metadata pointer. The old shortcut still downloads and parses that body each refresh.

The follow-up retains an ETag only after full snapshot verification, sends `If-None-Match` on subsequent latest-catalog reads, and accepts a bodyless `304` only when revalidating a previously verified snapshot. A changed response still undergoes the existing full verification. A same-identity response must match the verified immutable catalog bytes before its validator is retained. Failures mark the held snapshot stale without replacing its verified validator. Registries without ETags keep the existing unconditional-body fallback and byte caps.

A read-only GET to the actual publication endpoint with its current ETag returned HTTP **304** and downloaded **0 bytes**. This proves provider support, not deployment of this follow-up. Production must receive the verified release before its polling reduction can be claimed.

Focused regression evidence: the conditional-request and validator-binding tests failed before the change; the integrity-failure stale-state regression also failed before correction. The complete marketplace test file then passed, including changed catalogs, no-validator fallback, failed refresh, unsolicited `304`, failed initial verification, identity mismatch, authentication, and streaming byte limits.

## Remaining acceptance boundaries

Production IaC omits the image source, and its documentation acknowledges that the provider's planner can clear the promoted image. That needs an explicit, fail-closed source-ownership follow-up; a temporary hand-edited authoring file is not a durable fix. Adea's example endpoint also points to normally stopped staging and is being corrected separately.

The user explicitly selected **Docker** for fresh-environment acceptance and stated that no VPS exists or should be created. M11 acceptance must exercise actual supported Docker compositions and functional requirements. This cost audit does not certify graph recovery, native runtime isolation, profile conformance, or the complete milestone. No paid production runtime was reactivated to obtain test evidence.
