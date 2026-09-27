# M11 repair release 1.58.4 readback

This records deployment of the incremental audit repair batch, not final M11
acceptance. Observations were collected on 2026-09-27.

## Source and promotion

- [Repair PR #740](https://github.com/adea-ai/control-plane/pull/740) passed
  current-head required checks and its actual Neon integration lane, then
  squash-merged as `58559d9a0b4b4283396635f8b25bf633f4a87beb`.
- The generated version/changelog-only [release PR #744](https://github.com/adea-ai/control-plane/pull/744)
  passed its required gates and was automatically squash-merged as
  `622f90cecd4c2923abccc8b68a6b540f0ea78bf9` at 04:15:48 UTC.
- [workspace-v1.58.4](https://github.com/adea-ai/control-plane/releases/tag/workspace-v1.58.4)
  was published at 04:16:07 UTC, neither draft nor prerelease.
- [Container Promotion 36293814804](https://github.com/adea-ai/control-plane/actions/runs/36293814804)
  succeeded on that exact source and tag. Both images passed scanning,
  SBOM publication and provenance attestation before deployment.

## Production readback

The tagged production migration/runtime-role gate passed at 04:21:01.687 UTC
before promotion. It required equality with the entire tagged canonical
migration history: 50 entries ending at `0049_worried_vance_astro`. Both actual
service database bindings and runtime-role capabilities were checked by the
gate. This is gate-enforced readback, not a separately exported production SQL
snapshot.

Railway project `18c6a1fd-6b4b-421e-9ec9-fd1550ce9a3f`, production environment
`52f5b0ac-2af0-4792-aa56-30d80e5db31e`, returned the following exact configured
image digests and successful deployments:

| Service         | Image digest                                                              | Successful deployment                  | Promotion artifact |
| --------------- | ------------------------------------------------------------------------- | -------------------------------------- | ------------------ |
| control-api     | `sha256:374b1c5116392a12963bfd2938281714e1b9ab1645c16ae4d40903b030414bad` | `d7cc41b9-4ea2-4bf5-944c-6579df6adaa0` | `10922987707`      |
| workflow-worker | `sha256:bf5eff875275392c3785dfe8eebcc35a4ce473e211cff9c171befeb668190a8f` | `9eca1389-120a-438e-a616-1c21ce07e154` | `10923630745`      |

The downloaded promotion manifest SHA-256 values were
`c2778730936dd39deefbd01bd6ead6a2d05bc2e0c3e42b2243adfd4c38670735` (API) and
`95d836cf9712ae922bf7f26144eeebad0a3ecc9f5f22f0ab0740c8e899f020c0` (worker).
Configured image names use `ghcr.io/adea-ai/control-plane-control-api` and
`ghcr.io/adea-ai/control-plane-workflow-worker`, respectively.

The API `/ready` readback returned `ready`, the exact released commit above,
`production`, and the API deployment ID as its version. The worker deployment
was successful; this is not a separate public worker readiness probe or a
native-runtime execution. Restate remained on successful deployment
`0f5686ff-a8fc-489f-976a-6e370fb70d08`; it was not redeployed by this batch.

## Remaining gates

No staging mutation, manual deployment, production-role rewrite, CI bypass or
milestone waiver was used. Durable holds and remaining retention classes,
live-provider/runtime and full-profile acceptance, measured profile RPO/RTO,
native-document reconciliation, blinded evaluations and independent human
approval remain open. Later hold code and migration `0050` are not part of this
released image or its deployment evidence.
