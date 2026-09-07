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

## Validation-command replay groundwork

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
mask a leaked write. The existing recovery drills do not yet seed validation-command records;
process restart and backup recovery for this record type are not certified by this test.

Profile portability now carries `execution-validation-command` records with their exact plans.
Manifest verification rejects missing plans, forged logical keys, aliases and scope/request/digest
mismatches. Imports preserve SQLite's record-key prefix and insert PostgreSQL plans before commands.
A real SQLite → PostgreSQL → SQLite round trip retains the command and every exported logical ID
and record digest. Older importers may reject this added category; this is not live cutover evidence.

Neither repository is yet wired into execution validation: the API's first-result replay behavior
remains required. The existing reference-only API still recompiles on
each call, so this groundwork does not close M11's validation replay or authoring reachability gate.

## Child execution authority

A child plan records its parent plan ID and digest. Its workspace, project, and Agent remain fixed;
task and request correlation may change. Its ContextPackage must be the same package or a valid child
package that names the parent's context ID and digest.

Child constraints must already be equal to their intersection with the parent. This proves they can
narrow, but cannot widen, context classifications, tool operations, model provider classes, runtime
families/locations, interaction authority, budgets, concurrency, child limits, or sandbox resources.
Required parent runtime capabilities cannot be dropped or weakened. A different output contract also
requires a separately authorized plan rather than silent child derivation.
