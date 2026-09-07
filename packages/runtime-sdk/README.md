# @control-plane/runtime-sdk

SDK for building runtimes that plug into the Control Plane: implement the
adapter interface, declare capabilities, pass conformance, and speak the
gateway protocol — without touching Control Plane internals.

Depends only on [`@adea-ai/contracts`](https://www.npmjs.com/package/@adea-ai/contracts)
and Zod. Pair it with
[`@adea-ai/runtime-gateway-protocol`](https://www.npmjs.com/package/@adea-ai/runtime-gateway-protocol)
for the wire protocol and [`@adea-ai/contracts`](https://www.npmjs.com/package/@adea-ai/contracts)
for the service boundary.

## What's inside

- **Adapter** — the runtime adapter contract and registration types.
- **Capabilities & eligibility** — declare what a runtime supports and let
  the Control Plane route accordingly.
- **Discovery & inventory** — runtime discovery records, health, and
  eligibility evaluation.
- **Conformance & compatibility** — versioned conformance suites and
  compatibility checks for runtime implementations.
- **Sessions & routing** — external session types and routing decisions.
- **Transport** — transport ports with deterministic in-memory doubles
  (`mock.ts`, `fixtures.ts`) for testing adapters without a live gateway.

## Install

```sh
bun add @adea-ai/runtime-sdk
```

## Usage

```ts
import {
  RuntimeAdapterMetadataSchema,
  RuntimeStartRequestSchema,
  RuntimeExecutionResultSchema,
} from '@adea-ai/runtime-sdk'

const metadata = RuntimeAdapterMetadataSchema.parse(raw)
```

Run the compatibility check against your adapter implementation before
registering it (repository development):

```sh
bun scripts/compatibility.mjs --check
```

## License

Apache-2.0
