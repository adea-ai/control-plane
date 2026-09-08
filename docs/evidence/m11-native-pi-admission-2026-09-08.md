# M11 Local native Pi admission identity

The production-used `ManagedPiProcessClient` previously checked its execution map
before awaiting input resolution. Eight simultaneous calls could all enter that
resolver. A regression using a failing resolver reproduced eight calls instead
of one without creating files or starting a child process. Existing-attempt
lookup also returned a handle without comparing the incoming command.

The client now reserves an admission promise by attempt handle before awaiting
resolution. Its canonical fingerprint includes the idempotency key and validated
configuration, not a newly generated timestamp. Matching calls share the original
outcome; changed configuration or command key conflicts. Rejected admissions
remain fenced because failure is not proof that no native effect occurred.

The process-backed Pi RPC fixture exercises eight concurrent client starts,
changed-configuration rejection, and replay through the ordinary adapter, then
verifies output, usage, and restricted invocation flags. The failing-resolver
test verifies one resolution, retained failure on retry, and changed-key
rejection. These tests exercise the native process client with a wire fixture,
not the actual Pi distribution or a live provider.

Admission receipts remain in memory. Client/process restart, explicit uncertain
allocation reconciliation, persistent receipt retention, real tool/approval
support, and native sandbox isolation remain separate acceptance gates. This
change does not enable Pi orchestration or relax disabled native tools/context.

## Published runtime verification

The extended `scripts/certify-m11-managed-pi.mjs` passed against a disposable
installation of published Pi **0.84.2**, Node **24.18.0**, and Bun **1.4.0**.
Eight concurrent calls entered the native process client and returned one handle;
the completed prompt reached the deterministic loopback model endpoint exactly
once. A changed configuration was rejected. Adapter replay, native cancellation,
and the real Local SQLite/Restate composition also passed, with exactly three
model requests across the complete runner and 11/3 input/output tokens on the
completed calls. The global runtime installation was not modified.

The runner emitted `cleanup: completed`. This strengthens the admission evidence
from a wire fixture to the published Pi executable; it does not change the
explicit tool, approval, sandbox, real-provider-quality, or restart limitations.
