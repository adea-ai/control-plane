# Artifact storage source extraction

Source: [Artifact Storage Specification](https://docs.google.com/document/d/12cxxFPv9ZI6vHyksczXGOGtuSTvN-MD10nuJTsick7I/edit), fully re-read through Google Drive on 2026-09-07; modified 2026-08-28T07:05:15.684Z. Status: accepted technical specification.

CP-ART-001 through CP-ART-024 extract Control Plane and standalone consumer-boundary
obligations from sections 2–14, 17 and 18. Normative status is accepted; implementation
classification remains `tbd`. Retrieval, extraction and ledger validation do not prove
these behaviors are reachable through any supported deployment composition.

## Ownership boundary

Agent HQ owns workspace-scoped product Artifact metadata, authorization, names,
reference policy and lifecycle. Its upload/finalize/download/promote/delete APIs,
Artifact WorkspaceEvents, asynchronous MalwareScanner lifecycle and initial private
ClamAV service are not authorization to implement duplicate product authority in
Control Plane. Control Plane owns execution objects, bundles and eval data through
its own ObjectStore and emits provenance-bearing candidates for explicit promotion.
The two products must not share bucket authority or reusable credentials.

The 100 MiB ordinary and explicitly enabled 1 GiB multipart bounds govern promoted
Agent HQ product Artifacts. They are not silently applied as universal limits on
every Control Plane-owned internal object. Local/Self-hosted references need not
be uploaded or cloud-scanned merely because a remote client controls execution.
Promotion activates the owning product's verification and scanning lifecycle.

## Verification obligations

Use M11 standalone authorized-product fixtures, not live M12 integration, to prove
Control Plane consumes provenance, permissions, capabilities and lifecycle states
correctly. Check every applicable deployment profile, including no upload by default,
cross-workspace denial, offline/revoked local grants, canonical path containment,
digest changes, unsupported external retrieval, expired capabilities, failed promotion,
and exclusion of unavailable/quarantined content from execution context. Private
cloud storage and preview/production isolation require deployment evidence as well.

The scanner authority must fail closed for unavailable/error/timeout/stale signatures,
malware and unsupported encrypted archives; Control Plane consumer tests must not
self-certify availability or bypass that authority. Actual scanner composition and
blinded product acceptance remain with their owning product and cross-system gates.

## Remaining mapping

Initial current-code inspection identifies these verification entrypoints:

| Boundary                      | Observed implementation                                                                                                                                            | Evidence still required                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local and Hosted Simple bytes | `apps/local-control-plane/src/composition.ts` constructs `FilesystemObjectStore` under its data directory.                                                         | Authorized local-reference resolution and explicit promotion, not merely filesystem placement.                                                      |
| Hosted Server bytes           | `apps/hosted-control-plane/src/composition.ts` uses a filesystem default or an explicitly injected ObjectStore.                                                    | Supported remote identity, grants and Artifact-backed terminal delivery across restart.                                                             |
| Managed-cloud bytes           | `apps/workflow-worker/src/index.ts` constructs its independently configured R2 ObjectStore for `CloudCertificationRuntime`.                                        | Production runtime reachability and live bucket/credential isolation; certification composition is not general execution proof.                     |
| Provider boundary             | `packages/object-store/src/index.ts` owns S3-compatible client construction and opaque object operations.                                                          | Consumer authorization, lifecycle and product migration semantics outside this low-level adapter.                                                   |
| Context admission             | `packages/context/src/index.ts` admits available candidates only after supplied authorization, allowed-ID and sensitivity checks; missing/revoked candidates fail. | Authoritative upstream mapping of product scan/lifecycle state and permissions. Supplied `authorized`/`state` values are not proof of their source. |

These inspected entrypoints are a starting map, not evidence sufficient to upgrade
any CP-ART row from `tbd`.

Follow-up call-site tracing found `ContextPackageCompiler` invoked by its unit
tests, the core-domain acceptance helper and `scripts/certify-m9-cloud.mjs`; no
application composition caller was found. The API exposes scoped resolution of
existing packages, not compilation of arbitrary candidate flags. The architecture
audit records `COMPAT-CONTEXT-COMPILER-REACHABILITY` for the missing production
authoring/authorization evidence. This is not a finding that an unauthenticated
caller can bypass authorization. Determine the intended canonical authoring
boundary before adding a public endpoint or assuming product authorization ownership.

These 24 entries do not claim exhaustive extraction of all Agent HQ implementation
requirements. Exact metadata field mappings, the complete product lifecycle/event
taxonomy, idempotent API contracts, deletion/reference counting and legal holds,
safe download response headers, application encryption classes, and scanner-result
version fields still require owner-specific mapping. Retention windows and scanner
resource thresholds remain explicit implementation choices in section 19; do not
invent approved defaults. The source-reconciliation umbrella remains open.

No cloud permission, deployment, production identity or external product change was
made or authorized by this extraction.
