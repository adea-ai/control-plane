export const isolationDimensions = [
  'workspace',
  'project',
  'profile',
  'context',
  'runtime',
  'tool',
  'usage',
]

export const isolationOperations = ['read', 'mutate']

export const secretCanarySinks = [
  'logs',
  'traces',
  'events',
  'errors',
  'checkpoints',
  'model_context',
  'public_api',
]

export const secretCanaryEvidence = [
  canary(
    'logs',
    'packages/telemetry/src/index.test.mjs',
    'keeps a secret canary out of structured logs'
  ),
  canary(
    'traces',
    'packages/telemetry/src/index.test.mjs',
    'keeps a secret canary out of LangSmith traces'
  ),
  canary(
    'events',
    'packages/events/src/index.test.mjs',
    'keeps a secret canary out of persisted events'
  ),
  canary(
    'errors',
    'packages/model-gateway/src/index.test.mjs',
    'keeps a secret canary out of normalized provider errors'
  ),
  canary(
    'checkpoints',
    'packages/langgraph-adapter/src/index.test.mjs',
    'keeps a secret canary out of graph checkpoints, operations, and traces'
  ),
  canary(
    'model_context',
    'packages/model-gateway/src/index.test.mjs',
    'keeps a server-side credential canary out of model context'
  ),
  canary(
    'public_api',
    'apps/control-api/src/application.test.mjs',
    'keeps a secret canary out of public API responses and request logs'
  ),
]

export const isolationEvidence = [
  evidence(
    'workspace',
    'read',
    'apps/control-api/src/application.test.mjs',
    'rejects cross-workspace discovery and returns scoped not-found results'
  ),
  evidence(
    'workspace',
    'mutate',
    'packages/policy/src/index.test.mjs',
    'rejects workspace widening before Cedar evaluation'
  ),
  evidence(
    'project',
    'read',
    'packages/domain/src/project-state.test.mjs',
    'fails closed for cross-workspace project reads and mutations without existence leakage'
  ),
  evidence(
    'project',
    'mutate',
    'packages/domain/src/project-state.test.mjs',
    'fails closed for cross-workspace project reads and mutations without existence leakage'
  ),
  evidence(
    'profile',
    'read',
    'tests/m2-core-domain.test.mjs',
    'rejects persisted mutation, SDK drift, and cross-scope retrieval'
  ),
  evidence(
    'profile',
    'mutate',
    'tests/m2-core-domain.test.mjs',
    'classifies catalog lifecycle and compatibility failures without mutating pins'
  ),
  evidence(
    'context',
    'read',
    'packages/context/src/provider.test.mjs',
    'rejects stale, over-budget, and scope-mismatched output and substitutes deterministically'
  ),
  evidence(
    'context',
    'mutate',
    'packages/context/src/index.test.mjs',
    'allows child derivation to narrow but never expand parent authority'
  ),
  evidence(
    'runtime',
    'read',
    'apps/control-api/src/application.test.mjs',
    'rejects cross-workspace discovery and returns scoped not-found results'
  ),
  evidence(
    'runtime',
    'mutate',
    'apps/runtime-gateway/src/runtime-inventory-ingestion.test.mjs',
    'fails closed for wrong scope, version reuse, and normalization correlation'
  ),
  evidence(
    'tool',
    'read',
    'apps/tool-gateway/src/tool-registry.test.mjs',
    'lists, reads, and resolves exact immutable versions within workspace scope'
  ),
  evidence(
    'tool',
    'mutate',
    'apps/tool-gateway/src/tool-registry.test.mjs',
    'executes only registered, granted, schema-valid, bounded operations'
  ),
  evidence(
    'usage',
    'read',
    'packages/usage-ledger/src/index.test.mjs',
    'fails closed for cross-workspace usage reads and mutations without existence leakage'
  ),
  evidence(
    'usage',
    'mutate',
    'packages/usage-ledger/src/index.test.mjs',
    'fails closed for cross-workspace usage reads and mutations without existence leakage'
  ),
]

export const recoveryEvidence = [
  recovery(
    'control_api.before_accept',
    'tests/m9-production-hardening.test.mjs',
    'injects failures at the durable command acceptance boundary and recovers exactly once'
  ),
  recovery(
    'control_api.after_accept',
    'tests/m9-production-hardening.test.mjs',
    'injects failures at the durable command acceptance boundary and recovers exactly once'
  ),
  integration(
    'postgres.transaction_rollback',
    'packages/database/src/integration.test.mjs',
    'commits inbox and outbox writes atomically and rolls them back together'
  ),
  integration(
    'postgres.connection_loss',
    'scripts/run-postgres-disruption-drill.mjs',
    'PostgreSQL connection-loss drill rejected access while the service was unavailable.'
  ),
  integration(
    'postgres.failover',
    'scripts/run-postgres-disruption-drill.mjs',
    'PostgreSQL service-restart drill preserved full observed evaluation receipts, evidence, authoring packages, and exact validation command/plan replay.'
  ),
  integration(
    'postgres.restore',
    'scripts/run-postgres-restore-drill.mjs',
    'PostgreSQL backup and restore drill preserved full evidence and restored application-role reads, immutable replay and new evaluation writes without DDL or role-administration privileges.'
  ),
  recovery(
    'restate.endpoint_crash',
    'apps/workflow-worker/src/execution-workflow.test.mjs',
    'replay after worker restart converges on one attempt and dispatch effect'
  ),
  recovery(
    'restate.endpoint_redeploy',
    'apps/workflow-worker/src/execution-workflow.test.mjs',
    'pins workflow versioning and bounded activity policies'
  ),
  recovery(
    'restate.workflow_replay',
    'apps/workflow-worker/src/execution-workflow.test.mjs',
    'activity retry reuses stable effect keys instead of creating another attempt'
  ),
  recovery(
    'runtime_gateway.instance_loss',
    'apps/runtime-gateway/src/runtime-command-delivery.test.mjs',
    'restarts and redelivers a lost ACK with the same semantic command ID'
  ),
  recovery(
    'runtime_gateway.reconnect_storm',
    'apps/runtime-gateway/src/reconnect-reconciliation.test.mjs',
    'redelivers queued and provably unacknowledged commands after restart'
  ),
  recovery(
    'runtime_node.disconnect',
    'apps/runtime-gateway/src/runtime-command-delivery.test.mjs',
    'uses the RuntimeNode ledger to return the recorded outcome after loss before ACK'
  ),
  recovery(
    'managed_pi.disconnect',
    'packages/managed-pi-adapter/src/gateway.test.mjs',
    'redelivers the same command after reconnect without duplicating execution'
  ),
  recovery(
    'acp.disconnect',
    'packages/acp-adapter/src/gateway.test.mjs',
    'reconnects with duplicate-effect protection and routes approval and cancellation'
  ),
  recovery(
    'provider.outage',
    'packages/model-gateway/src/index.test.mjs',
    'falls back on transient outage only to an allowed healthy compatible route'
  ),
  recovery(
    'provider.partial_response',
    'packages/model-gateway/src/index.test.mjs',
    'classifies a partial provider stream without retrying or hiding emitted output'
  ),
  recovery(
    'event.delivery_outage',
    'packages/events/src/delivery.test.mjs',
    'backs off after an outage and retries the identical event after the due time'
  ),
  recovery(
    'event.dead_letter_replay',
    'packages/events/src/delivery.test.mjs',
    'replays a quarantined retained event with the same identity after remediation'
  ),
  recovery(
    'event.duplicate_or_out_of_order',
    'apps/runtime-gateway/src/runtime-event-ingestion.test.mjs',
    'persists progress once and classifies duplicate, conflicting, and out-of-order frames'
  ),
  recovery(
    'langgraph.worker_interruption',
    'packages/langgraph-adapter/src/index.test.mjs',
    'resumes an interrupt from its exact durable checkpoint after adapter restart'
  ),
  integration(
    'langgraph.checkpoint_interruption',
    'packages/langgraph-adapter/src/postgres-checkpointer.integration.test.mjs',
    'resumes a real interrupted graph after PostgreSQL-backed worker restart'
  ),
  recovery(
    'regional_dependency.degradation',
    'packages/model-gateway/src/index.test.mjs',
    'never admits fallback candidates that violate budget, entitlement, or data policy'
  ),
]

function evidence(dimension, operation, file, testName) {
  return { dimension, operation, file, testName }
}

function recovery(scenario, file, testName) {
  return { scenario, kind: 'test', file, testName }
}

function canary(sink, file, testName) {
  return { sink, file, testName }
}

function integration(scenario, file, evidenceText) {
  return { scenario, kind: 'integration', command: 'bun run test:integration', file, evidenceText }
}
