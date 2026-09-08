# M11 native ACP cancellation investigation

Status: patched native cancellation verified on macOS ARM64; promotion and broader
milestone acceptance remain incomplete.

The installed ACP certification was extended to use the authenticated Local HTTP
API for completion and cancellation, SQLite, and real Restate. A second execution
holds its fourth model request open. The test loses the first successful
cancellation HTTP acknowledgement, replays the command, checks one attempt, and
requires the provider stream to close before runtime cleanup.

The first apparent pass was invalid: Bun's default ten-second idle timeout closed
the fixture stream. With `idleTimeout: 0`, the gate fails. SSE comment heartbeats
do not change that result. Both the stream cancellation callback and request abort
signal remain false before cleanup. A separate deliberately aborted HTTP client
against the same Bun streaming pattern triggered both signals successfully.

The adapter reports a cancelled turn, but that alone does not prove the provider
connection has closed. No native cancellation claim should be based on the first
run. The completion and loaded-session accounting evidence for PR #434 is separate
and remains valid.

## Source trace

The installed native dependency is Codex 0.148.0. Its source tag
`rust-v0.148.0` resolves to `3ba0f711642a888aec92a611a3f3b2211157ff89`.
ACP calls `turn/interrupt`. In Codex, the core response mapper observes consumer
cancellation, but the API-layer SSE reader is a detached task. Its receive loop
waits on provider events or the idle deadline without selecting on the event
receiver closing. This is consistent with the silent provider stream remaining
open after the turn consumer disappears. A focused upstream regression now proves
that dropping the consumer retains a silent provider byte stream. The unchanged
source failed that test on both attempts allowed by its default local test profile.

Adding a `tokio::select!` branch for `tx_event.closed()` releases the provider
stream when its consumer disappears. With that change, the entire `codex-api`
crate passed 167 tests with retries disabled and zero skips, including the new
regression. This is crate-level evidence, not yet a patched native binary test.
Upstream `just fmt` also passed. The source and regression patch is retained at
`docs/evidence/fixtures/codex-0.148.0-sse-cancellation.patch`; it excludes Cargo's
automatic release-tag workspace-version normalization (0.0.0 to 0.148.0), which
does not change external dependency versions.
The latest stable source inspected, `rust-v0.153.4`, has the same receive-loop
pattern; upgrading alone is not a demonstrated resolution.

## Native binary comparison

The patched macOS ARM64 debug executable built successfully. The explicit
`scripts/certify-m11-codex-cancellation.mjs` probe uses the pinned ACP bundle, a
caller-selected native binary, fresh native state and a held loopback SSE fixture
with server idle timeout disabled. It sends native cancellation, requires the
cancelled prompt result and provider stream closure before process cleanup, and
rejects additional model requests.

The installed published 0.148.0 binary failed that probe. The patched binary passed
with one request and SHA-256
`c2886b87dd7ba53a4ab19e4a11e28c8cda232cb5cf89d01c6bcc01dc00eb0ed0`.
This probe neither modifies nor certifies a Local installation. The hash identifies
this debug build; it is not a portable release artifact or a cross-platform pin.

## Fresh release installation and Local HTTP verification

The new native installer completed a fresh isolated release build using the pinned
source, cancellation patch and compiler/test tools. Its 167 API tests passed with
zero skips and retries disabled. The resulting macOS ARM64 release binary has
SHA-256 `552fc60948ca1d9059213687721098fbc8177d023b559db2ee4566b21d66f135`.

A fresh ACP installation passed 492 upstream tests with 26 explicit skips, then
verified and copied that native binary. The installed-native lane passed all four
model requests: fresh prompt, loaded-session prompt after process restart, Local
HTTP completion and Local HTTP cancellation. The latter used SQLite and real
Restate, replayed a lost cancellation acknowledgement, retained one attempt per
execution, and confirmed provider-stream closure before cleanup with the fixture
idle timeout disabled. An initially unconfirmed cancellation ACK was retried by
Restate until terminal state was observed; it was not treated as completion.

Repository build, type checks, lint, formatting and all 1,266 tests passed (1,065
unit, 127 E2E, 74 smoke). No such patched installation has been promoted yet.
Linux native verification, live-provider billing, in-flight reattachment, native
approval parity and all-profile milestone certification remain unverified.
