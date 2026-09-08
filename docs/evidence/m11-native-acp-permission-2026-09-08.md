# M11 native ACP permission continuation

## Scope and result

On 2026-09-08, the isolated native permission probe completed through the
authenticated public SDK, Local SQLite interaction storage, and real Restate.
This is a narrow Local acceptance result, not completion of M11 or all four
deployment profiles.

The probe used `@agentclientprotocol/codex-acp@1.7.0` and
`@openai/codex@0.148.0` in a task-owned container with no host mounts, no
credentials, no external network after installation, dropped capabilities, and
no-new-privileges. The model fixture ran on container loopback. Native
`INITIAL_AGENT_MODE=read-only` selected user-reviewed permission requests.

The fixture's first model response requested `exec_command` to append one line to
`/tmp/m11-permission-proof` inside that container. The probe checked that this
file did not exist before granting the persisted permission through the SDK.
After completion, acceptance and response replay retained one attempt, exactly
one marker line, and two model requests.

Successful probe output:

```json
{
  "state": "completed",
  "persistedUsage": { "inputTokens": 11, "outputTokens": 3, "durationMs": 313 },
  "acceptanceReplay": true,
  "attempts": 1,
  "realRestate": true,
  "workflowCompleted": true,
  "nativePermission": true,
  "publicSdk": true,
  "markerWrites": 1,
  "modelCalls": 2,
  "aggregateUsageVerified": false
}
```

## Reproduced defects and fixes

1. ACP exposed a pending permission as `running`. Local converted this
   nonterminal status into a failed outcome and terminal cleanup cancelled the
   request. A focused native-process test reproduced `running` instead of
   `awaiting_input`. The transport now derives waiting status from pending
   permissions while keeping its underlying prompt/update/cancellation lifecycle
   running.
2. Approval delivery returns before the native prompt finishes. Local treated
   that running acknowledgement as failure. Local now consumes progress until
   completion or a subsequent pending interaction. Replayed, durably resolved
   interaction events do not suspend the resumed turn again. Tests cover both
   completed and running response acknowledgements.

## Usage limitation and remaining gates

The two fixture model responses each report 11 input and 3 output tokens, but
the pinned native adapter exposes only the last usage breakdown. Source checked
at upstream tag `v1.7.0`, commit
`2b48e9822330fc09f3a94a81563e5c4bb779601a`:
`CodexEventHandler.ts` assigns `params.tokenUsage.last` to `lastTokenUsage`, and
`CodexAcpServer.ts` returns `toPromptUsage(lastTokenUsage)`. The probe verifies
faithful persistence of that native result, **not aggregate execution cost**.
Aggregate accounting, native process-restart recovery,
all-profile parity, independent review, and the broader M11 acceptance matrix
remain open.

Reproduction fixtures are
`fixtures/m11-acp-responses-2026-09-08.mjs` (set `M11_PERMISSION_PROBE=1`) and
`fixtures/m11-acp-local-probe-2026-09-08.mjs <isolated-container> permission`.
Use a fresh marker and model-call counter for each run; never attach host
credentials or a host workspace to this probe.

## Two sequential native approvals

The `repeated-permission` probe also passed on 2026-09-08 using the same pinned
packages and container isolation. Set the model fixture's
`M11_PERMISSION_PROBE=2`. It returned distinct function-call IDs for two tool
requests, each requiring a separate public SDK grant. Before each grant, the
probe asserted the exact marker contents: empty before the first and one line
before the second. Final contents contained exactly two lines. Replaying both
commands after completion did not add another line or model request.

Observed result: `completed`, one attempt, two marker writes, three model calls,
and native-reported usage 11 input / 3 output tokens with duration 453 ms.
Aggregate usage remains unverified; the three fixture responses total 33/9.
The SQLite regression `repeated-interaction.test.mjs` separately exercises
replayed interaction history and both durable effect replays (12 assertions).
Neither test establishes process-restart reattachment or all-profile parity.

## Native cancellation with connection-close evidence

The cancellation probe passed on 2026-09-08 at candidate `6254e98` with the
connection-observation fixture changes in this commit. The same pinned native
packages ran without host mounts or external networking. With
`M11_HOLD_RESPONSES=1`, the model fixture observed one active native request before
the internal Restate cancellation signal. Afterwards it observed zero active
requests and exactly one closed held connection. Local SQLite and workflow attach
both reported cancelled; acceptance replay retained one attempt and one model
request. Observed cancellation settlement was 81 ms, below the probe's five-second
bound and native prompt timeout.

```json
{
  "state": "cancelled",
  "acceptanceReplay": true,
  "attempts": 1,
  "realRestate": true,
  "workflowCompleted": true,
  "cancellationElapsedMs": 81,
  "nativeModelConnectionClosed": true
}
```

Run `fixtures/m11-acp-local-probe-2026-09-08.mjs <isolated-container> cancel`;
`M11_WORKFLOW_PORT` optionally selects the Local workflow endpoint port. An initial
run stopped before execution on a port collision; the successful run used 19085.
This is Local direct ACP evidence with a deterministic model fixture. It does not
certify public API cancellation, remote gateway cancellation, live-provider billing,
native process restart, or all-profile convergence.
