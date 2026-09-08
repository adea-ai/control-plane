# Native ACP transport mapping investigation

Base candidate: `b0908948aaf21606fb361ac19dfde3ebe44a4b71` (merged #423).
This is source-backed implementation guidance, not native execution evidence.

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

This implementation is not exported from the package entrypoint or ready for
promotion. Required follow-up includes late/ambiguous create reconciliation, late permission
requests after cancellation, retained-result limits, native session lifecycle
operations, and full real-agent validation. Cache/thought usage is retained in
the raw result; final accounting semantics still need explicit verification.
