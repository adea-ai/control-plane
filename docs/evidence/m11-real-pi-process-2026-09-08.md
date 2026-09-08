# M11 real Pi process certification

This release-only command uses the published Pi executable, not the repository's
RPC process fixture. The model endpoint is an isolated, credential-free,
deterministic HTTP fixture bound to an ephemeral loopback port.

```sh
bun scripts/certify-m11-managed-pi.mjs /absolute/path/to/pi
```

Install `@earendil-works/pi-coding-agent@0.84.2` in a disposable directory using
Bun, and pass its `node_modules/.bin/pi` executable. Do not replace the user's
global installation. Node must be available on `PATH`; the command records the
Node subprocess version separately from the Bun runner version. Missing or
different runtime versions fail, rather than skip, this lane.

The command verifies actual Pi RPC startup and capability inspection through
`ManagedPiAdapter` and `DirectLocalRuntimeTransport`, streamed output, final
output and token usage, repeated start returning the same handle without a
second model call, cancellation of an in-flight streaming response, and
ineligibility when approval capability is required. Native tools remain disabled.
Only a fixture API key reaches the loopback endpoint. The Pi process receives an
allowlisted environment and an isolated agent configuration, with no inherited
provider credentials or user configuration. Test-owned processes, model server,
and generated state are cleaned up before a success report is printed.

On 2026-09-08, the published Pi 0.84.2 binary passed with Node 24.18.0 and Bun
1.4.0: one completed model call,
one cancelled call, 11 input tokens and 3 output tokens for the completed call,
and exactly two model requests across duplicate-start and cancellation checks.
The global Pi 0.85.1 installation was not modified.

Negative checks rejected a missing executable and the installed Pi 0.85.1.
Local lint, type checks, formatting, and the complete root test command passed,
including 101 E2E tests with 569 assertions.

This is **not** full M11.3 acceptance. It does not prove real model quality,
approval execution, native tools, durable runtime restart reconciliation, ACP,
or the complete SQLite/Restate Local composition. The explicit limitations remain
`PI_NATIVE_TOOLS_DISABLED`, `PI_AMBIENT_CONTEXT_DISABLED`,
`PI_APPROVAL_INTERACTION_UNSUPPORTED`, and
`PI_INFLIGHT_RESTART_RECONCILIATION_UNSUPPORTED`. The command is an explicit
release lane, not a substitute for the credential-free Local matrix or an
automatically executed CI certification.
