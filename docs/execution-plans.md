# ExecutionPlan compilation

An `ExecutionPlan` is the immutable, content-addressed authority for one logical execution. It freezes
the resolved profile, skills, context, policy, runtime requirements, tool/model constraints,
interaction rules, budgets, sandbox limits, and output contract before dispatch. A running execution
does not follow later catalog, ProjectState, policy, or routing changes.

## Resolved inputs

The compiler records its semantic version and the exact `AgentProfileVersion` ID, profile version and
revision, profile schema and digest; every `SkillVersion` ID, revision, manifest schema, semantic
version, and content digest; and the `ContextPackage` ID, digest, schema, and compiler version. It also
preserves opaque workspace, project, task, Agent, and request correlation IDs without taking
ownership of Adea objects.

Profile, request, and caller constraints are composed fail-closed through the provider-neutral domain
contract. Skill tool/capability requirements, output contracts, context classifications and budgets,
runtime capabilities, and policy snapshots must agree before a plan can be produced. Draft, missing,
deprecated, superseded, revoked, incompatible, and contradictory references are rejected with stable
classifications before runtime dispatch.

## Determinism and persistence

All set-like values and resolved pins are normalized before hashing. Equivalent pinned inputs under
the same compiler version produce the same SHA-256 digest and opaque `pln_` identifier. Compile time
and correlation are intentional inputs: retries reproduce an existing persisted plan by reference
rather than silently recompiling against new state.

`ExecutionPlanRepository` stores immutable plans by `{ executionPlanId, contentDigest }` and verifies
content integrity on every write. Retrieval returns an isolated copy suitable for audit, retry, eval,
and reproduction. The plan contains only normalized references and policy requirements—never raw
provider, connector, runtime-harness, secret-manager, or user credentials.

## Child execution authority

A child plan records its parent plan ID and digest. Its workspace, project, and Agent remain fixed;
task and request correlation may change. Its ContextPackage must be the same package or a valid child
package that names the parent's context ID and digest.

Child constraints must already be equal to their intersection with the parent. This proves they can
narrow, but cannot widen, context classifications, tool operations, model provider classes, runtime
families/locations, interaction authority, budgets, concurrency, child limits, or sandbox resources.
Required parent runtime capabilities cannot be dropped or weakened. A different output contract also
requires a separately authorized plan rather than silent child derivation.
