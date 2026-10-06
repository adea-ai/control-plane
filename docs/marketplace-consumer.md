# Marketplace registry integration

Control Plane is the server-side authority for the Adea marketplace. It
fetches the registry's stable latest pointer, resolves the digest-derived
immutable snapshot, verifies every published artifact, and returns sanitized
catalog metadata through authenticated API endpoints.

The registry URLs are:

- latest catalog pointer:
  `https://raw.githubusercontent.com/adea-ai/plugins/catalog-assets/catalog-latest.v1.json`
- immutable catalog snapshot:
  `https://raw.githubusercontent.com/adea-ai/plugins/catalog-assets/catalogs/<catalogId-suffix>/catalog.v1.json`
- snapshot directory: `catalogs/<catalogId-suffix>` for `catalog:<64 lowercase hex>`.

The snapshot path is derived from the catalog's own digest, so it is immutable
by construction: a build that produced different bytes has a different
`catalogId` and cannot write over an existing path. The pointer is the only
mutable path, and it is byte-identical to the `catalog.v1.json` of the snapshot
it names.

The default implementation is server-only. Set `MARKETPLACE_REGISTRY_TOKEN`
only when the registry requires authenticated access. The optional
`MARKETPLACE_REGISTRY_LATEST_URL` and
`MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL` variables are for controlled registry
endpoints and test environments; production endpoints must use HTTPS. The
immutable base URL is a template containing `{catalogId}` and must serve the
six required snapshot artifacts: `catalog.v1.json`,
`catalog-summary.v1.json`, `categories.v1.json`, `compatibility.v1.json`,
`integrity.json`, and `sources.lock.json`.
Control Plane reuses `catalog-latest.v1.json` from the publication root; it
does not request another copy from the immutable snapshot directory.

Note that the immutable base URL is configured independently of the pointer
URL. It used to be derived by string-slicing the pointer's
`releases/latest/download/catalog-latest.v1.json` path, so the shape of a
mutable URL silently determined where every immutable one lived, and a
deployment serving the pointer from anywhere else produced a base that 404'd.

It may additionally serve `catalog-index.v1.json`, the consumer browsing index
(added in #709). That one artifact is optional, because a snapshot published
before #709 predates it: Control Plane omits it from the response and clients
fall back to rendering from the full catalog. Only a genuine 404 means the
index is absent. A 5xx, timeout, or transport failure fails the refresh, so a
registry outage cannot masquerade as an older snapshot. When the index is
published it is verified in full and its digest must be declared in
`integrity.json` alongside the other artifacts.

## API boundary

Authenticated Adea service principals use:

- `POST /v1/marketplace/catalog` with `marketplace:read` to retrieve verified
  raw catalog artifacts and the workspace's active installation states. The
  optional `parameters.installedBy` narrows them to installations whose
  recorded installer (the install request's `workspaceIdentity.userId`)
  matches; omitted, every active installation in the workspace is returned;
- `POST /v1/marketplace/install` with `marketplace:install` to submit an
  idempotent request containing `pluginId`, exact `releaseId`, exact
  `canonicalContentDigest`, requested harness, stable installation instance,
  and workspace/user identity;
- `POST /v1/marketplace/install-plan` with `marketplace:install` to negotiate
  an Agent Plugins `planVersion: 2` proposal for a verified adapter profile.
  The profile is supplied by a tested Control Plane adapter authority, never
  inferred from a harness name or accepted from a browser client;
- `POST /v1/marketplace/installations/get` with `marketplace:read` to read one
  installation by `parameters.installationId`;
- `POST /v1/marketplace/installations/uninstall` with `marketplace:uninstall`
  to record the terminal uninstall of `payload.installationId`.

## Installation lifecycle

Get and uninstall address an installation only inside the envelope workspace:
the nested `workspaceIdentity.workspaceId` must equal the envelope
`workspaceId`, as for catalog and install, and the lookup is keyed by both
workspace and installation identifier. An unknown identifier and another
workspace's identifier both return 404 `MARKETPLACE_INSTALLATION_NOT_FOUND`, so
workspace B can neither read nor uninstall, nor learn of, an installation of
workspace A.

Both return a purpose-built read model, never the persistence row: exact pins,
`requestedHarness`, `installedBy`/`installedAt`, `updatedAt`, the lifecycle
`state`, and `uninstalledBy`/`uninstalledAt` once uninstalled. Idempotency
keys, request digests and workspace scope are not exposed.

The lifecycle `state` is the recorded install decision
(`pending-authorization`, `unavailable`, `rejected-by-policy`, `installed`,
`superseded`) or the terminal `uninstalled`. Any non-terminal state may be
uninstalled; nothing leaves `uninstalled`. `uninstalled` appears only in the get
and uninstall responses, so the catalog and install closed enums are unchanged.

Uninstall is an idempotent command:

- the first command for an active installation records the actor
  (`workspaceIdentity.userId`), the time and its idempotency key in one
  conditional transition and returns `replayed: false`;
- retrying the same idempotency key and request returns the original result
  with `replayed: true`; reusing the key for a different installation or actor
  is 409 `MARKETPLACE_IDEMPOTENCY_CONFLICT`;
- another command on an already uninstalled installation changes nothing and
  returns the original actor and time with `replayed: true`. Concurrent
  uninstalls record exactly one actor.

An uninstalled installation no longer appears in the catalog's `installations`.
Replaying its original install idempotency key returns 409
`MARKETPLACE_INSTALLATION_UNINSTALLED` instead of the original install decision,
which would report an installation that no longer exists. A reinstall is a new
install request under a new idempotency key and produces a new
`installationId`. Catalog installation entries now carry the optional
`installationId` handle for these operations.

Uninstall is a separate `marketplace:uninstall` scope rather than a reuse of
`marketplace:install`: it is the only marketplace operation that removes a
workspace's capability, and following the graph catalog's split of publish
from lifecycle management, a credential minted to request installs does not
implicitly gain removal authority. An Adea credential that needs both requests
both scopes. Like install, uninstall records state only; it does not delete
materialized plugin files or stop a harness. Every recorded install and
uninstall emits a structured `marketplace.installation.recorded` or
`marketplace.installation.uninstalled` audit event with the workspace,
installation, plugin, release, resulting state and acting user; the uninstall
actor and time are also durable on the installation record.

Installation records are persisted by the managed-cloud PostgreSQL adapter
(migration `0061` adds the uninstall columns). Local and Hosted profiles compose
no marketplace installation authority and fail closed with 503
`MARKETPLACE_INSTALLATION_NOT_CONFIGURED`, so there is no SQLite installation
table to keep in parity; the in-memory repository is the reference used by the
behaviour tests.

Installation plans are advisory: `allowedToActivate` is always `false` and
`approvalRequired` is always `true`. The plan binds the exact source commit,
source digest, canonical package digest, selected strategy, component
selection, `packageKey`, and stable `dataKey`. Materialization must preserve
source modes and activation must recheck provenance, policy, realpath
containment, connector/credential authority, and the live profile.
The current install endpoint verifies the request and records state and exact
pins. It does not copy plugin files into a filesystem or start a harness. An
`installed` record therefore is not evidence of materialization or activation.

The envelope's top-level `workspaceId` is the Control Plane service scope used
by authentication. The nested `workspaceIdentity.workspaceId` is Adea's
external workspace identity and is the scope used for installation records.
These identifiers may use different namespaces and must not be compared for
equality by the advisory plan contract; service authentication gates the
top-level Control Plane scope. The current catalog, install, installation get
and uninstall routes instead require the top-level and nested workspace IDs to be equal and rejects
a mismatch as `MARKETPLACE_REQUEST_INVALID`. Plan tests accepting separate
namespaces do not establish that catalog and install requests support them.
Consumers must account for this current route difference rather than infer
namespace compatibility from the plan response.

The catalog response contains artifact JSON strings because Adea performs
the same independent verification before rendering. It never contains plugin
source files, upstream archives, credentials, or executable content. The
installation response contains only state and exact pins. Possible install
states are `pending-authorization`, `unavailable`, `rejected-by-policy`,
`installed`, and `superseded`; the lifecycle read model adds `uninstalled`.

Control Plane treats these values as opaque contract data and persists them:

| Field                    | Authority                                               |
| ------------------------ | ------------------------------------------------------- |
| `catalogId`              | Exact immutable catalog snapshot.                       |
| `pluginId`               | Source-qualified plugin identity.                       |
| `releaseId`              | Exact immutable plugin release.                         |
| `canonicalContentDigest` | Normalized release-content digest.                      |
| `harnessCompatibility`   | Compatibility evidence, not an execution grant.         |
| `requiredConnectors`     | Connector authority resolution.                         |
| `requiredCredentials`    | Credential authority resolution; no secret values.      |
| `securityClassification` | Workspace/policy decision input.                        |
| `provenance`             | Source repository, path, manifest, and resolved commit. |

For a complete release, installation verification resolves the upstream GitHub
tree/blob server-side, rejects symlinks and unsafe paths, recomputes the
canonical content digest, and compares it with the catalog's exact digest. A
metadata-only or quarantined release is never executable. Revocation,
supersession, workspace policy, harness compatibility, connector availability,
and credential availability are checked before an installed state is recorded.

Execution records also persist the exact marketplace plugin references. Adea
is never given upstream plugin source and does not execute it. Runtime
execution remains a separate Control Plane responsibility.

If the registry becomes private, keep GitHub access in this server-side path
using a scoped GitHub App/token. Do not expose a GitHub token or direct release
asset URL to browser or desktop clients.
