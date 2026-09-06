# Control Plane public SDK

The public boundary is distributed through versioned contract and SDK packages. It is deployment-neutral: the same semantic API/events must work against the accepted M9 managed-cloud profile and the M10 Local/Hosted compositions.

## Package boundary

- `@control-plane/contracts` contains canonical versioned Zod request/response/event/error schemas, compatibility rules and deterministic fixtures.
- `@control-plane/sdk` depends on the contracts package and provides the typed client, operation registry, generated OpenAPI artifact and deterministic testing harness.

Neither package may export database models/Drizzle schemas, application modules, Restate or historical Temporal workflow types, LangGraph state, runtime adapters/drivers/transports, Railway/Neon/R2 implementation types, provider credentials, or secret-management implementations.

M9.10 #210 froze the v2 public contract. The location vocabulary change is a deliberate major
boundary; M10 transports the same semantic envelopes over Cloud/Hosted/Local profile boundaries
without defining a second API.

## Client boundary

Remote server endpoints use authenticated HTTPS. M10 may additionally expose an approved loopback/IPC/local client boundary, but Local transport does not change operation semantics, schemas, normalized errors, idempotency or compatibility rules.

The client must:

- validate requests and responses at the versioned contract boundary;
- reject incompatible contract majors before unsafe dispatch;
- use stable request/idempotency/correlation identifiers;
- enforce bounded request timeouts for synchronous operations;
- reject unsafe redirects for credential-bearing remote calls;
- avoid retaining/logging bearer credentials or protected payloads;
- expose deployment/runtime metadata only as normalized fields rather than provider-specific internals.

## Current implementation status

The repository contains historical SDK operations and deterministic stubs from earlier milestones. They remain useful independent-build fixtures. M9.10 reconciles those exports with the final v2 Zod/OpenAPI/event/error contracts, and M11 verifies every claimed operation is reachable through supported composition roots.

A stub/fake is never evidence that the concrete Railway, Local or Hosted implementation is production-ready.

## Deterministic contract tests

The SDK testing surface must remain runnable without Adea, Cortana, Railway, Neon, R2, Restate cloud infrastructure, paid model providers, or user credentials. Fixtures validate the same public schemas/compatibility behavior consumed by real deployments.

Cross-repository references are compatibility targets, not ordinary implementation dependencies. Live Adea/Cortana composition occurs only in M12.

## OpenAPI and schema generation

Canonical executable public schemas are Zod definitions in versioned contract packages. JSON Schema/OpenAPI artifacts are generated deterministically and fail CI on drift.

Compatibility rules:

- public API/contracts use explicit major/minor compatibility;
- breaking semantic/schema changes require a new major;
- minor releases are additive/backward-compatible only;
- opaque cursor pagination and normalized error envelopes follow M9.10;
- public schemas cannot expose SQLite/PostgreSQL, Restate, Railway, R2, ACP/Pi implementation objects or other adapter internals.

## Publishing and deprecation

Contract/SDK releases remain independently consumable by third-party/hosted clients. Publishing must preserve Apache-2.0 packaging and cannot require Adea private packages.

Deprecations remain available through their supported major until the documented sunset. Clients with no compatible major fail before dispatch rather than attempting best-effort coercion.

## Deployment portability rule

A change from managed cloud to Local/Hosted may change base URL/IPC transport, availability, latency and deployment metadata. It must not require callers to rewrite Task/Execution/Profile/Skill/ProjectState/ContextProvider semantics. M10 conformance and M11 audit enforce that rule.
