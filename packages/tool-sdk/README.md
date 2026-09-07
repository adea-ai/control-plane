# @control-plane/tool-sdk

Tool definition schemas for the Control Plane. Describe what a tool is —
ownership, executor type, risk class, approval mode, idempotency, retry
policy, and limits — so the Control Plane can authorize, rate-limit, and
audit tool executions.

Pure Zod schemas over
[`@adea-ai/contracts`](https://www.npmjs.com/package/@adea-ai/contracts)
identifiers. No transport, no credentials, no execution.

## What's inside

- **Tool definitions** — canonical names, display metadata, ownership
  (system vs workspace scope).
- **Executors** — `internal`, `connector`, `mcp`, and `sandbox` executor
  references, including MCP source discovery metadata with schema digests.
- **Operations** — required capabilities, risk class, approval mode,
  idempotency class, and retry policies.
- **Limits** — input/output byte ceilings, timeouts, and rate limits.
- **Lifecycle** — version lifecycle (`published`, `deprecated`, `revoked`,
  `superseded`) and version schemas.

## Install

```sh
bun add @adea-ai/tool-sdk
```

## Usage

```ts
import { ToolDefinitionSchema, ToolOperationSchema } from '@adea-ai/tool-sdk'

const definition = ToolDefinitionSchema.parse(raw)
```

## License

Apache-2.0
