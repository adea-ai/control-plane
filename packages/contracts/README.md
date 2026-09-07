# @control-plane/contracts

The publishable, runtime-independent service boundary between Adea and the
Control Plane. Adea supplies authorized product intent and workspace identity;
the Control Plane applies execution policy and owns runtime semantics.

The package depends only on [Zod](https://zod.dev) and builds without Control
Plane domain, database, application, workflow, or adapter packages.

## What's inside

- **Canonical identifiers** — opaque, prefix-qualified ULIDs (`req_`, `wsp_`,
  `exe_`, …) with validation schemas. Consumers may validate and compare them
  but must not derive database keys, timestamps, routing decisions, or
  vendor-native identifiers from their contents.
- **Control API schemas** — request/response contracts for the Control API.
- **Envelopes** — standardized request/response wrappers with authentication
  and versioning metadata.
- **Pagination, versioning, and memory-writeback contracts.**
- **Fixtures** — deterministic test fixtures for consumers.

## Install

```sh
bun add @adea-ai/contracts
```

## Usage

```ts
import { EnvelopeSchemas, IdentifierSchemas, PaginationSchemas } from '@adea-ai/contracts'
```

See [`docs/contracts.md`](../../docs/contracts.md) in the repository for the
full contract reference, including the identifier prefix table.

## License

Apache-2.0
