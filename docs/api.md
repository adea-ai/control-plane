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

## ProjectState initialization

`POST /v1/project-states/initialize` requires `project-state:initialize`, a required envelope
`projectId` granted to the credential, and a matching caller assertion. It creates the empty
revision-zero ProjectState once per scope, replays the original result for an exact retry, and
returns `409` with `PROJECT_STATE_ALREADY_INITIALIZED` or `PROJECT_STATE_IDEMPOTENCY_CONFLICT`
otherwise. A payload hash that does not match the canonical payload is `400
PROJECT_STATE_PAYLOAD_HASH_MISMATCH`; an unconfigured composition returns `503
PROJECT_STATE_INITIALIZATION_NOT_CONFIGURED`. All four profiles bind it to their ProjectState
repository. See [`project-state.md`](project-state.md#initialization-over-the-control-api).

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

Delegated children retain their parent's policy and resource ceilings, but do not
implicitly inherit its graph program. Control Plane child-plan derivation selects
a child graph explicitly when graph semantics are needed; that pin and input enter
the child plan digest and require the same catalog admission and execution-time
authorization. A child without an explicit selection follows its runtime plan.

The catalog administration and declarative compiler build on this admission
contract. Production runtime/model/tool/delegation bindings, graph activity and
checkpoint wiring, and deployed acceptance remain required by M11. Catalog and
compiler tests do not establish the completed public graph execution path.

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

Local and Simple administration use the profile's SQLite persistence provider.
Hosted Server and Managed Cloud administration use workspace-scoped PostgreSQL
repositories; migration `0056` adds command receipts alongside the immutable
version catalog. Local/Simple restart tests verify both original receipt replay
and independent lifecycle changes for identical pins in different workspaces.
Production graph execution admission stays fail closed until the compiler and
policy-controlled operation bindings are configured.

## Workspace catalog administration

Workspace-owned Skills and AgentProfiles (see
[`profiles-and-skills.md`](profiles-and-skills.md#workspace-catalog-api)) use these `POST` routes.
Every envelope is workspace-scoped and rejects `projectId`; the credential must grant the route's
scope and the envelope workspace. Scopes are explicit and deny by default:

| Route                                                            | Operation                                              | Scope             |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ----------------- |
| `/v1/catalog/skills/list`, `/v1/catalog/profiles/list`           | `catalog.skill.list`, `catalog.profile.list`           | `catalog:read`    |
| `/v1/catalog/skills/get`, `/v1/catalog/profiles/get`             | `catalog.skill.get`, `catalog.profile.get`             | `catalog:read`    |
| `/v1/catalog/skills/publish`, `/v1/catalog/profiles/publish`     | `catalog.skill.publish`, `catalog.profile.publish`     | `catalog:publish` |
| `/v1/catalog/skills/deprecate`, `/v1/catalog/profiles/deprecate` | `catalog.skill.deprecate`, `catalog.profile.deprecate` | `catalog:manage`  |
| `/v1/catalog/skills/revoke`, `/v1/catalog/profiles/revoke`       | `catalog.skill.revoke`, `catalog.profile.revoke`       | `catalog:manage`  |

List parameters accept an opaque `cursor` and `limit` (1-100, default 50); items are owned and
system records in ascending stable-ID order, each with its latest non-draft version summary. Get
parameters take the stable ID and an optional exact version ID; the response carries the record,
every non-draft version summary and the full content of the selected (or latest) version.
Records report `ownership` (`system` or `workspace`) and `readOnly`.

Publish payloads carry the stable ID, a new version ID, an optional display name (required for a
new item), and the executable content as JSON objects: a Skill `manifest` without its digest plus
`content`, or a profile `version` number plus `definition`. The Control Plane validates them
against the versioned catalog schemas; failures return `422 CATALOG_CONTENT_INVALID`, and
unpublished, invisible or digest-mismatched Skill pins return `422 CATALOG_SKILL_PIN_INVALID`.
Lifecycle payloads target either one exact version (`skillId` and `skillVersionId`, or
`profileId` and `profileVersionId`, plus `expectedRevision` and `reason`) or the whole item (the
stable ID and `reason`); they return the changed version summaries.

Invisible items return `404 CATALOG_ITEM_NOT_FOUND`, system items return
`403 CATALOG_ITEM_READ_ONLY` to writes, and immutability or revision conflicts return `409` with
the catalog code. Credential-shaped keys or recognizable secret values in a payload are rejected
with `422 CATALOG_CREDENTIAL_INPUT_REJECTED`; other instruction text is free-form. Receipt
identity is workspace, caller, operation and idempotency key, bound to a server-computed hash of
the payload: an exact retry returns the original result with current response metadata, and a
changed payload under the same key returns `409 CATALOG_COMMAND_CONFLICT`.

Each committed or replayed mutation writes one structured `catalog.<operation>` audit event with
the workspace, principal, request and command IDs, item ID, version IDs, revisions, lifecycle,
digests and a `replayed` flag; instructions and definitions are never logged. The SDK exposes
`listWorkspaceSkills`, `getWorkspaceSkill`, `publishWorkspaceSkill`, `deprecateWorkspaceSkill`,
`revokeWorkspaceSkill` and the matching `...WorkspaceProfile(s)` methods. Cloud, Hosted `server`,
Hosted `simple` and Local compose the service over their catalog persistence; Local and Hosted use
their private API credential, which authorizes a single trusted caller. A deployment without the
service returns `503 WORKSPACE_CATALOG_NOT_CONFIGURED`.

## Workspace connector credentials

ADR 0013 cloud connections store connector secrets in the credential vault under the envelope
workspace. All routes accept versioned envelopes without `projectId`; the workspace is the only
authority scope and must be in the service credential's workspace claims.

| Route                                      | Scope              | Envelope / payload                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/credentials/create`              | `credential:write` | command `credential.create`: `connectorRef`, `provider`, `secret`, optional `expiresAt`                                                                                                                                                                                                                             |
| `POST /v1/credentials/rotate`              | `credential:write` | command `credential.rotate`: `credentialId`, `expectedRevision`, `secret`                                                                                                                                                                                                                                           |
| `POST /v1/credentials/revoke`              | `credential:write` | command `credential.revoke`: `credentialId`                                                                                                                                                                                                                                                                         |
| `POST /v1/credentials/get`                 | `credential:read`  | read `credential.get`: `credentialId`                                                                                                                                                                                                                                                                               |
| `POST /v1/credentials/list`                | `credential:read`  | read `credential.list`: optional `limit` (1–100, default 50), `cursor`                                                                                                                                                                                                                                              |
| `POST /v1/runtime-node-credentials/revoke` | `credential:write` | command `runtime-node-credential.revoke`: `credentialId` (`rgc_` RuntimeNode credential; hosted only, Local refuses with `RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_CONFIGURED`; fails closed with `RUNTIME_NODE_CREDENTIAL_REVOCATION_NOT_PERMITTED` until the application role is granted the revocation write path) |

Responses return `{ credential }` or `{ credentials, nextCursor? }` metadata: `credentialId`,
`workspaceId`, `connectorRef`, `provider`, `status` (`active`, `revoked`, `expired`,
`secret_required`), `revision`, `createdAt`, `createdBy`, and optional `rotatedAt`, `expiresAt`,
`revokedAt`. Response schemas are strict and cannot carry secret material or references.

`secret` is write-only: 8–65,536 characters without control characters, accepted once, encrypted
by the secret provider and never echoed, logged, hashed into receipts or returned. Validation
errors carry issue codes and field paths only. Request logging records method, route, status,
duration and context IDs, never bodies.

Create and rotate are idempotent per workspace, caller, operation and idempotency key. The server
computes the receipt hash over non-secret fields only, so a retry with a different secret returns
the original result and the new secret is discarded unstored; a changed non-secret payload returns
`409 CREDENTIAL_COMMAND_CONFLICT`. Clients should compute the envelope `payloadHash` with the
secret excluded; the server neither verifies nor persists it. Revocation is naturally idempotent.

A credential in another workspace is reported as `404 CREDENTIAL_NOT_FOUND`. Conflicts
(`CREDENTIAL_CONNECTOR_IN_USE`, `CREDENTIAL_REVISION_CONFLICT`, `CREDENTIAL_REVOKED`,
`CREDENTIAL_EXPIRED`) return `409`; an unavailable secret provider returns `503
CREDENTIAL_PROVIDER_UNAVAILABLE`; an unconfigured vault returns `503
CREDENTIAL_VAULT_NOT_CONFIGURED`. The Control SDK exposes `createCredential`, `rotateCredential`,
`revokeCredential`, `getCredential` and `listCredentials`. Leases are not exposed over HTTP.
