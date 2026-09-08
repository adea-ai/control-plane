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
import { ControlPlaneClient } from '@adea-ai/sdk'

// Testing helpers are a separate subpath so production bundles stay lean:
import { createControlPlaneStub } from '@adea-ai/sdk/testing'
```

The package also ships an OpenAPI baseline under `openapi/` (see the
`openapi:check` / `openapi:generate` scripts in the repository).

`client.respondToInteraction(command)` calls `POST /v1/interactions/respond`
with an `interaction.respond` command and requires the `interaction:respond`
credential scope. Preserve the scoped idempotency key and payload when retrying.
The server retains the first response identity; an accepted acknowledgement means
the workflow signal was accepted, not that execution completed. Input values are
limited to 8 KiB of UTF-8 JSON. Profiles without the durable command service return
503; Local wiring is implemented, while native and cross-profile acceptance remain
under verification.

## License

Apache-2.0
