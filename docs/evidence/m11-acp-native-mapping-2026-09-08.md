# Native ACP transport mapping investigation

Base candidate: `b0908948aaf21606fb361ac19dfde3ebe44a4b71` (merged #423).
The initial investigation was source-backed guidance. The isolated native probe
below adds limited execution evidence, not full runtime certification.

The proposed Codex ACP target remains v1.7.0, source commit
`2b48e9822330fc09f3a94a81563e5c4bb779601a` in
`agentclientprotocol/codex-acp`. Its source was inspected without installing or
running its dependencies, accessing credentials, or invoking a model.

## Required mappings before native certification

| Boundary            | Observed requirement                                                                        | Implementation consequence                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session creation    | v1 uses `session/new` with `cwd` and `mcpServers`.                                          | The process transport must provide authorized configuration and retain create-token identity; a timed-out create must not blindly create again.                                                              |
| Prompt dispatch     | The `session/prompt` response arrives after the turn finishes.                              | Return a local dispatch acknowledgement while observing the pending response, so the driver can consume updates and answer permissions. Awaiting the final response inside `start` can deadlock an approval. |
| Output              | Text chunks carry `content.type` / `content.text`; `messageId` is optional.                 | Translate native content explicitly and distinguish locally assigned correlation IDs from native IDs. Do not treat raw v1 chunks as the normalized `AcpUpdate` shape.                                        |
| Permissions         | Native requests use JSON-RPC IDs and advertised option IDs.                                 | Preserve both identities; map only supported decision kinds and avoid persistent approval when only one-time approval was authorized.                                                                        |
| Usage notifications | `usage_update.used` and `size` describe session context occupancy.                          | Never translate `used` into input-token billing or use it as final per-turn usage.                                                                                                                           |
| Final usage         | The pinned source's `toPromptUsage` returns a breakdown on the prompt response.             | Validate final usage, retain cache/thought detail for accounting, and do not replace absent usage with measured zero.                                                                                        |
| Cancellation        | `session/cancel` is a notification; pending permission requests receive cancelled outcomes. | Continue accepting in-flight updates and wait for the original prompt's cancelled response before claiming confirmed cancellation.                                                                           |
| Recovery            | The current process client only owns framing and child lifecycle.                           | Process loss or timeout does not prove native side effects stopped; keep ambiguity non-retryable until reconciled. Native session, descendant, and restart cleanup still need execution evidence.            |

Primary protocol references:
[session setup](https://agentclientprotocol.com/protocol/v1/session-setup) and
[prompt lifecycle](https://agentclientprotocol.com/protocol/v1/prompt-turn).
Pinned implementation references are `src/TokenCount.ts`,
`src/CodexEventHandler.ts` (`createUsageUpdate`), and
`src/__tests__/CodexACPAgent/data/token-usage-end-turn.json` at the commit above.

The existing normalized adapter schemas are not native wire schemas. In
particular, completed snapshots require usage, and normalized progress currently
has only status/output/interaction/usage/artifact event kinds. Native tool and
non-text content mapping must be accounted for before claiming full capability
coverage. No certification registry entry was promoted by this investigation.

## In-progress transport implementation

The unpublished `process-transport.ts` now connects `AcpStdioClient` to
`AcpDriver` for native v1-shaped messages. Package build and the initial four process-backed
driver tests passed (11 assertions): approval/output/final usage/duplicate start,
cancellation, absent usage, and process loss. These use a disposable wire fixture,
not the proposed Codex ACP binary. Process loss remains `unknown` at the driver
boundary; the test does not relabel it as confirmed native failure.
The root lint, type-check, formatting, build, and test sequence passed on this
draft; E2E remained 101 tests / 571 assertions. This broad check does not cover
the native lifecycle gaps listed below.

The creation/cleanup follow-up passes nine focused tests / 28 assertions. Early
notifications are buffered during pending creation, bounded to 4096 updates and
4 MiB, and attached only to the returned session ID. A lost create response
retains its rejected token outcome instead of creating twice. A pre-aborted
create sends nothing and leaves the token unused. Cleanup has an independent
request deadline and abortable wait; neither timeout nor abort reports native
cancellation. Early-notification and cleanup-deadline regressions failed before
these fixes. The focused fixture uses a one-second request/cleanup budget and
four-second turn budget, avoiding a narrow subprocess-start timing assumption.

The concurrent-creation and early-buffer-limit follow-up passes 12 focused tests /
41 assertions. Reverse-order create replies retain only their own session's early
updates; duplicate tokens do not issue another create. Both the 4096-message and
4 MiB early-buffer limits disconnect and retain the rejected token outcome.
These are wire-fixture checks, not real-agent certification.

CI run `34183431945` initially failed the PostgreSQL disruption drill's 30-second
readiness check; the log does not retain the failed SQL probe diagnostic. The
same recovery matrix passed locally with all 22 named scenarios, including
restart and backup/restore. A failed-job rerun was requested without relaxing
the readiness deadline. This does not establish the cause of the CI timeout.
Attempt 2 passed all recovery gates. The next commit's independent CI recovery
run `34184090350` also passed; the original timeout remains unexplained.

## Isolated native execution probe

On 2026-09-08, the published `@agentclientprotocol/codex-acp@1.7.0` and
`@openai/codex@0.148.0` ran in a disposable Linux container, using Node 24.18.0
image digest `sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d`.
Installation used `--ignore-scripts --no-audit --no-fund --save-exact`; direct
dependencies matched the upstream v1.7.0 lock: ACP SDK 1.4.0, diff 9.0.0,
open 11.0.1, vscode-jsonrpc 9.0.1, zod 4.4.3. This was an isolated npm install,
not a repository dependency change. The published ACP package integrity was
`sha512-+nUhAJyunx8Zc7r3jjLPoMPPUkkk02TmBIosln4l+ugRNUOdNQAMm6toZo7xb+mF1yM5zxJB83qvy/bPmOTaaw==`.

The container had no mounts, dropped all capabilities, enabled no-new-privileges,
and used 1 GiB / 128-process limits. Its bridge network was disconnected after
installation and before session/prompt probes. No host credentials or config were
mounted; no HOME or CODEX_HOME overrides were used. The custom gateway used empty
headers and a loopback-only [Responses fixture](fixtures/m11-acp-responses-2026-09-08.mjs).

Observed:

- Native initialization returned protocol 1 and agent version 1.7.0; the bundled
  CLI reported `codex-cli 0.148.0`.
- `AcpProcessTransport` created a real native session, retained its early updates,
  and returned the same session for a duplicate create token.
- A transport prompt completed with streamed text and final input/output usage
  11/3. Native context occupancy 14 was retained separately.
- Two driver probes (the one-off command and the retained
  [probe script](fixtures/m11-acp-driver-probe-2026-09-08.mjs)) each completed with
  one output event, usage 11/3, and an identical handle on duplicate `start`.
  Measured driver turn durations were 41 ms and 36 ms; these are fixture
  observations, not latency benchmarks.
- The fixture counted exactly three model requests across the transport prompt
  and two driver probes. Duplicate starts did not add requests.

The retained driver probe is run with Bun and an explicitly named, separately
provisioned disposable container. It checks the owner label, absence of mounts,
and disconnected networking before launching the agent. The fixture terminates
after three minutes. Both scripts document this probe, not a CI certification
target or a general installer.

The disposable container and its installed packages were removed after the
probe; the host temporary fixture directory was moved to Trash. The pulled Node
image remains as a reusable local cache. No production service or credentials
were changed.

This demonstrates a real ACP and Codex process against a deterministic model
endpoint, not a live model, native tool/approval coverage, durable process recovery,
session lifecycle certification, Local/Gateway wiring, or descendant cleanup
certification. No runtime registry entry has been promoted.

## Native close follow-up

Cleanup now requires the v1 `sessionCapabilities.close` advertisement, cancels a
running turn and waits for its outcome, then requests `session/close`. Concurrent
cleanup and explicit close calls share one retained operation. New prompts are
fenced once closing begins, late permission requests receive cancelled outcomes,
and terminal output/usage remain available. Unsupported close and missing close
acknowledgement are errors, not successful cleanup. A lost acknowledgement retains
the rejected operation instead of automatically repeating close. Aborting a
cleanup waiter releases that waiter; it does not reverse an already dispatched
native close or prove the session stopped.

The process-backed fixture suite passes 16 tests / 54 assertions, covering
close coalescing, prompt fencing, late permissions, unsupported close, lost close
acknowledgement, and prior creation/cancellation/output cases. Root lint,
type-check, format, build, and test passed; E2E remained 101 / 571.

The retained driver probe was extended to call cleanup twice after completion and
rerun against a fresh isolated container with the same pinned versions and image
described above. Observed result: completed, one output event, usage 11/3,
duplicate handle, and `cleanupConfirmed: true`. The fixture counted one model
request. The native process tree was gone after transport close; only the
container's timer and internal model fixture remained before container removal.
The disposable container and its package installation were removed. This is
native successful-close evidence; crash recovery, lost acknowledgements against
the real agent, and all-platform descendant cleanup remain unverified.

## Complete native inventory mapping

The pinned `CodexAcpClient.listSessions` forwards the native cursor and emits
nullable titles. The driver's list operation expects one complete inventory and
then marks unlisted registered sessions removed. The process transport now
collects native pages before returning any inventory and omits null/empty titles.
It rejects repeated cursors, duplicate session IDs, more than 16 pages, more than
128 sessions, and caller-supplied cursors (which would request a partial inventory).
Transport errors or aborts reject the operation rather than returning accumulated
pages. The existing driver therefore cannot treat the collected first page as a
complete successful listing.

These bounds intentionally fail the inventory operation; they do not silently
truncate it. Pagination and nullable-title coverage uses the disposable protocol
fixture, not a real multi-page Codex history. Native resume/load and preservation
of earlier execution snapshots across reopening still require implementation and
validation. Listing alone is not native lifecycle certification.
The process suite passed 21 tests / 60 assertions; root lint, type-check,
formatting, build, and tests passed, including 101 E2E tests / 571 assertions.

## Native resume follow-up

Resume now supplies the configured absolute cwd and MCP server configuration,
registers discovered native sessions before their early notifications arrive,
and coalesces repeated requests until a successful close ends that attachment.
Running sessions and unconfirmed closes are rejected. A lost resume response
retains uncertainty and fences prompts rather than silently retrying. Cleanup
waits for a pending resume before closing; a successful close permits a new
resume cycle. Existing completed execution snapshots are retained unchanged.
Tracked creation and resumed sessions share the 128-session admission bound.

The focused process suite passed 24 tests / 70 assertions, including discovery,
duplicate resume, close/reopen, lost acknowledgement, and completed-result
preservation. Root lint, type-check, formatting, build, and test passed, including
101 E2E tests / 571 assertions.

The retained driver probe ran in a fresh disposable container with the same
exact versions and isolation controls above. After its single completed prompt,
it closed the session, listed exactly one native session, resumed it, compared
the old driver result for exact equality, and closed it again. It reported
`resumePreservedResult: true`, usage 11/3, and one fixture model request. The
container and installation were removed afterwards. This verifies the pinned
agent's successful resume path, not reconnect/crash recovery, multiple-turn
execution on an existing handle, load/history replay, or live-model behavior.

## Native load/history follow-up

The process transport now implements replay through advertised `session/load`,
using the configured cwd and MCP servers. A separate bounded capture receives
native updates until load acknowledges completion; it does not feed the live
execution output queue or usage accounting. User, assistant, tool, and other
native event types are preserved in `native-acp-update` history entries. The
driver preserves the requested sequence offset for both native and normalized
replay representations.

Replay is reported as partial: successful ACP load does not prove that the agent
emitted every underlying history record. Unsupported load, lost acknowledgements,
and capture-limit violations reject instead of returning a fabricated complete
history. Capture is limited to 4096 updates / 4 MiB. Uncertain load remains fenced;
cleanup waits for load and prevents a new operation from racing that cleanup.
Historical user/tool records do not become assistant output or new usage charges.

The retained real-agent probe loaded seven native history events, including user
and assistant messages, after its one completed prompt and resume. It compared
the prior execution result for exact equality after history replay and closed
the session again. The isolated Responses endpoint still counted exactly one
model request. Versions, image digest, and isolation matched the earlier probes;
the disposable container and its package installation were removed afterwards.
This does not certify all historical content variants, cross-process recovery,
multi-page history stability, or a live model.
The final focused process suite passed 29 tests / 84 assertions. Root lint,
type-check, formatting, build, and test passed, including 101 E2E tests / 571
assertions. An initial redundant-object-spread lint error was corrected before
the successful full validation run.

## Late create identity recovery

The stdio client can retain an opt-in late-result callback after timeout or abort.
It delivers a later successful response once, without changing the original
request's rejected outcome. Callback registrations (pending and timed out) are
bounded to 128 and cleared on response or connection failure. No callback means
the previous discard behavior is unchanged.

The native transport uses this for session creation. A late response restores the
same token's native session identity; early updates remain bounded while that
identity is unresolved. An explicit driver retry rechecks the retained original
token and confirms cleanup before permitting a replacement create. It does not
blindly repeat the old create or dispatch a prompt into the abandoned session.
The driver's uncertain-token tracking is also bounded to 128.

The stdio/driver/process suites passed 70 tests / 348 assertions. Tests cover late
responses after timeout and abort, duplicate late responses, registration bounds,
late native identity recovery, and explicit driver retry with two creates but
only one prompt, with the first session closed before the replacement starts.
The native delay is a subprocess fixture, not a delayed real-agent response.
These mappings are in-memory only: cross-process durable recovery and lost
responses that never arrive remain unresolved and must not be claimed certified.
Root lint, type-check, formatting, build, and test passed. Unit validation passed
872 tests / 3664 assertions, with 87.72% line and 84.70% function coverage.

This implementation is not exported from the package entrypoint or ready for
promotion. Required follow-up includes durable ambiguous-create reconciliation,
retained-result limits, remaining native session lifecycle
operations, and full real-agent validation. Cache/thought usage is retained in
the raw result; final accounting semantics still need explicit verification.

# Real native Local composition probe

On 2026-09-08, the same pinned ACP 1.7.0 / Codex 0.148.0 packages and Node
image described above completed through `createLocalAcpRuntime` owned by
`LocalControlPlaneComposition`. The retained
[Local probe](fixtures/m11-acp-local-probe-2026-09-08.mjs) checks container owner,
no mounts, and disconnected networking. The native harness's own
`DEFAULT_AUTH_REQUEST` selects the credential-free loopback Responses fixture;
the adapter does not add an authentication API or change host authentication.

Observed result: completed; persisted input/output usage 11/3; measured fixture
turn duration 44 ms. A new direct activity instance replayed the SQLite outcome
unchanged. The model fixture reported exactly one request. Native session cleanup
succeeded, and after Local shutdown the container process table contained only
its keepalive and model fixture, with no ACP/Codex process. The disposable container
was stopped and removed; its model fixture was removed with it.

Scope limit: this probe stubs the workflow host and dispatches through the direct
activity port. It does not certify real Restate together with ACP, published-input
acceptance, native tools/MCP, live model quality, approvals, cancellation, host
restart, or full M11.3. Its runtime requirement set is empty and does not claim
filesystem capabilities. The 44 ms observation is not a performance benchmark.

# Real Restate and native ACP acceptance follow-up

The Local probe was extended after `e9f9b2e` to remove the workflow stubs. It now
uses Local's real pinned Restate 1.7.8, stores a compiled fixture ExecutionPlan,
accepts through `executionAcceptanceService`, waits for terminal persistence and
the Restate workflow attach result, and replays the original acceptance request.
It asserts one attempt and the persisted native output/usage.

Two isolated runs completed on 2026-09-08 with the same ACP/Codex/image versions
listed above. The first verified execution persistence (46 ms fixture turn); the
second additionally verified successful workflow completion through attach
(110 ms fixture turn). Each retained 11 input and 3 output tokens. Acceptance
replay retained the original execution and one attempt. The loopback model fixture
count was exactly two across both runs, so neither acceptance replay added a model
request. After each Local shutdown, no ACP/Codex process remained in the container.
The container and model fixture were removed after verification.

This replaces the stub-workflow limitation of the earlier probe, not the remaining
M11 gates. Model responses remain deterministic. The plan is inserted as a fixture,
not published through the full profile/skill/policy/context API flow; only
`stream.output` is required. Native tools/MCP, interactions, cancellation, crash
recovery, live model quality, and other deployment profiles remain unverified by
this probe. Loopback Local Restate uses its existing unsigned handler configuration;
this is not evidence for the signed Hosted boundary.

# Open cancellation responsiveness defect

The real Restate/native ACP probe now accepts a `cancel` argument and a model
fixture started with `M11_HOLD_RESPONSES=1`. It waits until the native model
request exists, signals Restate's `cancelExecution` handler, waits for workflow
completion, and asserts cancellation settles within 5 seconds, well below the
configured 30-second prompt timeout. This is a diagnostic responsiveness gate,
not an approved product-wide latency SLO.

Two runs on 2026-09-08 settled only after the prompt timeout. In the retained
asserting reproduction, the cancellation handler completed at 04:40:00.471 UTC;
the main workflow did not resume until 04:40:30.333 UTC. Final measured cancellation
latency was **29,948 ms**, and the probe exited 1 with
`CANCELLATION_WAITED_FOR_NATIVE_PROMPT_TIMEOUT`. It did converge to `cancelled`,
retained one attempt, replayed acceptance to the same execution, and made only
one new model request. Those properties do not make timely cancellation pass.

The current workflow races its terminal promise against `ctx.run('dispatch', ...)`,
whose Local implementation waits for native progress/terminal status. The evidence
points to this long-lived activity boundary delaying terminal handling; the exact
SDK behavior and corrective design still require investigation. No production
fix is claimed. The probe signals the internal Restate handler, not a public
Control API cancellation route. M11.3/M11 recovery acceptance remains open.

Both runs closed Local resources; the disposable cancellation container and its
model fixture were stopped and removed. No host authentication was used.

# Cancellation transport-mode correction

The installed Restate SDK 1.17.0 defaults HTTP/1.1 to request/response mode and
permits explicit bidirectional streaming. The shared endpoint had forced
request/response for every profile. Local now explicitly enables streaming on its
direct loopback Restate connection; the shared default remains request/response
for Hosted/Cloud callers. Workflow identity and durable activity keys are unchanged.

With this change, the same real Codex ACP cancellation probe passed in **87 ms**
instead of 29,948 ms, with one attempt and no additional model request. The native
process exited on Local shutdown and the disposable container was removed.
An automated real-Restate test holds runtime progress pending until cancellation
and requires workflow completion within 5 seconds. Its ordinary completion lane
also waits for workflow attach before tearing down the server.

This establishes a Local direct-transport correction, not streaming compatibility
through arbitrary proxies or a Hosted/Cloud cancellation certification. The
earlier failing reproduction remains the historical baseline. No public Control
API cancellation operation or native tool/approval certification is added here.

The standalone suite passed 8 tests / 61 assertions after the change, including
graph restart and checkpoint restore. Those deliberate mid-workflow shutdowns
emit the SDK's `Stream is destroyed` error while closing the active streaming
connection; the restarted workflows still complete and satisfy their assertions.
This shutdown diagnostic is retained as a known operational rough edge, not
reported as an error-free restart trace.
