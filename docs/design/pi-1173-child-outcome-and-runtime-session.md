# Pi #1173: child outcome read and single RuntimeSession

Status: design note, source-verified against CP `main` at `6af44842`. No production code changes. #1173 stays open, and nothing here implies live authorization.

## 1. Child outcome read: existing contract, existing Adea consumer

CP's authorized child read already exists. It is not a new operation.

- CP operation: `POST /v3/pi-durable/lead-dispatches/children`, `execution:read` scope
  (`apps/control-api/src/pi-durable/pi-durable-lead.controller.ts`).
- Contract: `PiDurableLeadChildrenRequestSchema` and `PiDurableLeadChildrenResponseSchema`
  (`packages/runtime-sdk/src/pi-durable-lead.ts`), with the client operation
  `getPiDurableLeadChildren` in `packages/control-sdk/src/operations.ts`.
- Origin: `f96ff8fb feat(pi-durable): authorized read of lead child status, input state and outcomes (#1160)`.
  It is an ancestor of the Adea journey pin `69e6e746` (CP release 1.104.0).
- Contract test: `packages/runtime-sdk/src/pi-durable-lead.test.mjs`, "children read is a strict
  read-only contract of opaque references and bounded outcomes".

The read returns, per child: `state` (`requested` through `manual_intervention`), `awaitingInput`,
`stopRequested`, `revision`, and an optional `outcome`. The outcome has `state` (`completed`,
`failed` or `cancelled`), an opaque `resultRef`, a bounded `failureCode`, and `publication`. Pages are
ordered by acceptance time then delegation ID, with `totalChildren`, `complete` and `next`.

**`outcome.publication.status` is the retained CP delegation publication state** (`pending` or
`published`, with an optional `resolution`) for the child's result. It records what CP retains. It is not
an Adea timeline receipt, and nothing in Adea should treat it as proof that a timeline entry was published.

### What Adea already has, and what it does not

- **Existing consumer:** Adea's product route `lead-turn-children` (`apps/web/src/server/lead-turn-children.ts`,
  `lead-turn-routes.ts`) reads the operation through the SDK. Its tests live in
  `apps/web/test/lead-turn-children.test.ts`, and Adea #1513 documents this consumer in the journey README.
- **Missing proof:** the journey run does not exercise the read end to end. Its child result was checked
  from CP's own records. There is no journey-level proof of child-state rendering, of the timeline
  publication path, or of a UI view that draws child outcomes.

So the remaining work for this item is Adea journey, UI and timeline proof. It is not a CP contract gap,
and it is not a new CP operation.

Out of scope and unchanged: child cancel, and any approval grant. `awaitingInput` is observation, never a grant.

## 2. Single RuntimeSession across Dev and Chat

Invariants CP already enforces:

- A dispatch receipt binds one `runtimeSessionId`, taken from the adapter handle
  (`PiDurableLeadReceiptResponseSchema`).
- `observedTarget` (`sessionId`, `taskId`) is server-owned, from the handle and the admitted plan.
- `requestedTarget` is a caller claim and is optional. `generation` is deliberately absent from the observed target.
- Retrieval is by receipt: `lookup` and `status` return the existing receipt. A second surface can
  observe the same session without creating one.

Not enforced, and not admitted anywhere in CP: a handoff target that moves an active lead to a different
surface, and a single-RuntimeSession invariant spanning two surfaces. The journey harness admits no handoff
target, so this path is not exercised today.

Decided here, as ordinary design: one dispatch receipt maps to exactly one `runtimeSessionId`. Dev and Chat
attach by `lookup` and `status` on that receipt and never create a second session for the same intent.

## 3. Decisions (current direction)

| Item | Status | Basis |
| --- | --- | --- |
| Pre-dispatch kill | Decided: keep `unknown`, no resend | Andrew, 04:28 UTC. Re-admitting a dispatch reservation would change spend semantics, so it is not done. Pinned by `tests/profile-recovery-pi-lead-restart.test.mjs` and `packages/usage-ledger/src/durable.test.mjs`. |
| Production revocation fence | Existing contract. Source-only fail-closed implementation and tests are allowed. No grant expansion, no activation, no wiring. | Andrew, 04:29 UTC. The contract is at `production-source-lead-product.ts:81-84`, `publication-current.service.ts:23` and `source-publication-current.ts:22-24`, pinned by `production-source-lead-product.test.mjs:221` and `:239`. Production has no implementation yet. |
| Child read contract | Done on main (#1160). No new operation. Adea consumer exists (#1513 documents it). | Section 1. |
| Child cancel and approval | Excluded. Needs a new policy decision before any design. | Andrew, 04:28 UTC, excluded from scope. |
| Handoff target admission | Genuinely new policy. Not admitted. Needs a product decision before any design. | Section 2. |
| Dev and Chat attach to one receipt | Decided here | Section 2. |

Genuinely new policy stays a decision. Existing-contract work, including the source-only fence, is not
blocked on a generic access-control approval.
