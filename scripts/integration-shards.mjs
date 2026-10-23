// Explicit shard assignment for the disposable-local-PostgreSQL integration lane.
// The file-level partition preserves the serialization guarantees that
// motivated the original PostgreSQL sharding (b5028c10, #146): each shard runs files
// one at a time and test cases use isolated databases. The historical PostgreSQL
// timing notes below describe earlier remote runs; current trusted-main PostgreSQL
// verification owns only provider compatibility.
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
// Run 37575729589 (2026-10-07) then hit shard 3's 45-minute job limit.
// Shard 2 completed its integration work in 560s; three whole database files
// consumed 1,114.542s on shard 3. Move those files to shard 2's spare capacity,
// keeping every case, per-file serial execution, and the same three owners.
// The interrupted shard's projection is a lower bound; the dated evidence
// does not claim complete-run acceptance or measured monetary savings.
// Run 37684246003 (later 2026-10-07) reached the same limit on shard 1,
// after 37 foundation cases and 23 of 24 budget-admission cases passed.
// Shard 3 completed its integration slice in 601s. Move the complete budget
// file to shard 3; the interrupted file's 1,038.311s span is a lower bound.
// Keep the preceding observations as history, not current-run acceptance.
// Run 38178336814 (2026-10-11, head 7d61c6c) reached shard 2's 45-minute
// limit. Its runner completed the foundation slice and three retention files
// in 2,065.381s, then spent 594.492s in usage-store with 9/12 tests complete.
// The exact same usage-store source in run 38112415657 reached 619.319s with
// 10 tests complete before cancellation. Move usage-store and the two unchanged
// measured retention files to shard 1, and move the unmeasured workspace-scope
// file to shard 3's observed spare capacity. The ownership change itself
// preserves tests, filters, timeout, and branch count. This review candidate
// separately removes automatic per-file reruns. A complete hosted run must
// qualify the new ownership.
// The trusted-main PostgreSQL workflow now runs only a bounded provider-compatibility
// proof. Full integration coverage and the single Hosted Restate qualification
// owner run in pull-request lanes on disposable local PostgreSQL; see the
// current compatibility-budget evidence.

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
        files: [
          'src/migrator-ddl-probe.integration.test.mjs',
          'src/usage-store.integration.test.mjs',
          'src/memory-provenance-retention.integration.test.mjs',
          'src/retention-hold-owner-activation.integration.test.mjs',
        ],
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
          'src/operations-measurements.integration.test.mjs',
          'src/project-state-digest-postgres.integration.test.mjs',
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
          'src/budget-admission.integration.test.mjs',
          'src/child-budget-admission.integration.test.mjs',
          'src/tool-repositories.integration.test.mjs',
          'src/runtime-node-identity-repository.integration.test.mjs',
          'src/runtime-node-credential-binding.integration.test.mjs',
          'src/runtime-node-credential-restricted.integration.test.mjs',
          'src/delegation-reference.integration.test.mjs',
          'src/admission-rollout-admin.integration.test.mjs',
          'src/graph-definition-repository.integration.test.mjs',
          'src/execution-event-repository.integration.test.mjs',
          'src/project-state-initialization.integration.test.mjs',
          'src/workspace-catalog.integration.test.mjs',
          'src/credential-vault-repository.integration.test.mjs',
          'src/model-selection-repository.integration.test.mjs',
          'src/hosted-graph-operations.integration.test.mjs',
          'src/retention-hold-operator.integration.test.mjs',
          'src/retention-hold-repository.integration.test.mjs',
          'src/retention-claim-budget.integration.test.mjs',
          'src/retention-claim-lock-order.integration.test.mjs',
          'src/workspace-execution-scope.integration.test.mjs',
          'src/workspace-execution-scope-version-pairing.integration.test.mjs',
          'src/legacy-drain-fence-repository.integration.test.mjs',
        ],
      },
      { package: 'packages/profile-portability', files: ['src/postgres.integration.test.mjs'] },
      { package: 'packages/testing', files: ['src/postgres.integration.test.mjs'] },
      {
        package: 'packages/langgraph-adapter',
        files: ['src/postgres-checkpointer.integration.test.mjs'],
      },
      {
        package: '.',
        files: [
          './tests/langgraph-retirement-inventory-pg.integration.test.mjs',
          './tests/langgraph-retirement-status-adapter.integration.test.mjs',
        ],
      },
      {
        package: 'apps/workflow-worker',
        files: [
          'src/child-runtime-budget-admission.integration.test.mjs',
          'src/remote-runtime-waiter.integration.test.mjs',
          'src/runtime-budget-admission.integration.test.mjs',
        ],
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
        package: 'apps/runtime-gateway',
        files: ['src/runtime-node-credential-binding.integration.test.mjs'],
      },
      {
        package: '.',
        files: [
          './tests/child-progress-scanner.integration.test.mjs',
          './tests/child-progress-sqlite-feed-replay.integration.test.mjs',
          './tests/memory-process-loss.integration.test.mjs',
          './tests/acp-remote-device-postgres.integration.test.mjs',
          './tests/runtime-node-credential-revocation.integration.test.mjs',
        ],
      },
      {
        package: 'apps/hosted-control-plane',
        files: [
          'src/hosted-graph-cancellation.integration.test.mjs',
          'src/hosted-http.integration.test.mjs',
          'src/reconciliation-metrics.integration.test.mjs',
          'src/reconciliation-projection.integration.test.mjs',
          'src/hosted-graph-legacy-fence.integration.test.mjs',
        ],
      },
    ],
  },
]

// This real Hosted PostgreSQL/Restate scenario needs a live Restate process
// and strict no-skip assertions, so its sole owner is the dedicated local-DB
// qualification step rather than an ordinary shard.
export const DEDICATED_INTEGRATION_QUALIFICATIONS = [
  {
    file: 'packages/database/src/scoped-migrations.integration.test.mjs',
    workflow: '.github/workflows/postgres-pull-request.yml',
    command: 'bun test ./packages/database/src/scoped-migrations.integration.test.mjs',
  },
  {
    file: 'packages/database/src/fresh-schema-bootstrap.integration.test.mjs',
    workflow: '.github/workflows/postgres-pull-request.yml',
    command:
      'bun test --timeout 30000 ./packages/database/src/fresh-schema-bootstrap.integration.test.mjs',
  },
  {
    file: 'apps/hosted-control-plane/src/hosted-graph.integration.test.mjs',
    workflow: '.github/workflows/postgres-pull-request.yml',
    command: 'bash scripts/run-hosted-graph-qualification.sh',
  },
  {
    file: 'packages/database/src/pool-teardown.integration.test.mjs',
    workflow: '.github/workflows/postgres-pull-request.yml',
    command: 'bun test --timeout 30000 ./packages/database/src/pool-teardown.integration.test.mjs',
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
