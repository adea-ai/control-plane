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
