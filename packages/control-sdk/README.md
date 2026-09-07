# @control-plane/sdk

Typed client for the Control Plane API. Re-exports
[`@adea-ai/contracts`](https://www.npmjs.com/package/@adea-ai/contracts) and
adds the HTTP client, typed Control API operations, and testing helpers so
consumers can integrate without hand-rolling transport or response mapping.

## What's inside

- **Client** — transport and response mapping for the Control API.
- **Operations** — the typed catalog of Control API operations.
- **Testing helpers** (`@adea-ai/sdk/testing`) — deterministic doubles for
  exercising integrations against the contracts.

## Install

```sh
bun add @adea-ai/sdk
```

## Usage

```ts
import { createControlClient } from '@adea-ai/sdk'

// Testing helpers are a separate subpath so production bundles stay lean:
import { createTestControlClient } from '@adea-ai/sdk/testing'
```

The package also ships an OpenAPI baseline under `openapi/` (see the
`openapi:check` / `openapi:generate` scripts in the repository).

## License

Apache-2.0
