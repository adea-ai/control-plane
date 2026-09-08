# M11 native ACP permission continuation

## Experimental aggregate accounting — 2026-09-08

A local, unpublished patch to upstream `v1.7.0` passed the two-call permission
probe with `M11_AGGREGATE_USAGE=1`. The bundled harness SHA-256 was
`e43f61a54b37456c7c6bc02287d84f128f4aa3cce1f3b6cde771146ce32cc911`.
Real Restate and Local SQLite settled 22 input / 6 output tokens, one attempt,
one approved marker write, two model calls, and successful acceptance replay.
The container had no mounts or external network and was removed after the run.

The patch subtracts a known prompt baseline from monotonic cumulative native
counts, ignores stale-turn notifications, and returns unavailable usage for an
unknown baseline or counter regression. Fifteen focused tests, upstream type
checking, the bundle build, and the wider upstream suite (489 passed, 26 skipped)
passed. This is experimental fresh-session evidence, not installation support or
an upstream release. Loaded-session baseline recovery, cancelled-execution usage
settlement, live-provider billing and all-profile certification remain open.
The original unpatched observations below are retained as historical evidence.

The exact source change is retained in
[`fixtures/codex-acp-1.7.0-prompt-usage.patch`](fixtures/codex-acp-1.7.0-prompt-usage.patch).
Apply it only to upstream commit `2b48e9822330fc09f3a94a81563e5c4bb779601a`
(`agentclientprotocol/codex-acp`, tag `v1.7.0`), using `git apply --unidiff-zero`.
The zero-context format avoids whitespace-only patch context lines. The isolated patched commit was
`15983ca`. Reproduce with the upstream lockfile: `npm ci --ignore-scripts`,
`npx --no-install vitest run --no-file-parallelism --retry=0`,
`npm run typecheck`, and `npm run build`. Replace the harness bundle only inside
the disposable probe container, then run the Local probe in `permission` mode
with `M11_AGGREGATE_USAGE=1`. This patch is evidence, not an automatic install hook.

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

The probe now publishes the fixture ContextPackage and supplies the repository-backed
task resolver required by Local ACP. Its previous constructor failed with
`ACP_LOCAL_PROMPT_RESOLVER_REQUIRED` after that contract changed. Plan/context
resolution and runtime construction were rechecked without starting a native harness;
this maintenance check does not replace a new isolated native run or resolve the
aggregate usage limitation above.

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

## Public SDK cancellation

The updated probe passed on 2026-09-08 from candidate `d3e2015` plus the fixture
changes in this commit. Both acceptance and cancellation used the authenticated
public SDK/HTTP route; cancellation no longer called the internal Restate handler
directly. Local cancellation receipts and the production dispatcher delivered the
signal to real Restate and the pinned native ACP process. Observed settlement was
69 ms. The held model connection closed, SQLite and workflow attach reported
cancelled, and acceptance replay retained one attempt. Replaying cancellation with
a different command ID returned the original ID and `replayed: true`, without
another model request.

The container retained the previously documented isolation and exact package
versions. Formatting and fixture lint passed. This closes the narrow Local public
native cancellation path; Cloud/remote transport parity, paid-provider behavior,
process-restart recovery, usage settlement, and all-profile convergence remain open.
