# Hosted Server declarative graph tools

Hosted Server can opt into one provider-neutral graph operation: storing a JSON object as an
artifact in the configured ObjectStore. Graph execution remains disabled when the feature selector
is absent or `false`. Enabling it requires a server-owned tool configuration; an API request,
execution plan, or graph definition cannot register a tool, choose a tariff, or replace the pinned
tool version.

## Operator configuration

Set these variables only on the Hosted Server process:

```sh
CONTROL_PLANE_HOSTED_GRAPH_ENABLED=true
CONTROL_PLANE_HOSTED_GRAPH_TOOL_CONFIG=/etc/control-plane/hosted-graph-tool.json
```

The absolute path must refer to a regular, non-symlink JSON file no larger than 16 KiB. The file
contains exactly these fields:

```json
{
  "schemaVersion": 1,
  "toolDefinitionId": "tld_01JHNP2HR7D2QA2R0JP4H8S6XR",
  "toolVersionId": "tlv_01JHNP2HR7D2QA2R0JP4H8S6XT",
  "currency": "USD",
  "costMicrounits": 25,
  "createdAt": "2026-10-03T00:00:00.000Z",
  "publishedAt": "2026-10-03T00:00:00.000Z"
}
```

The IDs and timestamps above are examples; generate unique IDs and set truthful operator timestamps
for each installation. Currency is an uppercase three-letter code and `costMicrounits` is a
positive safe integer. This is an operator-selected internal accounting tariff for one tool call,
not a measurement of object storage or provider costs. The first successful startup pins the exact
tool definition, version digest, operation, tariff, and configuration digest in PostgreSQL. A later
configuration mismatch fails startup closed. Preserve the file and values when restarting or
recovering accepted executions.

The launcher reads and validates this configuration before readiness. Setting the configuration
path while the feature is disabled, enabling the feature without a file, malformed values, or
conflicting launcher and composition configuration all fail closed. Database migrations must be
applied separately with `DATABASE_MIGRATION_URL`; the ordinary application role verifies the
checkpoint schema and performs only authorized DML during startup and execution. See
[`database.md`](database.md) for the migration and role boundary.

## Supported graph and effect

The server accepts a published graph only when its input, state, and output schemas are
`schema:json`, it pins the configured Hosted tool version, and every node uses the allowlisted
`tool/store` operation. The execution plan must carry the matching graph reference, an
`object-store.write` grant, compatible risk and approval policy, budget currency, and deadline.
Each call is authorized again against its accepted plan, command, execution, attempt, published
graph, and current immutable tool registry version.

The tool writes the exact canonical JSON input into the accepted execution's workspace and project
scope. A successful receipt contains the artifact reference, content digest, and byte size. Tool
approval is always required. A Restate resume only wakes the durable operation: the persisted
Interaction state is checked again before the object write. Durable idempotency keys, PostgreSQL
tool receipts, checkpoints, rate-limit events, and usage ledger records constrain replay. An
unconfirmed effect or accounting write becomes `reconciliation_required`; cancellation is not
reported as confirmed while an effect or settlement remains unknown.

This graph path does not provide model execution, arbitrary executables, provider tools, Pi/ACP
native operations, or a general-purpose plugin registry. Other operation kinds remain unsupported
and fail closed. Runtime discovery/admission continues through the normal execution-plan path; this
feature does not bypass runtime-route policy.

## Existing databases and recovery

Apply the repository migrations before enabling the selector. They add checkpoint and graph-tool
configuration, cancellation, and rate-limit persistence; application startup does not create or
alter those tables. Existing graph plans, tool calls, object receipts, and tariff history are not
rewritten to the new binding. Do not change a pinned configuration or replay an execution with an
unknown external effect to force a new write or price. Resolve unconfirmed effects through the
existing reconciliation process before resuming work.

A bounded Docker/PostgreSQL/Restate public-launcher run is recorded in
[`docs/evidence/m11-hosted-server-graph-2026-10-03.md`](evidence/m11-hosted-server-graph-2026-10-03.md);
its fixture and provider limits are part of that evidence.
