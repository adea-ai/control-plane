# Marketplace registry integration

Control Plane is the server-side authority for the Adea marketplace. It
fetches the registry's stable latest pointer, resolves the digest-derived
immutable release, verifies every published artifact, and returns sanitized
catalog metadata through authenticated API endpoints.

The registry URLs are:

- latest catalog:
  `https://github.com/adea-ai/plugins/releases/latest/download/catalog-latest.v1.json`
- latest integrity manifest:
  `https://github.com/adea-ai/plugins/releases/latest/download/integrity.json`
- immutable catalog release:
  `https://github.com/adea-ai/plugins/releases/download/catalog/<catalogId-suffix>/catalog.v1.json`
- immutable tag: `catalog/<catalogId-suffix>` for `catalog:<64 lowercase hex>`.

The default implementation is server-only. Set `MARKETPLACE_REGISTRY_TOKEN`
only when the registry requires authenticated access. The optional
`MARKETPLACE_REGISTRY_LATEST_URL` and
`MARKETPLACE_REGISTRY_IMMUTABLE_BASE_URL` variables are for controlled registry
endpoints and test environments; production endpoints must use HTTPS. The
immutable base URL is a template ending in `{catalogId}` and must serve the
seven release assets: `catalog.v1.json`, `catalog-latest.v1.json`,
`catalog-summary.v1.json`, `categories.v1.json`, `compatibility.v1.json`,
`integrity.json`, and `sources.lock.json`.

## API boundary

Authenticated Adea service principals use:

- `POST /v1/marketplace/catalog` with `marketplace:read` to retrieve verified
  raw catalog artifacts and the workspace's sanitized installation states;
- `POST /v1/marketplace/install` with `marketplace:install` to submit an
  idempotent request containing `pluginId`, exact `releaseId`, exact
  `canonicalContentDigest`, requested harness, and workspace/user identity.

The envelope's top-level `workspaceId` is the Control Plane service scope used
by authentication. The nested `workspaceIdentity.workspaceId` is Adea's
external workspace identity and is the scope used for installation records.
These identifiers may use different namespaces and must not be compared for
equality by a proxy; the service principal's authority remains the gate for
the top-level Control Plane scope.

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

Execution records also persist the exact marketplace plugin references. Agent
HQ is never given upstream plugin content and never executes it; runtime
execution remains a Control Plane responsibility.

If the registry becomes private, keep GitHub access in this server-side path
using a scoped GitHub App/token. Do not expose a GitHub token or direct release
asset URL to browser or desktop clients.
