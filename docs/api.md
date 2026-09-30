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

## Graph selection and immutable plans

Execution validation may include `payload.graph` with an exact
`{ graphDefinitionId, graphVersion, contentDigest }` reference and JSON-object
`input`. Validation rejects graph selections unless composition supplies a
workspace-scoped graph authority that checks published lifecycle, compatibility,
registered operations and the declared input schema. The plan digest binds both
reference and input. Inputs are limited to 65,536 serialized UTF-8 bytes, 4,096
values and 16 nested levels; cycles, accessors, sparse arrays, executable values
and non-finite numbers are rejected before persistence.

Exact validation retries preserve the original plan and reject changed inputs.
New execution admission rechecks graph authority; replay checks the original
workspace-scoped immutable pin. Graph declaration does not grant permission to
perform runtime, model, tool or delegation effects. Their execution-time policy,
approval, capability, budget and revocation checks remain required.

Execution acceptance receives the plan reference. Before submitting pending work,
it loads the retained plan and verifies its reference and workspace/project/task/
agent correlation. Workflow graph reference, input and thread identity derive
from that stored plan; caller-supplied graph data cannot replace them. A missing
or mismatched retained plan leaves dispatch unconfirmed for reconciliation.

This contract and admission plumbing are prerequisites for the public graph
execution path. Durable authenticated graph administration, the production
compiler and operation bindings, profile wiring, and deployed acceptance remain
required by M11; this increment does not establish those results.

Graph edges may include `when: { path: ["done"], equals: true }`, which compares
an own JSON field in the source node's result with a bounded scalar. All outgoing
edges from that source must be conditional; every matching target is scheduled,
and no match fails the segment. Routes contain data only, with no executable
predicates or external schema resolution. Start edges are unconditional.

Nodes default to an all-branch join. Feedback edges are identified by traversal
back edges so a fork/join inside a loop still waits for all current branches,
including branches with different lengths. A node may declare `join: "any"` for
mutually exclusive branches. Conditional inputs to a multi-source all-branch
join are rejected because a skipped branch cannot satisfy its barrier. Graphs
can therefore exit loops normally through conditional routes; the host step
limit remains the bound for a cycle that does not exit.

## Graph catalog administration

The versioned graph catalog uses `POST /v1/graphs/publish`, `deprecate`, `revoke`,
and `resolve`. Publication requires `graph:publish`, lifecycle changes require
`graph:manage`, and inspection requires `graph:resolve`, in addition to caller
and workspace credential matching. Definitions belong to the selected workspace;
these envelopes do not accept a project authority field. Publication does not
approve a profile or Skill or authorize execution effects.

Publish payloads contain `definition`; lifecycle payloads contain the exact
`reference`, `expectedRevision`, and a nonempty `reason`. Resolution parameters
contain the exact reference and allow inspection of retained deprecated or
revoked versions. Responses include immutable content and current lifecycle.
Credential-bearing catalog input is rejected before persistence.

Mutations commit the catalog write and an original result receipt atomically.
Receipt identity includes workspace, caller, operation and idempotency key.
A server-computed semantic hash binds operation and payload; changed payloads
under the same key conflict. Retries return the original snapshot even after
later lifecycle changes, with response metadata from the current request.
The Control SDK exposes `publishGraph`, `deprecateGraph`, `revokeGraph`, and
`resolveGraph`. Deployment compositions must bind a durable administration
repository; the unconfigured service returns an explicit unavailable error.
