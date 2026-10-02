# M11 Local graph-tool implementation checkpoint — 2026-10-02

Verified source commit: `c74467d1c11e81a9fdc16414d6fcb6813642d46c`.

This checkpoint advances #188, #187 and #190. It does not close those issues or establish full Milestone 11 acceptance. The architecture inventory and composition digests were refreshed; their acceptance classifications and frozen audit candidate were retained.

## Reachable behavior

The managed Local graph composition can construct its operation port from its own SQLite repositories and ObjectStore. A pinned graph tool node reaches `LocalGraphToolOperations` and the concrete, server-configured `store-json` operation on `local.object-store-json.v1`.

Before delivery, the port verifies the accepted execution/attempt, immutable plan, graph node, published ToolVersion digest, logical version grant, capabilities, risk ceiling, approval policy, deadline and configured tariff. It reserves usage before invoking the executor. Approval is an authenticated persisted interaction; a graph wake-up is insufficient authority. Immutable object writes use a server-derived key and verify content and workspace/execution bindings.

Approval, effect and usage receipts survive reconstruction. Unknown external write receipts, unavailable receipt storage and post-write accounting failures propagate as `reconciliation_required` through the graph adapter, workflow activity, lifecycle and embedded job receipt. The workflow retains evidence and skips terminal cleanup; the completed queue job does not automatically retry the unresolved effect. Cancellation only confirms when effect and accounting state permit it; denied-call cancellation retries finish settlement idempotently.

## Verification

All commands below exited successfully against the source checkpoint. The final commit hook also ran the complete formatting, lint and type-check gates.

| Check                                   | Result                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`         | Passed after current main integration                                                                                                                               |
| `bun run build`                         | 42 workspace builds passed                                                                                                                                          |
| `bun run format:check`                  | Passed                                                                                                                                                              |
| `bun run lint`                          | Passed, including boundaries and canonical ordering                                                                                                                 |
| `bun run type-check`                    | Passed: workspace/OpenAPI, database schema, runtime compatibility, 200 requirements/103 issue audits, 42-package/20-operation/4-profile architecture, Railway types |
| `bun run test`                          | 2,089 unit, 185 E2E and 246 smoke tests passed; 2 PostgreSQL-gated smoke cases skipped                                                                              |
| Unit coverage                           | 81.37% lines; 83.85% functions; required minimum 80%                                                                                                                |
| `bun run security:scan`                 | Passed                                                                                                                                                              |
| `bunx --no-install code-foundry doctor` | Passed                                                                                                                                                              |

Focused tests use actual SQLite and filesystem ObjectStore writes, close/reopen persisted stores, run the compiled authority helper under Node 24 without Bun globals, verify managed graph approval wake-ups, and persist an embedded reconciliation outcome across runtime restart. Fault injection covers lost write receipts, failed receipt transitions/lookups, failed charge/settlement writes, malformed rate-limit records and cancellation settlement retries. Each new regression was observed failing before its correction. Two bounded independent review lanes covered specification and repository standards; their actionable findings were addressed.

## Limits and remaining gates

The tool fixtures use a synthetic always-true plan validator; they establish the effect boundary and supported composition, not public plan-admission acceptance. The Node process test uses repository-produced snapshots to isolate Node compatibility. PostgreSQL integration was not enabled locally; the exact PR head must pass its required GitHub gates, including the PostgreSQL lane, before merge.

This binding supports only the configured Local JSON operation. It does not establish all tool/MCP/model/Sandbox bindings, provider-backed runtime delivery, deployed-profile behavior, operator reconciliation of every ambiguous receipt, Google Drive reconciliation, human approval, or the independent frozen-candidate audit. Those remaining requirements stay open. No production deployment or milestone/issue closure was performed by this checkpoint.
