# Tool Gateway contracts

The Tool Gateway is the privileged boundary between runtimes and tool executors. Runtimes receive
canonical, version-pinned tool grants; they do not receive connector, MCP, sandbox, or internal
executor credentials.

## Registry model

- `ToolDefinition` owns the stable public name and workspace/system scope.
- `ToolVersion` pins JSON input/output schemas, operations, capability requirements, risk and
  approval metadata, idempotency support, executor type/reference, and payload/time limits.
- Published semantic versions are immutable. A contract change requires a new `toolVersionId` and
  semantic version.
- Executor references are stable adapter slots. An implementation can be replaced without changing
  the public tool identity or pinned schema.

The registry exposes exact list, read, and resolve operations. Workspace-owned definitions are never
visible outside their workspace; system definitions are visible to all workspaces but still require
an explicit grant before execution.

## Execution boundary

Every invocation carries the exact tool definition/version, workspace, profile, operation, and audit
correlation. The gateway verifies that these fields match the grant before resolving an executor.
It validates and bounds both input and output around the executor call. Unknown versions,
unauthorized operations, missing executors, schema violations, and limit violations fail closed.

Executor adapters implement the provider-neutral `ToolExecutor` port from `@control-plane/tool-sdk`.
Provider credentials and transport configuration remain behind those adapters and are not part of
canonical definitions, runtime requests, or public results.

Every executor receives a required `AbortSignal`. Adapters must propagate it to their underlying
transport and stop work promptly when it is aborted. At the pinned deadline the gateway aborts the
attempt and returns an ambiguous-effect timeout; it does not automatically retry timeout failures,
even when a tool's retry policy lists `TIMEOUT`. A transport that cannot confirm cancellation must
leave the effect for durable reconciliation rather than start an overlapping attempt.

## Durable policy-controlled calls

Privileged execution uses `PolicyControlledToolExecutionService`, which prepares and validates the
canonical request before recording a `ToolCall`. The record stores an input digest rather than raw
input, the exact policy decision/version, approval and executor references, a stable idempotency key,
bounded results or Artifact references, and an append-only status history.

The service follows this order:

1. Validate the exact grant, version, operation, input schema, and input size.
2. Claim the workspace-scoped idempotency key and persist the request digest.
3. Evaluate the provider-neutral policy port; denial or evaluator failure cannot reach an executor.
4. Create or inspect a durable M3 approval interaction when policy/tool risk requires it.
5. Enforce the principal/tool/operation rate window immediately before the effect.
6. Invoke the executor with the pinned timeout and retry only non-timeout errors explicitly
   classified by the tool version when its idempotency model supports retry.
7. Validate and bound output, then persist the result and terminal audit transition.

Concurrent and redelivered requests with the same digest converge on one supported effect. Reusing
an idempotency key with a different request fails closed. An unknown or committed effect that cannot
be safely replayed enters `reconciliation_required` instead of being reported as an ordinary failure.
Executor errors are normalized to bounded codes; raw error messages and raw tool input are not kept
in the durable call record.

## MCP servers

`McpAdapter` discovers a registered server through a provider-neutral client port and imports each
remote tool as a workspace-scoped canonical definition. Every imported version records the source
server, remote tool name/version, schema digest, and discovery time. A changed schema publishes a
new immutable version; an execution already pinned to the previous digest fails closed instead of
silently using the changed remote contract.

Discovery is a bounded provider trust boundary. The adapter rejects catalogs above 256 tools,
responses above the managed-cloud 1 MiB gateway-frame limit, and either input or output schema above
the 256 KiB remote-metadata limit or 32 levels of nesting before it hashes or publishes any tool.
Tool identity and descriptive fields are bounded, and each tool may declare at most 64 unique
capabilities. Every `McpClientPort` must declare and implement raw-frame enforcement; the adapter
passes the 1 MiB ceiling into every discovery call and rejects clients without that guarantee. This
keeps an oversized wire response from being materialized before the parsed catalog is checked.
The complete catalog's schemas are compiled before registry state changes, and the immutable source
digest includes capabilities and read-only status so authority-only drift publishes a new version.

MCP calls use the same policy-controlled Tool Gateway path as every other executor. Disconnects,
removed tools, protocol errors, timeouts, invalid output, and oversized output are exposed as
bounded error codes. The server's vault or lease reference stays inside the adapter and is supplied
only to the server-side MCP client; it is excluded from registry records, runtime requests, durable
tool calls, audit results, and public APIs.

## Vault-leased connector credentials

An `McpServerRegistration` may name a workspace `connectorRef`. The adapter then requires a
`credentialBroker` (`VaultToolCredentialBroker` from `@control-plane/credential-vault`) and, for
every call, obtains a fresh lease for the execution's workspace and that connector through the
`credential:lease` policy decision. The resource reference is `mcp/<serverId>/<toolName>` and the
operation is the canonical tool operation. The secret is passed to `McpClientPort.invoke` as
`credential` only inside the lease callback.

- A request whose workspace differs from the adapter's workspace fails with
  `MCP_CREDENTIAL_SCOPE_MISMATCH` before any lease.
- Missing, revoked, expired, re-entry-pending or policy-denied credentials fail with bounded codes
  (`MCP_CREDENTIAL_MISSING`, `_REVOKED`, `_EXPIRED`, `_POLICY_DENIED`, `_UNAVAILABLE`) and effect
  state `none`; the remote tool is not called.
- Transport errors cross the lease boundary as a bounded code only, because their messages may
  echo the credential. Output that contains the secret, or a sensitive key such as `token`, is
  rejected as `MCP_CREDENTIAL_EGRESS_BLOCKED` with effect state `unknown`.
- Rotation and revocation apply to the next call, since every call takes a new lease.

No deployed composition registers a connector-backed MCP server yet; the path is exercised by the
tool-gateway fixture-connector tests.
