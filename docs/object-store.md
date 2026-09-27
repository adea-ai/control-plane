# ObjectStore adapters

`@control-plane/object-store` is the deployment-neutral boundary for durable object payloads. Domain and public contracts use stable object keys and artifact references; they do not import S3, Cloudflare, filesystem, credential, bucket, or SDK types.

## Cloud

The M9 Cloud implementation is `R2ObjectStore`, configured from the validated managed-cloud object-store values supplied at bootstrap. It uses Cloudflare R2's S3-compatible endpoint with path-style addressing and supports bounded put, get, head, and idempotent delete operations.

Each write stores a SHA-256 integrity marker in private object metadata. Reads and metadata checks require that marker and fail closed on missing or mismatched length/checksum. Keys, content types, metadata, and payload sizes are bounded before provider calls. Provider errors are normalized to stable object-store codes without retaining raw provider messages or credentials.

R2 bucket names, endpoints, access keys, and secret keys remain deployment configuration. They are passed only when constructing the adapter and are never returned by the ObjectStore contract or serialized in diagnostics.

## Hosted and Local

M10 supplies filesystem or user-controlled S3-compatible adapters behind the same contract. Those adapters must pass the shared ObjectStore conformance behavior without changing domain semantics. Local or Hosted data is never uploaded to Cloud R2 implicitly.

The filesystem adapter is POSIX-only and treats its configured root and ancestor directories as an operator-controlled deployment boundary. The root must remain owner-only and must not be renamed or replaced while the service is running. Logical keys are SHA-256-mapped to opaque direct children of that root; the adapter rejects symbolic links and special files and opens final files with no-follow semantics. Callers must never infer or depend on the on-disk filename layout.

The opaque flat layout replaces the nested-key layout shipped during M10 development. An in-place migration and the current profile-portability CLI do **not** migrate those artifact bytes. Before upgrading a persistent M10 filesystem root, quiesce the old runtime and use the programmatic `@control-plane/profile-portability` API with an authoritative artifact-reference inventory: construct the M10 store as `sourceObjectStore`, construct a new empty filesystem root as `destinationObjectStore`, and pass both stores with `copyArtifacts: true` to `planPortableImport` and `applyPortableImport`. Verify `copiedArtifacts`, every size and SHA-256 digest, and the destination checkpoint before switching roots. Keep the source root unchanged for rollback until the new runtime is certified. Do not copy the legacy directory tree directly, because a restored symlink would reintroduce the path-escape condition this layout removes.

## Verification

### Conditional creation

The optional `ObjectStore.putIfAbsent` capability atomically creates a key and
returns either `{ outcome: 'created', object }` or `{ outcome: 'exists' }`.
It must never be emulated with HEAD followed by ordinary PUT. An existing
winner must be read and verified before publishing an artifact reference.

The R2/S3 adapter sends `PutObject` with `If-None-Match: *`. HTTP 412 reports
an existing object; HTTP 409 is an ambiguous, retryable provider failure, not
an existing winner. There is no automatic retry or unconditional fallback,
including when the provider rejects conditional operations. Lost ACK remains
a failure requiring consumer reconciliation. See [R2 S3 compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
and [AWS conditional-write behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html).

The filesystem adapter and Hosted artifact writer have not adopted this
capability yet; their first-write race remains an open M11 gate. Ordinary `put`
and `delete` retain their existing semantics. Conditional creation does not
prevent overwrites by old/unconditional writers, deletion, or unauthorized
clients. Rollout needs namespace ownership and scoped credentials. Generic
S3-compatible providers require operator acceptance of their precondition
behavior; SDK-level tests do not establish live-provider correctness.

Tests cover injected provider outcomes and actual installed-SDK HTTP header
serialization/signing without network calls. They are not live R2 certification
or cross-process filesystem acceptance.

Package tests use an injected S3 client boundary and do not require cloud credentials. M9.6 additionally requires a synthetic write/read/head/delete round trip through `R2ObjectStore` from Railway staging using a bucket-scoped least-privilege credential.
