// Explicit shard assignment for the remote (Neon) integration lane.
//
// The trusted-main Neon verification used to run the whole integration suite
// serially in one job (measured 2,327s of migrations plus test work). Sharding
// at the file level keeps every guarantee that motivated the serialization
// (b5028c10, #146): within a shard, files still run one at a time against
// isolated per-case databases, and each shard provisions its own disposable
// Neon branch so no two shards ever share a compute instance.
//
// Assignments come from measured per-file durations (run 36823018055,
// 2026-10-01): packages/database/src/integration.test.mjs alone is 995s, so it
// anchors shard 1 together with the cross-profile conformance matrix and the
// cloud remote drill; the remaining files split into two ~650s shards. When a
// new integration file is added, assign it explicitly below — the partition
// test in tests/integration-shards.test.mjs fails otherwise, which keeps shard
// balance a reviewed decision instead of silent drift.

export const INTEGRATION_SHARDS = [
  {
    shard: 1,
    groups: [{ package: 'packages/database', files: ['src/integration.test.mjs'] }],
  },
  {
    shard: 2,
    groups: [
      {
        package: 'packages/database',
        files: [
          'src/budget-admission.integration.test.mjs',
          'src/retention-reference-windows.integration.test.mjs',
          'src/retention-hold-activation.integration.test.mjs',
          'src/retention-ancestry.integration.test.mjs',
        ],
      },
    ],
  },
  {
    shard: 3,
    groups: [
      {
        package: 'packages/database',
        files: [
          'src/usage-store.integration.test.mjs',
          'src/retention-hold-owner-activation.integration.test.mjs',
          'src/tool-repositories.integration.test.mjs',
          'src/runtime-node-identity-repository.integration.test.mjs',
          'src/delegation-reference.integration.test.mjs',
          'src/admission-rollout-admin.integration.test.mjs',
          'src/graph-definition-repository.integration.test.mjs',
          'src/hosted-graph-operations.integration.test.mjs',
          'src/hosted-graph-cancellation.integration.test.mjs',
          'src/retention-hold-operator.integration.test.mjs',
          'src/retention-hold-repository.integration.test.mjs',
          'src/retention-claim-budget.integration.test.mjs',
          'src/retention-claim-lock-order.integration.test.mjs',
        ],
      },
      { package: 'packages/profile-portability', files: ['src/postgres.integration.test.mjs'] },
      { package: 'packages/testing', files: ['src/postgres.integration.test.mjs'] },
      {
        package: 'packages/langgraph-adapter',
        files: ['src/postgres-checkpointer.integration.test.mjs'],
      },
      {
        package: 'apps/workflow-worker',
        files: ['src/runtime-budget-admission.integration.test.mjs'],
      },
      {
        package: 'apps/control-api',
        files: [
          'src/validation-replay.integration.test.mjs',
          'src/budget-admission.integration.test.mjs',
        ],
      },
      {
        package: 'apps/hosted-control-plane',
        files: [
          'src/hosted-graph-cancellation.integration.test.mjs',
          'src/hosted-graph.integration.test.mjs',
          'src/hosted-http.integration.test.mjs',
          'src/reconciliation-metrics.integration.test.mjs',
          'src/reconciliation-projection.integration.test.mjs',
        ],
      },
    ],
  },
]

export const INTEGRATION_SHARD_IDS = INTEGRATION_SHARDS.map((entry) => entry.shard)

export function parseIntegrationShard(token) {
  if (token === undefined || token === null || token === '') return null
  const value = Number(String(token).trim())
  if (!Number.isInteger(value) || !INTEGRATION_SHARD_IDS.includes(value)) {
    throw new Error(
      `Unknown integration shard ${JSON.stringify(String(token))}; valid shards: ${INTEGRATION_SHARD_IDS.join(', ')}`
    )
  }
  return value
}

export function selectIntegrationShard(shard) {
  const entry = INTEGRATION_SHARDS.find((candidate) => candidate.shard === shard)
  if (!entry) {
    throw new Error(
      `Unknown integration shard ${String(shard)}; valid shards: ${INTEGRATION_SHARD_IDS.join(', ')}`
    )
  }
  return entry.groups
}
