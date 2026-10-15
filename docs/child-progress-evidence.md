# Child progress evidence and correlated usage outcomes

The M13.04.2 surfaces (refs adea-ai/control-plane#1019) keep a lead responsive
while sibling children run, retain material outcomes with correlated usage, and
stay wired to the canonical durable paths rather than a parallel ledger.

## Surfaces

- **`ChildProgressEvidenceBuffer`** (`packages/orchestration`) folds child
  observations into fresh, bounded evidence packets: bounded entries/children
  per packet, owner-owned provenance (`eventId`, `observedAt`, `generation`),
  duplicate detection by content-derived identity, and explicit rejection
  reasons (stale generation, terminal generation, foreign parent, conflicting
  event or child identity). Packets carry a content digest over the canonical
  JSON of every field — re-sequencing cannot re-derive a valid packet.
- **`ChildProgressLeadDispatcher`** owns delivery policy: human input and
  critical observations (awaiting input, terminal outcomes) reach the outbox in
  the same scheduling step that accepted them, routine progress coalesces under
  bounded pressure, and every delivery carries a monotonic `sequence` so
  consumers can detect reordering.
- **`ChildProgressLeadFeed`** is the live wiring: it implements the canonical
  `DelegationEventPublisher` over the durable publication inbox
  (`SqliteDelegationEventPublisher`), so every publication the
  `DelegationService` — or the production `PiDurableChildProgressScanner`
  through `recordChildProgress` — makes folds into the dispatcher in the same
  step. Evidence event identity derives deterministically from event content,
  so restart `replay()` rebuilds the projection exactly once and re-folds
  answer `duplicate`; changed content cannot pass as a duplicate. Durability
  comes first: a failed canonical publish never reaches the lead.
- **`resolveEvidenceReferences`** resolves packet references (terminal-result
  artifacts, interactions) lazily against an authority's **current**
  authorization at read time. Verdicts are `authorized`, `unavailable`, or
  `forbidden` (`revoked` / `not_authorized`); payloads are never returned —
  callers fetch content behind their own authorized channel.
- **`ChildUsageLedger`** records the explicit cost-state machine for a child
  attempt: `unknown → estimated → reserved → reported → reconciled →
  settled`, where `unknown` is first-class (never a blank or an inferred zero).
  A newer report supersedes the reconciliation **and** settlement recorded
  against its predecessor; a new reservation supersedes the reconciliation
  frozen against the old bound; report dedup and stale-report protection
  survive restart through `snapshot()`/`restore()` (bounded content-hash
  horizons, two-phase restore).
- **`SqliteChildUsageOutcomeRepository`** persists those snapshots with
  forward-only revisions: a stale in-memory owner can never clobber a newer
  durable projection. The money itself stays in the canonical
  `@control-plane/usage-ledger` durable store (`SqliteDurableUsageStore`).
- **`ParallelDelegationCoordinator`** accepts an optional `contexts`
  persistence port: the coordinator still derives each branch's context
  package itself, but compositions backed by a validating (durable) plan
  repository retain it before the child plan is written. In-memory
  compositions omit the port unchanged.

## Compositions that prove the path

- `tests/pi-durable-governed-child-composition.test.mjs` — actual lead and
  separately funded child runtimes: `bridge.reserveBudget` records reservation
  evidence in the same step as the canonical `openBudget`/`reserve`, canonical
  `settleUsage` drives reported → reconciled → settled from the returned priced
  usage, the production scanner publishes terminal evidence through the feed,
  human input lands ahead of batching, and cost states persist across
  close/reopen.
- `tests/pi-durable-compaction-governed-dispatch.test.mjs` — the actual
  production Pi lead factory after a native-session compaction and a full
  composition reopen: the lead's `delegate_child` call runs the real governed
  executor and delegation bridge, current grants are read again for the
  dispatch, the child is allocated, funded from the parent's stated allowance
  (`DurableChildRuntimeBudgetAdmission`), started once and runs its own
  priced turn, whose reservation, exact usage and release are retained. A
  grant withdrawn after the reopen leaves no child, reservation or start.
  The same file then settles the child: the attempt reservation, the child
  budget (releasing the unspent funding back into the parent's allowance) and
  the cost-state projection (`reserved` -> `reported` -> `reconciled` ->
  `settled`, retained through `SqliteChildUsageOutcomeRepository`). The lead is
  settled by the production `SqlitePiLeadTerminalSettlement`. Settlement is
  interrupted after each durable step and resumed after a physical restart
  with no repeated debit, release, start, send or publication, and a child
  whose send outcome is unknown is never settled. The provider transport,
  funding records and policy decision are scripted fixtures, and the child
  settlement driver is test-only: production settles leads only and no
  composition root runs a child settlement yet.
- `tests/child-progress-two-siblings-composition.test.mjs` — **two sibling
  children under one real parent**: coordinator admission over durable SQLite
  repositories, canonical per-child reservations and settlements in the
  durable usage ledger, retained progress through the service and feed, lead
  human input alongside both children, canonical cascade cancellation with
  terminal evidence packets for each sibling, and a real restart with
  exactly-once replay plus cost-state restore.

## Honest limits

- The governed runtime executor keeps its single-child guard
  (`childExecutions.maximumTotal === 1`); coordinator-admitted siblings do not
  start Pi runtimes on this branch, because the bridge's `startChild` seam
  exists only behind that executor. The transactional child admission allocator
  from adea-ai/control-plane#1041 now writes the child execution, parent-budget
  reservation, child budget, and delegation record in one transaction while
  enforcing total, depth, and concurrency limits. The allocator does not wire
  coordinator siblings to separate Pi runtimes; that per-branch runtime dispatch
  seam remains outstanding.
- Same-parent compaction and child-admission behavior is not yet integrated in a
  regression test. The manual compaction test in
  `packages/sqlite-persistence/src/child-budget-admission.test.mjs` uses Pi's
  standalone `pi.sqlite` harness, while its admission fixtures (previously in
  that test) used separate `state.sqlite` stores. It now proves only that Pi
  compaction persists its summary; it does not prove that one parent's child
  budget, depth, total, or concurrency fences remain enforced after compaction.
  That combined proof remains open acceptance evidence.
- `reported`/`reconciled`/`settled` cost states are exercised where a real
  model settlement exists (the governed composition); compositions without a
  provider settlement stay at `reserved` — no usage report is ever fabricated.
- Evidence and usage states are projections; authoritative money, publications
  and identity remain the durable usage ledger, delegation publications, and
  canonical execution/attempt records.
