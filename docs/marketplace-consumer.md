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
  raw catalog artifacts and the workspace's sanitized installation states;
- `POST /v1/marketplace/install` with `marketplace:install` to submit an
  idempotent request containing `pluginId`, exact `releaseId`, exact
  `canonicalContentDigest`, requested harness, stable installation instance,
  and workspace/user identity;
- `POST /v1/marketplace/install-plan` with `marketplace:install` to negotiate
  an Agent Plugins `planVersion: 2` proposal for a verified adapter profile.
  The profile is supplied by a tested Control Plane adapter authority, never
  inferred from a harness name or accepted from a browser client.

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
top-level Control Plane scope. The current catalog and install controller
instead requires the top-level and nested workspace IDs to be equal and rejects
a mismatch as `MARKETPLACE_REQUEST_INVALID`. Plan tests accepting separate
namespaces do not establish that catalog and install requests support them.
Consumers must account for this current route difference rather than infer
namespace compatibility from the plan response.

The catalog response contains artifact JSON strings because Adea performs
the same independent verification before rendering. It never contains plugin
source files, upstream archives, credentials, or executable content. The
installation response contains only state and exact pins. Possible states are
`pending-authorization`, `unavailable`, `rejected-by-policy`, `installed`, and
`superseded`.

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
