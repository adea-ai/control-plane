# Policy decision point

Control Plane authorization uses the provider-neutral `PolicyDecisionPoint` port. Callers submit a
strict principal/action/resource/context request pinned to an immutable policy snapshot and receive
an allow/deny decision with the same policy ID, version, and digest. Domain call sites do not import
Cedar or cloud-provider types.

`CedarPolicyDecisionPoint` is the initial adapter. It translates Control Plane identities and the
privileged runtime, tool, context, model, sandbox, policy, and credential actions into Cedar entity
requests. The evaluator itself is a replaceable port; deterministic CI uses `FakeCedarEvaluator`.
Cedar forbid results take precedence over permits, no matching permit denies, and evaluator errors
deny without exposing policy text or request attributes in the returned decision.

Workspace scope is established before policy evaluation. Principal, resource, and context workspace
IDs must match, and action/resource classes must match. A policy can therefore narrow authority but
cannot widen the caller's Adea workspace scope.

## Policy lifecycle

The policy store publishes immutable, content-digest-verified versions. Operators test a version
through the evaluator before activation. Activation moves the prior active version back to published;
rollback activates an earlier non-revoked version. Revocation is terminal for that version and
immediately makes pinned authorization requests deny. Missing versions, digest mismatches, invalid
activation targets, and policy-evaluator failures fail closed.

Execution plans already pin the resolved policy snapshot. Durable tool calls retain the policy
reference and the exact PDP decision version. `PolicyDecisionPointToolAuthorizer` is the bridge from
the generic PDP into Tool Gateway, so replacing Cedar does not change tool authorization call sites.
