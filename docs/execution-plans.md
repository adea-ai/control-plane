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

## Validation-command replay

`ExecutionValidationCommandRepository` defines an atomic first-result command/plan commit.
The key binds authenticated caller principal, workspace, project, `execution.validate` and
idempotency key. Records preserve the original command/request IDs, plan reference and receipt
timestamp. The semantic hash is computed from the parsed contract version and complete validation
payload; a caller-supplied hash, issued timestamp or retry metadata is not its authority.

`SqliteExecutionValidationCommandRepository` stores the pair in one transaction. Same-key,
same-hash commits return the first record without persisting a losing plan; changed hashes conflict.
Reads verify scope and referenced plan integrity, including original request correlation. Records
currently have no deletion path and are retained indefinitely; retention cleanup policy is not
implemented here.

The file-backed test covers concurrent distinct candidates, rollback after an injected command-write
failure, full close/reopen, caller isolation, changed-input rejection and stored-scope corruption.
These are same-provider SQLite tests, not multi-process certification.

`PostgresExecutionValidationCommandRepository` implements the same atomic pair through a
transaction-scoped advisory lock and the `execution_validation_commands` table (migration 0033).
The PostgreSQL integration test exercises eight competing commits through four connections,
injected rollback, repository reconstruction, caller isolation and corrupted scope/request/digest
metadata. Its candidates are asserted absent before rollback, so earlier shared-suite fixtures cannot
mask a leaked write. The PostgreSQL service-restart drill additionally verifies the exact stored
command/plan pair and retries the repository commit after restart. The backup-restore drill checks
both restored objects and their integrity through an administrator connection. Since that restore
excludes ownership and privileges, it proves data recovery, not restored application permissions or
API replay readiness. A live cloud/Hosted Server API restart matrix remains required.

Profile portability now carries `execution-validation-command` records with their exact plans.
Manifest verification rejects missing plans, forged logical keys, aliases and scope/request/digest
mismatches. Imports preserve SQLite's record-key prefix and insert PostgreSQL plans before commands.
A real SQLite → PostgreSQL → SQLite round trip retains the command and every exported logical ID
and record digest. Older importers may reject this added category; this is not live cutover evidence.

The validation service now uses this repository in the cloud, Hosted Server and shared
Local/Hosted Simple compositions. It checks the authenticated caller before looking up a record.
Identical semantic inputs replay the stored plan without reading profile, state, context or Skill
inputs and without invoking the compilation clock. A changed payload under the same key returns
409, even if the caller reuses its declared payload hash. First validation uses a composition-owned
clock rather than `issuedAt`, and commits the plan and result atomically before returning success.
Concurrent first calls may compile candidates, but only the winning pair persists.

Response correlation identifies the current request while the stored plan retains its original request
correlation. Replay reports a historical validation result; it is not fresh authorization to execute
under a revoked policy or Artifact grant. Execution-time authorization remains a separate gate.
Calls predating validation-command recording have no recorded validation-command entry; this change
does not backfill them, and outstanding pre-upgrade retries require rollout consideration.

The Local composition test proves concurrent service calls and replay after a real SQLite close/reopen
with compilation inputs and the clock unavailable. The HTTP test proves missing-credential rejection,
stable replay and conflict status. PostgreSQL repository semantics are integration-tested separately;
a live cloud/Hosted Server API restart matrix is still required. Inline context inputs remain disabled,
and this does not close the production context-authoring reachability gate.

## Child execution authority

A child plan records its parent plan ID and digest. Its workspace, project, and Agent remain fixed;
task and request correlation may change. Its ContextPackage must be the same package or a valid child
package that names the parent's context ID and digest.

Child constraints must already be equal to their intersection with the parent. This proves they can
narrow, but cannot widen, context classifications, tool operations, model provider classes, runtime
families/locations, interaction authority, budgets, concurrency, child limits, or sandbox resources.
Required parent runtime capabilities cannot be dropped or weakened. A different output contract also
requires a separately authorized plan rather than silent child derivation.
