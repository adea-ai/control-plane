# M11 trusted provider authoring boundary

This change connects optional provider resolution to ContextPackage authoring. It
does not close Milestone 11 or certify a deployed provider integration.

## Contract

- Only the trusted authoring authority can select a provider request and policy.
  Client context inputs cannot supply that policy, principal, scope, or location.
- The authoring service binds the authenticated principal, workspace, and objective
  to retrieval. No provider request preserves the existing no-provider package.
- Cloud, Local (including embedded Hosted Simple), and Hosted Server compositions
  forward an explicitly configured resolver. No resolver means an empty provider
  registry, not discovery of ambient providers or credentials.
- Successful and omitted resolutions are included in the immutable package digest.
  Included contributions retain their contract, scope, revision, digest, and
  provenance. They do not change canonical ProjectState or widen permissions.
- The authorizing decision must remain unexpired after asynchronous retrieval.
  Required-provider errors are validation rejections, not uncaught internal errors.
- An explicit input-required resolution currently rejects with
  `CONTEXT_PROVIDER_INPUT_REQUIRED`; this is fail-closed behavior, **not** a durable
  input-wait workflow.

## Regression evidence

The initial service test failed because the configured resolver was never called.
The API regression failed because `PROVIDER_UNAVAILABLE` escaped rather than
becoming a validation rejection. Both pass after the changes.

Focused tests cover trusted request binding, rejection of client-supplied provider
policy, absent and disabled provider behavior, preferred omission, required failure,
explicit input-required rejection, authority expiry during retrieval, actual
resolver inclusion with a deterministic provider fixture, preserved ProjectState
and permissions, and forwarding through all three composition roots. The focused
four-file run passed 88 tests with 445 assertions.

Composition forwarding tests use test connections and runtimes. They are not live
PostgreSQL, deployment, or remote RuntimeNode certification. The evidence fixture
is not a production Cortana client.

## Remaining acceptance work

Durable input waiting, production authority/configuration selection, live profile
certification, authoritative cache revision validation, adapter configuration
identity, and the other M11 acceptance gates remain separate work. A passing
authoring test or merged patch does not establish those outcomes.
