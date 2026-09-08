# M11 native ACP aggregate usage root cause

Status: open accounting acceptance gap for M11.3/M11.7/M11.8. This investigation
does not certify aggregate costs or change persisted token semantics.

## Latest-release revalidation

On September 8, GitHub reported `v1.10.0` (published September 4) as the latest
release. A fresh read-only clone of that tag resolved to
`061f9a4a2e463a220d7a3ab2ae5e9732837085ef`. It retains the loss boundary:

- `src/CodexEventHandler.ts:1283` stores `last` and `total` separately;
  `:1291` still emits context occupancy from the last counter.
- `src/CodexAcpServer.ts:2914` and `:3148` build successful prompt usage from
  `lastTokenUsage`; cancellation (`:3249`) and terminal failure (`:3266`) do
  the same. `buildPromptUsage` at `:3293` simply converts its argument.
- `totalTokenUsage` is used for formatted command output in
  `src/CodexCommands.ts:424`, not as an authoritative per-prompt response
  breakdown. `src/TokenCount.ts` retains the cache/reasoning category mapping
  described below.

Source: [immutable prompt-response implementation](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexAcpServer.ts#L3146)
and [immutable usage-event implementation](https://github.com/agentclientprotocol/codex-acp/blob/061f9a4a2e463a220d7a3ab2ae5e9732837085ef/src/CodexEventHandler.ts#L1282).

A plain upgrade to this release does not address the identified source-level
gap. No dependency pin changed, no upstream source was edited, and no native
binary or model request was run during this revalidation. Native behavior on
`v1.10.0` is not certified by this source inspection. The corrective matrix below
still applies; a bridge change or independently authoritative usage source is
required before claiming aggregate settlement correctness.

## Original pinned-runtime investigation

The existing native Local permission probe executes multiple fixture model calls
but persists input/output tokens 11/3. A fresh checkout of
`agentclientprotocol/codex-acp` tag `v1.7.0` resolved to
`2b48e9822330fc09f3a94a81563e5c4bb779601a` and establishes the loss boundary:

- `src/CodexEventHandler.ts:1246`: `handleTokenUsageUpdated` receives both
  `params.tokenUsage.last` and `.total`, storing them separately.
- `src/CodexEventHandler.ts:1252`: `createUsageUpdate` exposes only the last
  total-token count as context `used`, together with context-window `size`.
  It does not expose aggregate input/output/cache/reasoning breakdowns.
- `src/CodexAcpServer.ts:2772`: the final prompt response builds usage from
  `sessionState.lastTokenUsage`, not the aggregate counter.
- `src/CodexAcpServer.ts:2898`: quota metadata also uses the last counter;
  parsing that metadata would not recover missing aggregate usage.
- `src/TokenCount.ts`: conversion subtracts cached input from input tokens,
  exposes it separately as `cachedReadTokens`, and includes reasoning within
  output while exposing `thoughtTokens` separately. These categories must not
  be blindly summed as independent billable output.

Control Plane's `packages/acp-adapter/src/process-transport.ts` faithfully copies
the final input/output values and retains `nativeUsage` in the result artifact.
This preserves the received evidence but cannot recover information absent from
the wire. The current probe explicitly tests that persistence, not full billing.

## Required corrective work

Use an upstream bridge change or an independently authoritative usage source
that exposes a complete per-prompt breakdown. If deriving prompt usage from
session cumulative counters, capture a baseline before the prompt and prove
counter scope, reset/reload behavior, repeated notifications, and monotonicity;
do not charge the full session total again on each prompt. Preserve ambiguity
when counters are unavailable or inconsistent rather than manufacturing zero.

Validate at least a multi-tool prompt, two sequential prompts in one session,
cache/reasoning categories, duplicate updates, cancellation after partial usage,
and process loss. Compare persisted usage and settlement against independently
recorded provider/fixture calls. Pin the corrected bridge artifact and rerun
native public-API acceptance before claiming this gate passed. Summing context
occupancy notifications is not a valid correction.

No upstream repository was modified or published by this investigation. The
source checkout was read-only; no agent binary or model request was started.
