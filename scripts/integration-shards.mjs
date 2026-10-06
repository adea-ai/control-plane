// Explicit shard assignment for the remote (Neon) integration lane.
//
// The trusted-main Neon verification used to run the whole integration suite
// serially in one job (measured 2,327s of migrations plus test work). Sharding
// at the file level keeps every guarantee that motivated the serialization
// (b5028c10, #146): within a shard, files still run one at a time against
// isolated per-case databases, and each shard provisions its own disposable
// Neon branch so no two shards ever share a compute instance.
//
// Run 37155172856 (2026-10-03) spent 2,339s on 55 of 65 foundation cases before
// shard 1 reached its 45-minute job limit. Recovery and evidence cases share shard 2's
// spare capacity. Complementary name filters keep every case in one slice;
// tests/integration-shards.test.mjs checks actual Bun selection against all
// static case names and bounds both slices. Per-case database isolation,
// serial execution and the existing three branch owners remain unchanged.
// Run 37177353771 (2026-10-04) then spent 2,602s on shard 2's integration step,
// with no retry. Its budget-admission file took 955.20s; shard 1's integration
// step took 763s. Move that complete file to shard 1 rather than adding another
// branch or splitting its cases. See the dated evidence for scope and limits.

const foundationCasesForShard2 =
  'retention|delet|sweep|retired command|retains|frees|pins|usage|evaluation|release decisions|proposal'

export const INTEGRATION_SHARDS = [
  {
    shard: 1,
    groups: [
      {
        package: 'packages/database',
        files: ['src/integration.test.mjs'],
        testNamePattern: `^(?!.*(?:${foundationCasesForShard2})).*$`,
      },
      {
        package: 'packages/database',
        files: ['src/budget-admission.integration.test.mjs'],
      },
    ],
  },
  {
    shard: 2,
    groups: [
      {
        package: 'packages/database',
        files: ['src/integration.test.mjs'],
        testNamePattern: foundationCasesForShard2,
      },
      {
        package: 'packages/database',
        files: [
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
          'src/memory-provenance-retention.integration.test.mjs',
          'src/retention-hold-owner-activation.integration.test.mjs',
          'src/tool-repositories.integration.test.mjs',
          'src/runtime-node-identity-repository.integration.test.mjs',
          'src/delegation-reference.integration.test.mjs',
          'src/admission-rollout-admin.integration.test.mjs',
          'src/graph-definition-repository.integration.test.mjs',
          'src/project-state-initialization.integration.test.mjs',
          'src/hosted-graph-operations.integration.test.mjs',
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
          'src/marketplace-installation.integration.test.mjs',
        ],
      },
      {
        package: '.',
        files: ['./tests/memory-process-loss.integration.test.mjs'],
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

export function integrationFileArguments(group, file, timeoutMs) {
  return [
    'test',
    '--timeout',
    timeoutMs,
    ...(group.testNamePattern === undefined ? [] : ['--test-name-pattern', group.testNamePattern]),
    file,
  ]
}

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
