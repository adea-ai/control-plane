# Isolated sandbox execution

`@control-plane/sandbox` owns the provider-neutral boundary for untrusted code, shell, filesystem,
and ephemeral compute. Domain and runtime callers depend on `SandboxProvider`; the initial
`E2bSandboxAdapter` translates bounded requests through an E2B client port without exposing E2B SDK
types to core packages.

Every sandbox is correlated to a workspace, execution, and attempt and receives an explicit
template, lifetime, CPU, memory, storage, output, and network policy. The create contract defaults to
denied network access and forwards the requested policy to the provider isolation layer. The
coordinator additionally checks standalone HTTP(S) URL arguments against the allowlist and a
metadata-host list; this limited precheck cannot enforce egress for arbitrary commands, bare
addresses, shell text, or other protocols. Provider-level isolation is the required enforcement
boundary. This repository contains an E2B client port and fake-provider tests, but no concrete E2B
client or live egress qualification. Real allowlist/deny-all and metadata isolation remain unverified
under M11 #195, including shell and bare-address attempts. Ordinary environment input cannot contain
credential-shaped fields.
Short-lived credential leases are resolved only inside the adapter immediately before execution and
are not retained in handles, status, errors, or promotion records.

The coordinator normalizes output and errors, bounds combined output, and deterministically destroys
the instance when execution times out, is cancelled, or fails. The reaper destroys expired abandoned
instances idempotently. Sandbox disk is ephemeral: a file becomes persistent only when an authorized
`ArtifactPromoter` accepts its bytes and returns a durable artifact reference.
