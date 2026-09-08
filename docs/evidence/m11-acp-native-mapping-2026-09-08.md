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
