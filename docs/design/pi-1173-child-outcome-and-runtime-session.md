# Pi #1173: child outcome read and single RuntimeSession

Status: design note, source-verified on `origin/main` at `6af44842`. No production code changes.

## 1. Child outcome read: already on main

The child status and outcome read that the #1173 journey README lists as "not proved" already exists:

- Operation: `POST /v3/pi-durable/lead-dispatches/children`, `execution:read` scope
  (`apps/control-api/src/pi-durable/pi-durable-lead.controller.ts`).
- Contract: `PiDurableLeadChildrenRequestSchema` and `PiDurableLeadChildrenResponseSchema`
  (`packages/runtime-sdk/src/pi-durable-lead.ts`), with the client operation in
  `packages/control-sdk/src/operations.ts`.
- Origin: `f96ff8fb feat(pi-durable): authorized read of lead child status, input state and outcomes (#1160)`.
  This commit is an ancestor of the Adea journey pin `69e6e746` (CP release 1.104.0).

What the read returns, per child: `state` (`requested` through `manual_intervention`), `awaitingInput`,
`stopRequested`, `revision`, and an `outcome` with `state` (`completed`, `failed`, `cancelled`), an
opaque `resultRef`, a bounded `failureCode`, and `publication` (`pending` or `published`, with a
`resolution`). Pages are ordered by acceptance time then delegation ID, with `totalChildren`,
`complete` and `next`. The contract test is `packages/runtime-sdk/src/pi-durable-lead.test.mjs`,
"children read is a strict read-only contract of opaque references and bounded outcomes".

Consequence: the journey README's "no child status, child outcome" claim is stale for the pinned CP
revision. Adding a second read here would duplicate #1160, so this note proposes none.

What remains is consumption on the Adea side: whether Adea reads, shows and publishes the child
outcome through this operation. That is Adea product and journey work, not CP.

Out of scope and unchanged: child cancel, and any approval grant. `awaitingInput` is observation,
never a grant.

## 2. Single RuntimeSession across Dev and Chat

Invariants CP already enforces:

- A dispatch receipt binds one `runtimeSessionId`, taken from the adapter handle
  (`PiDurableLeadReceiptResponseSchema`).
- `observedTarget` (`sessionId`, `taskId`) is server-owned, from the handle and the admitted plan.
- `requestedTarget` is a caller claim and is optional. `generation` is deliberately absent from the observed target.
- Retrieval is by receipt: `lookup` and `status` return the existing receipt. A second surface can
  therefore observe the same session without creating one.

Not enforced, and not admitted anywhere in CP: a handoff target that moves an active lead to a
different surface, and a single-RuntimeSession invariant spanning two surfaces. The journey harness
admits no handoff target, so this path has no exercise today.

Proposed invariant (decision-free, ordinary design): one dispatch receipt maps to exactly one
`runtimeSessionId`. Dev and Chat attach by `lookup` and `status` on that receipt and never create a
second session for the same intent.

## 3. Decisions

| Decision | Who decides | Options | Recommendation | Affected |
| --- | --- | --- | --- | --- |
| Resume or hold after a pre-dispatch kill | Andrew (spend semantics) | (a) hold `unknown`, fail closed; (b) re-admit a dispatch reservation that never reached the provider | (a) now | `packages/usage-ledger/src/durable.ts`, `tests/profile-recovery-pi-lead-restart.test.mjs` |
| Production revocation fence in CP | Andrew (access control) | (a) implement a lock-held fence through acceptance; (b) leave it unproved and disclose | Decide with Andrew; no implementation here | `apps/control-api/src/models/production-source-lead-product.ts` (injected port, no CP implementation found) |
| Child cancel or approval operations | Product | (a) keep read-only; (b) add operations | (a) until Adea needs them | `packages/runtime-sdk/src/pi-durable-lead.ts` |
| Handoff target admission | Product | (a) none; (b) explicit handoff in prepare | (a) until a spec exists | prepare and dispatch contracts |
| Dev and Chat attach to one receipt | Ordinary design, decided here | fixed as section 2 | attach by lookup and status | Adea product |

Ordinary decisions resolved here: section 1 needs no new operation, and section 2 needs no new
contract.
