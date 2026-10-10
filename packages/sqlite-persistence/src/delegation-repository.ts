import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import { createSqliteChildAdmissionReader } from './child-admission-reader.js'
import { ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import { assertExecutionPlanDerivedFrom } from '@control-plane/execution-plan'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  ChildAdmissionAllocationError,
  assertChildAdmissionReceiptMatches,
  DelegationRecordSchema,
  type ChildAdmissionAllocator,
  type DelegationRecord,
  type DelegationRepository,
} from '@control-plane/orchestration'
import { json, recordId } from './record-storage.js'
import { assertSqliteStoredPlanReference } from './repositories.js'
import { SqliteDurableUsageStore } from './usage-store.js'

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
export class SqliteDelegationRepository implements DelegationRepository, ChildAdmissionAllocator {
  constructor(readonly provider: PersistenceProvider) {}

  async allocate(input: Parameters<ChildAdmissionAllocator['allocate']>[0]): Promise<boolean> {
    const execution = ExecutionSchema.parse(input.execution)
    const attempt = ExecutionAttemptSchema.parse(input.attempt)
    const record = DelegationRecordSchema.parse(input.delegation)
    const request = input.request
    assertChildAdmissionReceiptMatches(request, input.receipt, new Date().toISOString())
    if (
      execution.executionId !== request.childExecutionId ||
      execution.latestAttemptId !== request.childAttemptId ||
      execution.attemptCount !== attempt.sequence ||
      attempt.attemptId !== request.childAttemptId ||
      attempt.executionId !== request.childExecutionId ||
      execution.state !== 'queued' ||
      execution.version !== 2 ||
      execution.queuedAt !== request.childDispatch.dispatchedAt ||
      attempt.sequence !== 1 ||
      attempt.state !== 'queued' ||
      attempt.version !== 1 ||
      attempt.queuedAt !== request.childDispatch.dispatchedAt ||
      canonicalJsonStringify(attempt.runtime) !==
        canonicalJsonStringify(request.childDispatch.runtime) ||
      execution.parentExecutionId !== request.parentExecutionId ||
      record.delegationId !== request.delegationId ||
      record.parentExecutionId !== request.parentExecutionId ||
      record.parentAttemptId !== request.parentAttemptId ||
      record.admittedToolCallId !== request.admittedToolCallId ||
      record.childExecutionId !== request.childExecutionId ||
      record.childAttemptId !== undefined ||
      canonicalJsonStringify(record.pendingDispatch) !==
        canonicalJsonStringify(request.childDispatch) ||
      record.inputDigest !== request.childRequestDigest ||
      execution.executionPlan.executionPlanId !== request.childPlan.executionPlanId ||
      execution.executionPlan.contentDigest !== request.childPlan.contentDigest ||
      execution.correlation.workspaceId !== request.workspaceId
    ) {
      throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
    }

    return this.provider.transaction(async (tx) => {
      const delegationId = recordId(record.delegationId)
      const childExecutionId = recordId(record.childExecutionId)
      if (
        (await tx.get(namespace, delegationId)) ||
        (await tx.get(childIndex, childExecutionId)) ||
        (await tx.get('executions', childExecutionId)) ||
        (await tx.get('execution-attempts', recordId(attempt.attemptId)))
      )
        return false

      const parentStored = await tx.get('executions', recordId(request.parentExecutionId))
      const parentParsed = ExecutionSchema.safeParse(parentStored?.value)
      if (
        !parentParsed.success ||
        parentParsed.data.version !== request.parentExecutionVersion ||
        parentParsed.data.latestAttemptId !== request.parentAttemptId ||
        parentParsed.data.correlation.workspaceId !== request.workspaceId ||
        parentParsed.data.executionPlan.executionPlanId !== request.parentPlan.executionPlanId ||
        parentParsed.data.executionPlan.contentDigest !== request.parentPlan.contentDigest ||
        parentParsed.data.executionPlan.schemaVersion !== request.parentPlan.schemaVersion ||
        !['running', 'awaiting_input'].includes(parentParsed.data.state)
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }
      const parentAttempt = await tx.get('execution-attempts', recordId(request.parentAttemptId))
      const parsedParentAttempt = ExecutionAttemptSchema.safeParse(parentAttempt?.value)
      if (
        !parsedParentAttempt.success ||
        parsedParentAttempt.data.executionId !== request.parentExecutionId ||
        parsedParentAttempt.data.attemptId !== request.parentAttemptId ||
        parsedParentAttempt.data.sequence !== parentParsed.data.attemptCount ||
        !['running', 'awaiting_input'].includes(parsedParentAttempt.data.state)
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }

      const parentPlan = await assertSqliteStoredPlanReference(tx, request.parentPlan)
      const childPlan = await assertSqliteStoredPlanReference(tx, request.childPlan)
      const siblings = (await tx.list(namespace))
        .map((row) => DelegationRecordSchema.parse(row.value))
        .filter((candidate) => candidate.parentExecutionId === request.parentExecutionId)
      if (siblings.length >= parentPlan.constraints.limits.childExecutions.maximumTotal) {
        throw new ChildAdmissionAllocationError('DELEGATION_LIMIT_EXCEEDED')
      }
      const activeStates = new Set([
        'requested',
        'dispatched',
        'running',
        'awaiting_input',
        'manual_intervention',
      ])
      if (
        siblings.filter(({ state }) => activeStates.has(state)).length >=
        parentPlan.constraints.limits.concurrency.maximumParallel
      ) {
        throw new ChildAdmissionAllocationError('DELEGATION_CONCURRENCY_LIMIT_EXCEEDED')
      }
      let depth = 0
      let cursor = request.parentExecutionId
      const ancestry = new Set([cursor])
      while (true) {
        const child = await tx.get(childIndex, recordId(cursor))
        if (!child) break
        const ancestorId = IdentifierSchemas.delegationId.parse(
          (child.value as { delegationId?: unknown }).delegationId
        )
        const ancestorRow = await tx.get(namespace, recordId(ancestorId))
        if (!ancestorRow) throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
        const ancestor = DelegationRecordSchema.parse(ancestorRow.value)
        if (ancestry.has(ancestor.parentExecutionId)) {
          throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
        }
        ancestry.add(ancestor.parentExecutionId)
        cursor = ancestor.parentExecutionId
        depth += 1
      }
      if (depth >= parentPlan.constraints.limits.childExecutions.maximumDepth) {
        throw new ChildAdmissionAllocationError('DELEGATION_DEPTH_EXCEEDED')
      }

      // The shared SQLite transaction serializes authority recheck, parent
      // lineage/limit reads, execution creation, budget reservation, and the
      // delegation evidence write. No allocation record survives a denial.
      // Every canonical read in this authority recheck goes through this transaction's reader, which closes
      // when the recheck returns. No read re-enters the provider while the allocation transaction is open.
      const reader = createSqliteChildAdmissionReader(tx, request.workspaceId)
      try {
        await input.assertCurrent(reader)
      } finally {
        reader.close()
      }
      assertChildAdmissionReceiptMatches(request, input.receipt, new Date().toISOString())
      await tx.put({ namespace: 'executions', id: childExecutionId, value: json(execution) })
      await tx.put({
        namespace: 'execution-attempts',
        id: recordId(attempt.attemptId),
        value: json(attempt),
      })
      // Any reference or plan ancestry failure rolls these staged rows back
      // with the transaction before a budget reservation can commit.
      await assertReferences(tx, record)
      await SqliteDurableUsageStore.withTransaction(tx, request.workspaceId, (store) =>
        new DurableUsageLedger({ store, now: () => request.acceptedAt }).openBudget({
          workspaceId: request.workspaceId,
          executionId: execution.executionId,
          parentExecutionId: request.parentExecutionId,
          currency: childPlan.constraints.limits.budget.currency,
          maximumMicrounits: childPlan.constraints.limits.budget.maximumMicrounits,
          maximumTokens: childPlan.constraints.limits.tokens.maximumTotal,
          source: {
            sourceId: `child-budget:${record.delegationId}`,
            idempotencyKey: `child-budget-open:${record.delegationId}`,
          },
        })
      )
      await tx.put({ namespace, id: delegationId, value: json(record) })
      await tx.put({
        namespace: childIndex,
        id: childExecutionId,
        value: { delegationId: record.delegationId },
      })
      return true
    })
  }

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
  const parentPlan = await assertSqliteStoredPlanReference(tx, {
    executionPlanId: record.parentExecutionPlanId,
    contentDigest: record.parentExecutionPlanDigest,
  })
  const childPlan = await assertSqliteStoredPlanReference(tx, {
    executionPlanId: record.childExecutionPlanId,
    contentDigest: record.childExecutionPlanDigest,
  })
  const parentContext = await tx.get(
    'context-packages',
    recordId(parentPlan.contextPackage.contextPackageId)
  )
  const childContext = await tx.get(
    'context-packages',
    recordId(childPlan.contextPackage.contextPackageId)
  )
  if (!parentContext || !childContext) throw new Error('DELEGATION_REFERENCE_INVALID')
  // Digest-valid parent pins alone do not prove narrowed resources/provider composition.
  // Validate the complete canonical ancestry inside the same admission transaction.
  assertExecutionPlanDerivedFrom(parentPlan, childPlan, parentContext.value, childContext.value)
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
