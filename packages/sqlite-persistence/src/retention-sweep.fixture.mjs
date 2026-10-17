import { decidedRetentionPolicy, retentionClassPolicy } from '@control-plane/config'
import * as sqlite from './index.js'

/**
 * Every SQLite retention class that has a deletion path, mirroring
 * scripts/retention-classes.mjs (the root receipt-retention test asserts the two
 * agree, since a package cannot import the scripts directory).
 */
export const sqliteRetentionSweeps = {
  'command-inbox': ['SqliteCommandAcceptanceRepository', 'deleteEligibleInbox'],
  'retired-command-keys': ['SqliteCommandAcceptanceRepository', 'deleteEligibleRetiredCommandKeys'],
  'execution-events': ['SqliteExecutionEventRepository', 'deleteEligibleEvents'],
  executions: ['SqliteExecutionRepository', 'deleteEligibleExecutions'],
  'context-packages': ['SqliteContextPackageRepository', 'deleteEligibleContextPackages'],
  'evaluation-runs': ['SqliteEvaluationRepository', 'deleteEligibleEvaluationRuns'],
  'execution-plans': ['SqliteExecutionPlanRepository', 'deleteEligibleExecutionPlans'],
  'interaction-receipts': ['SqliteReceiptRetention', 'sweepEligibleInteractionReceipts'],
  'runtime-ledgers': ['SqliteRuntimeCommandRepository', 'deleteEligibleRuntimeCommands'],
}

/** Applies each class with the decided policy and no holds, as the operator command would. */
export async function sweepSqliteRetention(provider, now) {
  const results = {}
  for (const [classId, [repository, method]] of Object.entries(sqliteRetentionSweeps))
    results[classId] = await new sqlite[repository](provider)[method](now, {
      policyRetainMs: retentionClassPolicy(decidedRetentionPolicy, classId).retainMs,
      dryRun: false,
    })
  return results
}

/** Every retained row of the given namespaces, for before/after comparison. */
export async function snapshotNamespaces(provider, namespaces) {
  return provider.transaction(async (transaction) => {
    const snapshot = {}
    for (const namespace of namespaces)
      snapshot[namespace] = (await transaction.list(namespace)).map((row) => ({
        id: row.id,
        revision: row.revision,
        value: row.value,
      }))
    return snapshot
  })
}
