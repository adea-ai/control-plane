# @control-plane/runtime-gateway-protocol

Versioned wire protocol between the Control Plane and external runtimes
(gateways, adapters, emulators). Pure Zod schemas plus a protocol emulator and
deterministic fixtures — no transport, no credentials, no secrets.

## What's inside

- **Protocol schemas** — manifests, capabilities, deprecation records, and
  envelope schemas for runtime discovery, health, sessions, and routing.
- **Protocol version manifest** — the current and supported
  (`major.minor`) protocol versions with deprecation metadata.
- **Emulator** — an in-memory protocol peer for testing gateways without a
  live runtime.
- **Authentication helpers** — gateway credential schemas and validation.

## Install

```sh
bun add @adea-ai/runtime-gateway-protocol
```

## Subpath exports

| Path                                | Contents                                                   |
| ----------------------------------- | ---------------------------------------------------------- |
| `.`                                 | Protocol schemas, emulator, fixtures, authentication       |
| `./fixtures`                        | Golden and malformed fixture files for conformance testing |
| `./schema/gateway-envelope.v1.json` | JSON Schema for gateway envelopes                          |

## Usage

```ts
import { GatewayProtocolManifest, GatewayEnvelopeSchemas } from '@adea-ai/runtime-gateway-protocol'
```

Protocol compatibility: the package currently speaks protocol `1.x`; see the
`GatewayProtocolManifest` export for the supported version window and
deprecation records.

## License

Apache-2.0
