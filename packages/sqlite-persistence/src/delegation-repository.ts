import { withPersistenceReadScope } from '@control-plane/deployment/read-scope'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import type { PersistenceProvider, PersistenceTransaction } from '@control-plane/deployment'
import { RuntimeStartRequestSchema } from '@control-plane/runtime-sdk'
import { createSqliteChildAdmissionReader } from './child-admission-reader.js'
import { ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import { assertExecutionPlanDerivedFrom } from '@control-plane/execution-plan'
import { childAllowanceStatementOf, DurableUsageLedger } from '@control-plane/usage-ledger'
import {
  ChildAdmissionAllocationError,
  ChildAdmissionReceiptSchema,
  ChildAdmissionRequestSchema,
  assertChildAdmissionReceiptMatches,
  DelegationRecordSchema,
  recoverDelegationInteractionPublications,
  type ChildAdmissionAllocator,
  type DelegationRecord,
  type DelegationRepository,
  type DelegationEventPublisher,
  type ChildRuntimeLookupSnapshot,
  type ChildRuntimeLookupReceipt,
  type ChildAdmissionReader,
  type RecoveredChildSessionMapping,
} from '@control-plane/orchestration'
import {
  readChildRuntimeContext,
  childRuntimeLookupNamespace,
} from './delegation-runtime-receipt.js'
import { retainReceiptOwnerPins } from './delegation-retention.js'
import { json, recordId } from './record-storage.js'
import { assertSqliteStoredPlanReference } from './repositories.js'
import { SqliteDurableUsageStore } from './usage-store.js'
import {
  ChildJobMappingSchema,
  childAdmissionNamespace,
  childMappingNamespace,
  childSessionNamespace,
  retainChildAdmission,
  retainChildMapping,
  type ChildJobMapping,
  type StoredChildAdmissionReceipt,
} from './delegation-child-mapping.js'
import {
  retainTerminalReceipt,
  terminalReceipt,
  terminalReceiptNamespace,
  type DelegationTerminalReceipt,
} from './delegation-terminal-receipt.js'

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
  'terminalConclusion',
  'failureCode',
  'terminalPublication',
  'pendingProgress',
  'interactionPublications',
  'pendingCancellationAt',
  'pendingDispatch',
])
const immutable = (record: DelegationRecord) =>
  Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)))

/** Canonical delegation state, including recovery intent, shares the execution store. */
export class SqliteDelegationRepository implements DelegationRepository, ChildAdmissionAllocator {
  constructor(readonly provider: PersistenceProvider) {}

  async retainChildRuntimeStart(input: {
    delegationId: string
    request: ChildRuntimeLookupReceipt['request']
  }): Promise<void> {
    IdentifierSchemas.delegationId.parse(input.delegationId)
    const request = RuntimeStartRequestSchema.parse(input.request)
    await this.provider.transaction(async (tx) => {
      const snapshot = await readChildRuntimeContext(tx, input.delegationId, request)
      const id = recordId(snapshot.receipt.childAttemptId)
      if (!(await tx.get(childRuntimeLookupNamespace, id))) {
        await tx.put({ namespace: childRuntimeLookupNamespace, id, value: json(snapshot.receipt) })
        await retainReceiptOwnerPins(tx, childRuntimeLookupNamespace, snapshot.receipt)
      }
    })
  }

  async getChildRuntimeStart(delegationId: string): Promise<ChildRuntimeLookupSnapshot> {
    IdentifierSchemas.delegationId.parse(delegationId)
    return this.provider.transaction((tx) => readChildRuntimeContext(tx, delegationId))
  }

  async bindRecoveredChildSession(input: {
    snapshot: ChildRuntimeLookupSnapshot
    externalSessionId: string
    assertCurrent: (reader: ChildAdmissionReader) => Promise<void>
  }): Promise<RecoveredChildSessionMapping> {
    const externalSessionId = IdentifierSchemas.externalSessionId.parse(input.externalSessionId)
    return this.provider.transaction(async (tx) => {
      const snapshot = await readChildRuntimeContext(tx, input.snapshot.receipt.delegationId)
      if (
        snapshot.fence !== input.snapshot.fence ||
        canonicalJsonStringify(snapshot.receipt) !== canonicalJsonStringify(input.snapshot.receipt)
      )
        throw new Error('CHILD_RUNTIME_LOOKUP_STALE')
      const reader = createSqliteChildAdmissionReader(tx, snapshot.receipt.workspaceId)
      try {
        await withPersistenceReadScope(this.provider, tx, () => input.assertCurrent(reader))
      } finally {
        reader.close()
      }
      // The port may await; canonical tuple must still match in this locked transaction.
      const final = await readChildRuntimeContext(tx, snapshot.receipt.delegationId)
      if (final.fence !== snapshot.fence) throw new Error('CHILD_RUNTIME_LOOKUP_STALE')
      const r = snapshot.receipt
      const attempt = ExecutionAttemptSchema.parse(
        (await tx.get('execution-attempts', recordId(r.childAttemptId)))?.value
      )
      if (
        attempt.runtime?.externalSessionId !== undefined &&
        attempt.runtime.externalSessionId !== externalSessionId
      )
        throw new Error('DELEGATION_CHILD_MAPPING_STALE')
      const mapping = {
        workspaceId: r.workspaceId,
        parentExecutionId: r.parentExecutionId,
        delegationId: r.delegationId,
        childExecutionId: r.childExecutionId,
        childAttemptId: r.childAttemptId,
        runtimeConnectionId: r.runtimeConnectionId,
        externalSessionId,
      }
      await retainChildMapping(tx, mapping)
      return mapping
    })
  }

  async getTerminalReceipt(delegationId: string): Promise<DelegationTerminalReceipt | undefined> {
    IdentifierSchemas.delegationId.parse(delegationId)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(terminalReceiptNamespace, recordId(delegationId))
      if (!row) return undefined
      const stored = await tx.get(namespace, recordId(delegationId))
      const record = stored ? DelegationRecordSchema.parse(stored.value) : undefined
      const receipt = record ? terminalReceipt(record) : undefined
      if (
        !receipt ||
        record?.delegationId !== delegationId ||
        canonicalJsonStringify(row.value) !== canonicalJsonStringify(receipt)
      )
        throw new Error('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
      return receipt
    })
  }

  /** Repairs CAS-before-publish and publish-before-ack crashes using only retained evidence.
   * The supplied publisher must durably deduplicate the retained key before returning.
   */
  async recoverTerminalPublication(
    delegationId: string,
    publisher: DelegationEventPublisher
  ): Promise<DelegationRecord> {
    IdentifierSchemas.delegationId.parse(delegationId)
    let record = await this.provider.transaction(async (tx) => {
      const row = await tx.get(namespace, recordId(delegationId))
      const current = row ? DelegationRecordSchema.parse(row.value) : undefined
      if (!current || current.delegationId !== delegationId || !current.terminalPublication)
        throw new Error('DELEGATION_TERMINAL_RECEIPT_MISSING')
      // Existing pending terminalPublication is already a durable recovery intent.
      // Backfill its complete receipt without inventing outcomes for legacy rows lacking it.
      await retainTerminalReceipt(tx, current, current)
      return current
    })
    record = await recoverDelegationInteractionPublications(this, publisher, record)
    const receipt = terminalReceipt(record)!
    if (receipt.status === 'published') return record
    await publisher.publish(receipt.event, receipt.idempotencyKey)
    const acknowledged = DelegationRecordSchema.parse({
      ...record,
      revision: record.revision + 1,
      terminalPublication: { ...record.terminalPublication, status: 'published' },
    })
    if (await this.compareAndSet(record.revision, acknowledged)) return acknowledged
    const replay = await this.getTerminalReceipt(delegationId)
    if (replay?.status !== 'published') throw new Error('DELEGATION_TERMINAL_RECEIPT_CONFLICT')
    return (await this.get(delegationId))!
  }

  /** Historical allocation evidence, never a reusable authorization grant. */
  async getAdmissionReceipt(
    delegationId: string
  ): Promise<StoredChildAdmissionReceipt | undefined> {
    IdentifierSchemas.delegationId.parse(delegationId)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(childAdmissionNamespace, recordId(delegationId))
      if (!row) return undefined
      const stored = row.value as unknown as StoredChildAdmissionReceipt
      const request = ChildAdmissionRequestSchema.parse(stored.request)
      const receipt = ChildAdmissionReceiptSchema.parse(stored.receipt)
      assertChildAdmissionReceiptMatches(request, receipt, request.acceptedAt)
      if (request.delegationId !== delegationId)
        throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      return { request, receipt }
    })
  }

  async getChildMapping(childAttemptId: string): Promise<ChildJobMapping | undefined> {
    IdentifierSchemas.attemptId.parse(childAttemptId)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(childMappingNamespace, recordId(childAttemptId))
      if (!row) return undefined
      const mapping = ChildJobMappingSchema.parse(row.value)
      if (mapping.childAttemptId !== childAttemptId)
        throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      return mapping
    })
  }

  async findChildBySession(
    runtimeConnectionId: string,
    externalSessionId: string
  ): Promise<ChildJobMapping | undefined> {
    IdentifierSchemas.runtimeConnectionId.parse(runtimeConnectionId)
    IdentifierSchemas.externalSessionId.parse(externalSessionId)
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(
        childSessionNamespace,
        recordId(canonicalJsonStringify([runtimeConnectionId, externalSessionId]))
      )
      if (!row) return undefined
      const mapping = ChildJobMappingSchema.parse(row.value)
      const canonical = await tx.get(childMappingNamespace, recordId(mapping.childAttemptId))
      if (
        mapping.runtimeConnectionId !== runtimeConnectionId ||
        mapping.externalSessionId !== externalSessionId ||
        !canonical ||
        canonicalJsonStringify(canonical.value) !== canonicalJsonStringify(mapping)
      )
        throw new Error('DELEGATION_STORAGE_SCOPE_MISMATCH')
      return mapping
    })
  }

  /** Trusted dispatch callers bind their returned handle under the current attempt fence. */
  async bindChildSession(
    expectedRevision: number,
    input: ChildJobMapping
  ): Promise<ChildJobMapping> {
    const mapping = ChildJobMappingSchema.parse(input)
    if (!mapping.externalSessionId) throw new Error('DELEGATION_CHILD_SESSION_REQUIRED')
    return this.provider.transaction(async (tx) => {
      const row = await tx.get(namespace, recordId(mapping.delegationId))
      const record = row ? DelegationRecordSchema.parse(row.value) : undefined
      const executionRow = await tx.get('executions', recordId(mapping.childExecutionId))
      const attemptRow = await tx.get('execution-attempts', recordId(mapping.childAttemptId))
      const execution = ExecutionSchema.safeParse(executionRow?.value)
      const attempt = ExecutionAttemptSchema.safeParse(attemptRow?.value)
      if (
        !record ||
        record.revision !== expectedRevision ||
        record.parentExecutionId !== mapping.parentExecutionId ||
        record.childExecutionId !== mapping.childExecutionId ||
        record.childAttemptId !== mapping.childAttemptId ||
        record.runtimeConnectionId !== mapping.runtimeConnectionId ||
        !execution.success ||
        !attempt.success ||
        execution.data.executionId !== mapping.childExecutionId ||
        execution.data.correlation.workspaceId !== mapping.workspaceId ||
        execution.data.parentExecutionId !== mapping.parentExecutionId ||
        execution.data.latestAttemptId !== mapping.childAttemptId ||
        execution.data.executionPlan.executionPlanId !== record.childExecutionPlanId ||
        execution.data.executionPlan.contentDigest !== record.childExecutionPlanDigest ||
        attempt.data.attemptId !== mapping.childAttemptId ||
        attempt.data.executionId !== mapping.childExecutionId ||
        attempt.data.sequence !== execution.data.attemptCount ||
        attempt.data.runtime?.runtimeConnectionId !== mapping.runtimeConnectionId ||
        (attempt.data.runtime.externalSessionId !== undefined &&
          attempt.data.runtime.externalSessionId !== mapping.externalSessionId)
      )
        throw new Error('DELEGATION_CHILD_MAPPING_STALE')
      await retainChildMapping(tx, mapping)
      return mapping
    })
  }

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
        await withPersistenceReadScope(this.provider, tx, () => input.assertCurrent(reader))
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
          ...parentChildAllowanceOf(parentPlan.constraints.limits),
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
      await retainChildAdmission(tx, { request, receipt: input.receipt })
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
      await retainTerminalReceipt(tx, current, record)
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

/** The parent plan's child allowance, so a child is never funded beyond it from freed balance. */
function parentChildAllowanceOf(limits: Parameters<typeof childAllowanceStatementOf>[0]) {
  const parentChildAllowance = childAllowanceStatementOf(limits)
  return parentChildAllowance === undefined ? {} : { parentChildAllowance }
}
