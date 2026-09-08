# M11 native ACP aggregate usage root cause

Status: open accounting acceptance gap for M11.3/M11.7/M11.8. This investigation
does not certify aggregate costs or change persisted token semantics.

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
