# ACP stdio framing boundary — partial M11.3 evidence

`AcpStdioClient` adds a subprocess JSON-RPC boundary with absolute executable and
working-directory paths and an explicitly supplied environment. It does not
inherit the parent's environment or invoke a shell. Callers supply notification
and request handlers and must call `close()` in a `finally` block.
This is not a sandbox: the executable can read files allowed by its operating
system identity. The composition must provide an authorized executable and an
appropriately isolated working directory and configuration.

Requests and responses preserve their IDs. Native errors expose their numeric
code rather than arbitrary diagnostic text. Frames are bounded to 1 MiB and
decoded as strict UTF-8; outstanding outgoing and incoming requests are bounded
to 128 each. Timeouts and aborts remove local waiters; they do not mean a native
ACP operation was cancelled. The session transport must send the protocol's
cancellation notification and reconcile the outcome separately.

Closing rejects local pending work and waits for child stream closure. POSIX
children run in their own process group, which receives termination signals;
cleanup escalates if child closure is not observed within two seconds. Windows
uses direct-child signaling. This is not certification of descendant cleanup or
Windows behavior against a real agent runtime.

The focused process suite passed 11 tests / 30 assertions using disposable Bun
children, covering correlation, native request IDs, environment isolation,
fragmented UTF-8, malformed/oversized/invalid-UTF-8 output, process exit,
outstanding-request limits, timeout, abort, native errors, and missing binaries.
An initial test found duplicate termination during protocol-error cleanup; signal
dispatch is now idempotent. An initial type-check found an optional-field
assignment incompatible with the repository's strict TypeScript configuration;
the field now explicitly includes `undefined`, and package build passed.

A follow-up review added native error responses and stopped buffered-frame
delivery immediately after a handler closes the client. Both regressions failed
before their fixes: unsupported native requests could not receive an error
response, and a second frame in the same output chunk reached the callback after
closure. Tests now verify the original request ID, a usable connection after an
error response, duplicate-response rejection, and no post-close callback.

Parameters are constrained to objects or arrays as required by the
[JSON-RPC specification](https://www.jsonrpc.org/specification#parameter_structures);
a rejected outbound scalar leaves the connection usable. After integrating main
with the v1/permission fixes, root lint, type-check, formatting, build, and tests
passed again after the parameter-shape refinement. That run's unit tests passed 833 tests /
3414 assertions (87.50% line and 84.48% function coverage); E2E passed 101 tests /
571 assertions. Existing lint warnings remain visible.
The complete root sequence also passed after the native-error and post-close
delivery fixes, with E2E unchanged at 101 tests / 571 assertions.

This is not an `AcpTransport` implementation or a native agent certification.
Session creation, streaming update translation, permission normalization, prompt
completion, usage/artifact mapping, restart reconciliation, and Local/Gateway
wiring remain required. No runtime dependency or credentials were installed.
