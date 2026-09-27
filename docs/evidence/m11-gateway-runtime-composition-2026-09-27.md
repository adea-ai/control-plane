# M11 runtime gateway composition and Hosted artifact integrity

Scope: original #188 and #190, with operational/documentation obligations in
#194 and #195. This is implementation evidence, not full milestone acceptance.
The original seven issues #188, #190, #191 and #194–#197 remain open as verified
on 2026-09-27. PR #743 remains draft at the preceding published candidate
`ddb54ae3ee5882382de9f57588da38c26c1bca99` while this checkpoint is prepared.

## Source-backed startup gap

At the preceding candidate, the gateway composition constructs context command
services, but installs `RUNTIME_GATEWAY_ROUTE_NOT_COMPOSED` for runtime ACK,
result, error, progress and inventory routes. It does not connect the existing
runtime command dispatcher or reconnect reconciliation service to the socket
lifecycle. Worker composition constructs the context handler around a supplied
transport, not a worker-owned outbound connector. The default worker executable
supplies no Hosted provider and refuses production startup.

Node enrollment and credential issuance remain application/operator authority.
No synthetic identity authority is a production substitute. The current Hosted
host implementation is a reference fixture; a real resource-isolated provider,
scoped model/tool launch authority, node transport and artifact upload authority
remain required. Channel authentication alone is not capability authorization.
These findings determine the next implementation action without redefining the
original profile acceptance matrix.

## Hosted artifact integrity

The real `ObjectStoreHostedArtifactStore` previously accepted matching HEAD/PUT
descriptors without reading the bytes. It also kept fulfilled promises forever,
so a warm replay could report success after the object disappeared. A regression
run against that implementation produced **0 passed / 12 failed / 13 assertions**.

The updated store checks the attempt-bound key, metadata, media type, size and
SHA-256, then GETs and hashes actual bytes before returning a reference. Initial
writes, warm replay and reconstructed cold replay use the same verification.
Only in-flight identical writes are coalesced. A failed/lost PUT acknowledgement
can recover matching stored bytes without a second PUT. A replay after an object
is absent persists the same deterministic result and verifies it again; it does
not return a cached successful reference.

The default output bound is 256 KiB; explicit operator limits range from 1 byte
to 64 MiB and remain subject to the underlying ObjectStore limit. Oversized input
is refused before any ObjectStore call. Corrupt bytes, wrong descriptor keys,
wrong attempt metadata, mismatched GET digest/size/media type, unreadable writes
and conflicting in-flight content cannot produce successful references.

This preserves the existing attempt-bound object path/reference algorithm and
canonical JSON format. It does not add workspace/node/command upload authority,
change R2 credentials, prove cross-process conditional-write exclusivity, or
certify a real Hosted provider. Independent external writers must still obey
the host's admitted-attempt authority; ObjectStore has no conditional PUT port.
Objects predating the change already carry attempt metadata from this writer;
unbound legacy objects fail closed rather than receiving automatic repair.

## Validation so far

Host toolchain: Bun 1.4.0, Node 24.18.0. No production or staging service,
credential or database was changed.

- Initial focused artifact + existing Hosted suite: **29 passed / 0 failed /
  85 assertions / 2 files**.
- Expanded complete runtime-worker suite, randomized seed 1104:
  **47 passed / 0 failed / 154 assertions / 4 files**, no skips or name filters.
- `bun --cwd=apps/runtime-worker run build`: passed on an authoritative separate
  rerun. An earlier combined handle delivered the test totals but disappeared
  before delivering the subsequent build/lint exit; those undelivered gates
  were not counted as passing.
- Changed-file strict lint, formatting and whitespace checks passed.
- Architecture check: 41 packages / 16 operations / 4 profiles. Live requirements
  check: 200 requirements / 103 issue audits. Boundaries: 1,493 files / 41 packages
  / zero issues. These are structural checks, not runtime/deployment acceptance.

## Remaining release gates

The full frozen Cloud, Local and Hosted simple/server scenario matrix, real
Pi/ACP/tools/model/MCP/sandbox behavior, child/graph reservations and authorized
financial settlement, deployed recovery/migration/restore/capacity, security
and adversarial/manual evaluation, GitHub/Drive/Skills reconciliation and
independent final/human acceptance remain required. Known native measurement
is not authorized provider cost or a charge. No issue closes from this checkpoint.
