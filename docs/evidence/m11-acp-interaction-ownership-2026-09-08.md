# ACP interaction ownership regression

Scope: M11.5 (#190), approval/input ownership at `AcpDriver`. This is a bounded
finding, not completion of the full security audit.

## Reproduction

Before the fix, `submitApproval` and `submitInput` parsed a supplied execution
handle but dispatched `transport.respond` before validating that handle against
the driver's retained execution. Interaction lookup was global by public ID.
A valid handle from execution B could answer execution A's pending interaction.
A forged handle could dispatch before the later status lookup rejected it.
Two executions emitting the same public interaction ID also overwrote each
other: the collision regression observed native response IDs `[41, 41]` instead
of `[40, 41]`.

These are driver-level reproductions. They do not establish that an unauthenticated
HTTP caller can reach the driver, or substitute for an audit of upstream ingress
authorization. Direct runtime transport forwarding does not itself add ownership
validation, so the driver must enforce this invariant before its response sink.

## Change and controls

Both submission paths now use the existing exact `#execution` handle check before
idempotency lookup or dispatch. Registration and lookup use the execution handle
ID plus public interaction ID. Both IDs have canonical opaque schemas; public
IDs and native permission option IDs are unchanged.

Regression tests in `packages/acp-adapter/src/index.test.mjs` cover wrong-owner
approval/input, forged handles, colliding IDs across executions, legitimate
responses, and successful same-key replay without another response. The three
new regressions failed against the previous implementation and pass after the
change. Package build and the index/gateway/process suites passed: 49 tests /
168 assertions. Root lint, type-check, format, build, and test passed, including
101 E2E tests / 571 assertions.

A fresh read-only investigator confirmed the pre-patch path, and a separate
read-only reviewer found no surviving bypass or regression in the patched
driver boundary. The reviewer also traced Local's persisted execution/attempt
lookup before runtime submission. Neither review substitutes for the full
independent M11.5 threat-model and penetration audit.

The patch does not claim to resolve interaction retention or repeat submission
under distinct idempotency keys, native request-ID reuse, or full lifecycle and
recovery certification. Those need separate bounded validation.
In particular, the gateway's numeric request-ID-to-session map assumes globally
unique pending native request IDs; the reviewer flagged reuse as an unverified
adjacent concern, not a demonstrated bypass through the patched driver.
