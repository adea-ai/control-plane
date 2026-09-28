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

## Integrated runtime command composition

Luna implementation `ec939dec` is integrated as `9eaaddcd`; root review hardening
`43894bb` is integrated as `510f84ab`. The real composition now owns the selected
SQLite/PostgreSQL runtime command repository and connects delivery, pending
dispatch, reconnect reconciliation and event ingestion to the WebSocket
lifecycle. `start()` forwards explicit runtime options. Context-only callers
retain their existing mode and runtime frames remain fail-closed there.

The runtime mode requires host execution/effect, quarantine, validator,
retained-outcome, execution-reconciliation and Artifact-verification ports.
Missing/malformed ports fail before the store opens. The validator guards
durable admission and dispatch, and is checked again after the dispatch write
and before sending. Scope, active ownership and negotiated protocol are checked
independently; a v1.7 command cannot be sent to a v1.6 channel or rewritten to
downgrade its immutable semantics.

Succeeded Artifact references require host verification before terminal effects.
Denied references leave execution state and events unchanged. Rejected/conflicting
terminal effects cannot settle the command ledger. Completed/failed/cancelled
winners survive replay past command expiry; overdue nonterminal commands expire
without send even after grant revocation. Runtime construction failure and socket
drain failure close owned stores, preserving cleanup errors without disabling
lint. Invalid native idle/heartbeat limits fail before store opening.

The new tests use actual Bun WebSockets, authenticated synthetic node credentials,
the real lifecycle/delivery/ingestion services and a SQLite command store. Execution
effects and host authorities are fixture ports, not production provisioning.
SQLite close/reopen retains running-command identity and reconciles without
redelivery. Terminal success/failure/cancellation preserve attributed measured
usage. Root replaced fixed-delay negative assertions with observed quarantine,
validator/disconnect and reconciliation conditions.

No live PostgreSQL runtime-composition acceptance was run in this checkpoint;
the PostgreSQL construction branch is type-checked, not deployment-certified.
The actual worker-owned outbound connector, enrollment/credentials, production
host provider, scoped artifact upload/read implementation and inventory operator
wiring remain required. No reference host or synthetic credential is activated
as a production default.

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

Final integrated validation at source `510f84abd9303f2a7281e3c6b7c298b8215a9704`:

```sh
bun test ./apps/runtime-gateway/src ./apps/runtime-worker/src \
  tests/m11-context-composition.test.mjs tests/m11-consistency-metric-wiring.test.mjs \
  tests/repository.test.mjs tests/foundation.test.mjs \
  --randomize --seed 1104 --timeout 30000
bun run build
bun run architecture:check
bun run requirements:check
bun run check:boundaries
```

- Combined complete affected packages and four root suites: **228 passed /
  0 failed / 822 assertions / 22 files / 6.73s**, no skips or name filters.
- Final isolated gateway package: **145 passed / 0 failed / 620 assertions /
  14 files / 2.53s**; build, strict whole-package lint, formatting and whitespace
  passed. Full workspace build: **41 successful / 41 total / 39 cached**, with
  both modified applications rebuilt, 5.405s.
- Final architecture 41/16/4, live requirements 200/103, boundaries 1,494 files /
  41 packages / zero issues. Generated architecture refresh followed by formatting
  produces no semantic or classification change and no retained file diff.
- Failed runs preserved: gateway behavioral RED 12 pass/4 fail after correcting
  synthetic-identity fixture configuration; an early worker full run 137 pass/1
  fail because a router stub returned void instead of the effect result; root
  whole-package strict lint exposed pre-existing inventory shadowing. The local
  rename initially missed a second reference and failed type-check; both references
  are now corrected and the final full build passes. No gate was bypassed.
- Independent artifact review confirms byte/binding checks and identifies the
  cross-instance first-write race described above as an outstanding production
  gate, not an accepted completion claim.

The bounded implementation worker is settled/interrupted after its in-flight
commit completed; the read-only reviewer completed with zero resources. Test
fixtures close their ephemeral loopback sockets and remove their owned directories.
The two checkouts remain owned by unfinished M11; no task archival or deployment
change occurred. The historical local PostgreSQL container remains stopped, with
its volume retained for the unfinished audit.

## Remaining release gates

The full frozen Cloud, Local and Hosted simple/server scenario matrix, real
Pi/ACP/tools/model/MCP/sandbox behavior, child/graph reservations and authorized
financial settlement, deployed recovery/migration/restore/capacity, security
and adversarial/manual evaluation, GitHub/Drive/Skills reconciliation and
independent final/human acceptance remain required. Known native measurement
is not authorized provider cost or a charge. No issue closes from this checkpoint.
