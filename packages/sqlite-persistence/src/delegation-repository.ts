import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import { ExecutionSchema } from '@control-plane/domain'
import {
  DelegationRecordSchema,
  type DelegationRecord,
  type DelegationRepository,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'
import { assertSqliteStoredPlanReference } from './repositories.js'

const namespace = 'delegations'
const childIndex = 'delegation-by-child'
const mutable = new Set([
  'state',
  'childAttemptId',
  'runtimeConnectionId',
  'retryCount',
  'revision',
  'updatedAt',
  'terminalResultRef',
  'failureCode',
  'terminalPublication',
  'pendingProgress',
  'pendingCancellationAt',
  'pendingDispatch',
])
const immutable = (record: DelegationRecord) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)))

/** Canonical delegation state, including recovery intent, shares the execution store. */
export class SqliteDelegationRepository implements DelegationRepository {
  constructor(readonly provider: PersistenceProvider) {}

  async insert(input: DelegationRecord): Promise<boolean> {
    const record = DelegationRecordSchema.parse(input)
    if (record.revision !== 1) throw new Error('DELEGATION_INITIAL_REVISION_INVALID')
    return this.provider.transaction(async (tx) => {
      const id = recordId(record.delegationId)
      const childId = recordId(record.childExecutionId)
      if ((await tx.get(namespace, id)) || (await tx.get(childIndex, childId))) return false
      await assertReferences(tx, record)
      const parentPlan = await assertSqliteStoredPlanReference(tx, {
        executionPlanId: record.parentExecutionPlanId,
        contentDigest: record.parentExecutionPlanDigest,
      })
      const siblings = (await tx.list(namespace))
        .map((row) => DelegationRecordSchema.parse(row.value))
        .filter((candidate) => candidate.parentExecutionId === record.parentExecutionId)
      if (siblings.length >= parentPlan.constraints.limits.childExecutions.maximumTotal)
        return false
      await tx.put({ namespace, id, value: json(record) })
      await tx.put({
        namespace: childIndex,
        id: childId,
        value: { delegationId: record.delegationId },
      })
      return true
    })
  }

  async get(delegationId: string): Promise<DelegationRecord | undefined> {
    IdentifierSchemas.delegationId.parse(delegationId)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(namespace, recordId(delegationId))
      if (!row) return undefined
      const record = DelegationRecordSchema.parse(row.value)
      if (record.delegationId !== delegationId) throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      return record
    })
  }

  async findByChild(childExecutionId: string): Promise<DelegationRecord | undefined> {
    IdentifierSchemas.executionId.parse(childExecutionId)
    return this.provider.transaction(async (tx) => {
      const index = await tx.get(childIndex, recordId(childExecutionId))
      if (!index) return undefined
      const delegationId = IdentifierSchemas.delegationId.parse(
        (index.value as { delegationId?: unknown }).delegationId
      )
      const row = await tx.get(namespace, recordId(delegationId))
      if (!row) throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      const record = DelegationRecordSchema.parse(row.value)
      if (record.childExecutionId !== childExecutionId || record.delegationId !== delegationId)
        throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      return record
    })
  }

  async listByParent(parentExecutionId: string): Promise<readonly DelegationRecord[]> {
    IdentifierSchemas.executionId.parse(parentExecutionId)
    return this.provider.transaction(async (tx) =>
      (await tx.list(namespace))
        .map((row) => DelegationRecordSchema.parse(row.value))
        .filter((record) => record.parentExecutionId === parentExecutionId)
        .toSorted((left, right) => compareCodePointOrder(left.delegationId, right.delegationId))
    )
  }

  async compareAndSet(expectedRevision: number, input: DelegationRecord): Promise<boolean> {
    const record = DelegationRecordSchema.parse(input)
    if (record.revision !== expectedRevision + 1) return false
    return this.provider.transaction(async (tx) => {
      const id = recordId(record.delegationId)
      const stored = await tx.get(namespace, id)
      if (!stored) return false
      const current = DelegationRecordSchema.parse(stored.value)
      if (
        current.revision !== expectedRevision ||
        canonicalJsonStringify(immutable(current)) !== canonicalJsonStringify(immutable(record))
      )
        return false
      await tx.put({ namespace, id, expectedRevision: stored.revision, value: json(record) })
      return true
    })
  }
}

async function assertReferences(
  tx: PersistenceTransaction,
  record: DelegationRecord
): Promise<void> {
  for (const [executionId, executionPlanId, contentDigest] of [
    [record.parentExecutionId, record.parentExecutionPlanId, record.parentExecutionPlanDigest],
    [record.childExecutionId, record.childExecutionPlanId, record.childExecutionPlanDigest],
  ] as const) {
    const stored = await tx.get('executions', recordId(executionId))
    if (!stored) throw new Error('DELEGATION_REFERENCE_INVALID')
    const execution = ExecutionSchema.parse(stored.value)
    if (executionId === record.parentExecutionId && record.parentAttemptId) {
      const parentAttempt = await tx.get('execution-attempts', recordId(record.parentAttemptId))
      if (
        !parentAttempt ||
        execution.latestAttemptId !== record.parentAttemptId ||
        (parentAttempt.value as { executionId?: unknown }).executionId !== executionId
      )
        throw new Error('DELEGATION_REFERENCE_INVALID')
    }
    if (
      execution.executionPlan.executionPlanId !== executionPlanId ||
      execution.executionPlan.contentDigest !== contentDigest ||
      execution.executionId !== executionId
    )
      throw new Error('DELEGATION_REFERENCE_INVALID')
    const plan = await assertSqliteStoredPlanReference(tx, { executionPlanId, contentDigest })
    if (
      executionId === record.childExecutionId &&
      (execution.parentExecutionId !== record.parentExecutionId ||
        plan.contextPackage.contextPackageId !== record.contextPackageId ||
        plan.contextPackage.contentDigest !== record.contextPackageDigest ||
        plan.parentExecutionPlan?.executionPlanId !== record.parentExecutionPlanId ||
        plan.parentExecutionPlan.contentDigest !== record.parentExecutionPlanDigest)
    )
      throw new Error('DELEGATION_REFERENCE_INVALID')
  }
}
