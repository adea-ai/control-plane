# Opt-in Docker native Pi verification — 2026-10-03

This records the bounded Docker results on the source commit below, before integration with later main commits and relocation of packaging tests into the repository smoke suite. It is fixture evidence, not a full M11 completion claim. No API token or provider credential is included.

## Source and commit

- Branch: `codex/docker-native-pi-20261003`
- Commit: `7244b923f7c2f96e9328be943e57ecae504b8790` (`feat(docker): add opt-in native Pi runtime`)
- Runtime image ID / local manifest digest: `sha256:89103406fd0738885e75448118d045f895837e15a6d4ed382e101819a91f711d`
- Certification image ID / local manifest digest: `sha256:55f8c6fa2a0edcd199e982561b52704b60f4b4016a841379d0cbe017d62c288f`
- Source SHA-256: entrypoint `edb167c88823851c020244cdfc84927a43b3dcca78585e1d5e552da68c92af3f`; preflight helper `287c85cb9d1067d1512437c95a38798a296b69a75f866b8f7eeea89fac12cff7`; config sync `b7b7f105541c2ba60cfd107aad6fe39d3a0ba3538db3a845885e9075b6c45d70`; cert harness `f7094613389ff112da0f67cfe2e9ddc3ef1702f17fb35aac04380bc116e472d2`.

## Deterministic model certification

Both runs used the same read-only fixture `auth.json`, copied into private runtime state, and `network_mode: none`. Pi was `0.84.2`, Node `v24.21.0`, Bun `1.4.2`; report label was `local-deterministic-http-fixture`.

- Local embedded-SQLite: `requests=4`, `completed=true`, `cancellation=true`; selected E2E output was `2 pass`, `9 filtered out`, `0 fail`, `Ran 2 tests across 1 file` (completion and cancellation both passed); cert cleanup reported `completed`.
- Local Restate: `requests=4`, `completed=true`, `cancellation=true`, `restateIngressAttach=confirmed-completed-and-cancelled`; selected E2E output was `2 pass`, `9 filtered out`, `0 fail`, `Ran 2 tests across 1 file` (completion and cancellation both passed); cert cleanup reported `completed`.

The four local HTTP fixture requests are the direct completion/cancellation pair plus the selected Local completion/cancellation pair. No external provider endpoint, model credentials, or provider-quality assertion was used.

## Shipped overlay recreation

The final runtime image was force-recreated twice with the fixture route, host configuration mounted read-only, and the task-owned data directory. The running container used that exact image ID and `/usr/local/bin/managed-pi-entrypoint`; wrapper and preflight-helper hashes matched the source. It had zero restarts. After the repeat recreate: `/ready=200`, `/health=200`, config mount read-only, fixture credential loaded, source mode `700`, runtime directory mode `700`, copied `auth.json` mode `600`; bearer-token and marker hashes were unchanged. A request to the authenticated acceptance route with a deliberately incomplete envelope returned `400` validation (not `401`); no execution was accepted and no model request was made.

SQLite byte hashes changed on cold startup/checkpoint, so byte identity is not claimed. Read-only `PRAGMA integrity_check` returned `ok`; logical state before/after the repeat recreate remained `control_plane_metadata=3` rows and `control_plane_records=0` rows. No committed execution/business record was present or claimed as preserved.

The wrapper runs the 30-second exact-version preflight before the Control Plane entrypoint, under only `PATH` and `PI_CODING_AGENT_DIR`; only sanitized failure codes are emitted. Completed application startup on the exact image establishes the preflight returned successfully. Version `--version` itself makes no model request.

## Validation and cleanup

- Focused package tests: `9 pass`, `0 fail` across the packaging/config-sync and preflight test files.
- Local-control-plane Oxlint passed; Oxfmt check passed for all changed JS/MJS; shell syntax and `git diff --check` passed.
- `docker compose ... config --quiet` passed for the opt-in overlay.
- `mise exec -- bun audit` in `infrastructure/containers/managed-pi`: no vulnerabilities found, 131 packages checked.
- Docker runtime and certification target builds completed successfully.
- Removed only project `cp-m11-native-pi-20261003`, its default network, the two task image tags, and `/private/tmp/control-plane-m11-20261003/native-pi-docker`. Final check: zero project containers/networks/image tags, fixture path removed, host port `33462` closed. Unrelated Docker resources were left intact.

## Limits remaining

The certification exercises the existing Local composition and pinned Pi against a deterministic in-container model fixture. The shipping Simple API still needs catalog/context inputs before public-root execution can be asserted. Real provider credentials, provider/model quality, OAuth refresh behavior, and the broader M11 acceptance matrix remain unverified.
