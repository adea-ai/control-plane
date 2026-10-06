# AgentProfile and Skill versioning

The Control Plane owns executable AgentProfile and Skill configuration. Adea owns the persistent,
user-facing Agent and stores only an explicit `{ profileId, profileVersionId }` pin. Publishing another
version never changes that pin, and Adea does not copy the composed runtime configuration into its
product database.

## Catalog records and ownership

`AgentProfile` and `Skill` are stable catalog records. Their versions carry the executable content.
Ownership is one of system, workspace, organization reference, or private principal reference. These
references scope lookup and authorization without copying Adea membership or permission rules into
the Control Plane.

AgentProfile definitions contain role/persona instructions, exact SkillVersion references and digests,
capability requirements, one immutable provider-neutral `ExecutionConstraintSet`, and output-contract
references. The constraint set covers context, tools, logical models, runtimes, policy snapshots,
interaction, budgets, and execution limits; see [`execution-constraints.md`](execution-constraints.md).
Skill manifests contain a semantic version, content digest, capabilities/tools, profile and public-contract
compatibility, and optional evaluation references. Concrete harness, provider credential, process, and
local-path details do not belong in either model.

## Publication and immutability

Draft content may be replaced only with its current revision. Publication computes and preserves a
SHA-256 digest over canonical key-ordered JSON, increments the revision through repository
compare-and-set, and rejects duplicate profile version numbers or Skill semantic versions. Repository
adapters must enforce those uniqueness rules atomically; the in-memory adapter demonstrates the port
semantics and is intended for tests, not durable deployment.

Published content cannot return to draft or be replaced. Lifecycle transitions create a new revision
that preserves the exact content and digest:

- `published` is available for new exact pins.
- `deprecated` remains resolvable with an explicit remediation signal.
- `superseded` remains resolvable and names the published successor; adoption is still explicit.
- `revoked` remains identifiable for provenance but is blocked for compilation/execution.
- `draft` resolves as unpublished and is never eligible for execution.

Deprecation, revocation, and supersession record timestamps and reasons or successor IDs. A successor
must be published and belong to the same stable profile or Skill.

## Resolution and compatibility

Resolution starts with the profile baseline, adds explicitly authorized task-time Skills, and then
walks declared dependencies. Dependencies use `skillId` plus a SemVer range; the resolver selects the
highest published, approved, non-prerelease version satisfying every accumulated range. It emits a
stable dependency-first order, exact Skill IDs and content digests, and a provenance digest. Cycles,
unsatisfied ranges, revoked required Skills, incompatible versions, and unresolved conflicts fail
closed before execution. Community/public ingestion and signing are unsupported in the MVP.

Constraint layers are composed from platform security through workspace policy, profile hard
constraints/defaults, task/runtime constraints, task Skill augmentation, and harness/project
configuration. Composition is restrictive: lower-precedence input can narrow authority but cannot
broaden tools, models, context, runtime locations, permissions, budgets, or hard instructions.
Resolution always retains the stable record ID plus exact version ID and immutable content digest.
Results are explicit: available, deprecated, superseded, revoked, unpublished, missing, or
incompatible. These checks and the complete resolved manifest are inputs to ExecutionPlan
compilation; the resolver never silently replaces an exact profile pin.

`AgentProfileRepository` and `SkillRepository` are persistence ports. Durable adapters must retain
historical versions, return defensive snapshots, and implement revision compare-and-set plus published
version uniqueness in one transaction. A concurrent publish has exactly one winner; losers receive an
explicit revision or version conflict and must reload before retrying.

## Workspace catalog API

Adea manages workspace-owned Skills and AgentProfiles through the authenticated Control API
(ADR 0013 in Adea; routes and envelopes in [`api.md`](api.md#workspace-catalog-administration)).
Ownership is always `workspace{workspaceId}` for the envelope workspace; the API never creates or
reveals organization or private entries. System entries are listed and readable but never
writable by a workspace. An item owned by another workspace is indistinguishable from a missing
one, for reads and writes alike.

Publication follows the same path as the [operator bootstrap](local-operator-bootstrap.md):
`VersionedCatalog.publishNewSkillVersion` and `publishNewAgentProfileVersion` create a draft and
publish it with one timestamp, so digests, immutability and version-number or semantic-version
uniqueness are identical. The first publish of a new stable ID creates its record (display name
required; Skills receive `workspace-authorized` provenance). Later publishes add immutable
versions; a supplied display name must match the record because records are not renamed.
AgentProfile definitions may pin only `published` Skill versions that are visible to the
workspace (owned or system) and whose content digest matches exactly.

Lifecycle changes reuse the transitions above. A version target names the exact version and its
`expectedRevision`; an item target applies to every eligible version at its current revision, in
creation order: `published` versions for deprecation, `published` or `deprecated` versions for
revocation. Revoked versions keep their content for provenance and remain readable. Drafts are
never exposed.

Every publish or lifecycle command commits its catalog mutation and an original result receipt
atomically (Local and Hosted `simple`: SQLite `workspace-catalog-commands`; Cloud and Hosted
`server`: PostgreSQL `workspace_catalog_commands`, migration `0063`). Commands for one workspace
are serialized, so concurrent publishes of the same version number or semantic version have
exactly one winner. Receipts are idempotency state, not logical catalog state: profile
portability moves the catalog records and versions and omits receipts.
