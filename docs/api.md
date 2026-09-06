# Control API conventions

The Control API uses NestJS for application structure and Fastify as its HTTP adapter. It is a
transport composition root: controllers translate versioned HTTP contracts, services coordinate use
cases, pure domain packages own business rules, and server adapters implement persistence or external
ports.

## Dependency direction

Controllers may import request/response DTOs and application services. They must not import Drizzle,
Postgres.js, database schema modules, or persistence row types. Application services may depend on
stable domain and contract packages plus abstract ports. Concrete database and vendor adapters depend
inward and are wired by modules at the application edge.

Database rows are never response contracts. Public and service responses are purpose-built, versioned,
and independently evolvable.

The canonical Adea service schemas, opaque identifiers, envelopes, compatibility rules, and
fixtures are documented in [`contracts.md`](contracts.md) and exported by `@control-plane/contracts`.
Transport DTOs must implement that boundary rather than inventing database- or runtime-native public
shapes.

## HTTP conventions

Business endpoints use URI versioning under `/v1`. Health endpoints remain unversioned at `/health`
and `/ready`. Fastify assigns or validates an `x-request-id`; an accepted `x-correlation-id` propagates
through response headers, response metadata, and structured request completion logs. IDs are limited
to 128 safe ASCII identifier characters; invalid external values are replaced.

Successful representative responses use:

```json
{
  "data": {},
  "meta": {
    "requestId": "request-id",
    "correlationId": "correlation-id"
  }
}
```

Errors use a stable status-independent envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  },
  "meta": {
    "requestId": "request-id",
    "correlationId": "correlation-id"
  }
}
```

Validation whitelists declared DTO properties and never echoes rejected values. Unknown errors return a
generic message without stack traces. Structured request logs include method, route template, status,
duration, and context IDs; they exclude bodies, authorization headers, cookies, and query values.

## Service authentication boundary

`PolicyServiceAuthenticator` verifies Adea service claims through a replaceable credential
verifier, enforces configured issuer/audience/lifetime/revocation policy, and checks route scopes plus
the workspace/project asserted by the versioned request envelope. `RequireServiceAuthentication`
declares the required operation scopes on a route. The default implementation still fails closed with
`SERVICE_AUTH_NOT_CONFIGURED`; it never implicitly trusts a caller or bearer token. Credential classes,
lifecycle policy, normalized failures, and audit constraints are defined in
[`contracts.md`](contracts.md#service-authentication).

## OpenAPI

Controllers declare OpenAPI metadata through `@nestjs/swagger`. Validate generation without writing a
runtime artifact:

```sh
bun run openapi:check
```

The check requires health, readiness, and the representative `/v1/system/echo` contract. Add domain
contracts only when their owning milestone defines and versions them.

The Adea-facing typed client is published separately as `@control-plane/sdk`. Its generated
OpenAPI boundary and deterministic pre-execution stub are documented in [`sdk.md`](sdk.md). The SDK
does not import this application or any server implementation package.
