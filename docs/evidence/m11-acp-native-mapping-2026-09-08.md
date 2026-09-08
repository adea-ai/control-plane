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

This implementation is not exported from the package entrypoint or ready for
promotion. Required follow-up includes late/ambiguous create reconciliation,
retained-result limits, remaining native session lifecycle
operations, and full real-agent validation. Cache/thought usage is retained in
the raw result; final accounting semantics still need explicit verification.
