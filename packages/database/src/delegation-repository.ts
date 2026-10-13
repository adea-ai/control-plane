import { executionScopeFieldsFromRow } from './execution-scope.js'
import { executionScopesEqual, executionScopeCanNarrow } from '@control-plane/domain'
import { isDeepStrictEqual } from 'node:util'
import { assertContextPackageIntegrity } from '@control-plane/context'
import {
  canonicalJsonStringify,
  compareCodePointOrder,
  IdentifierSchemas,
} from '@control-plane/contracts'
import {
  assertExecutionPlanIntegrity,
  assertExecutionPlanDerivedFrom,
  type ExecutionPlan,
} from '@control-plane/execution-plan'
import { and, eq, or } from 'drizzle-orm'
import {
  ChildAdmissionAllocationError,
  assertChildAdmissionReceiptMatches,
  DelegationRecordSchema,
  type ChildAdmissionAllocator,
  type DelegationRecord,
  type DelegationRepository,
} from '@control-plane/orchestration'
import { ExecutionAttemptSchema, ExecutionSchema } from '@control-plane/domain'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import type { ControlPlaneDatabase } from './connection.js'
import { createPgChildAdmissionReader } from './child-admission-reader.js'
import { contextPackages } from './schema/context-packages.js'
import { delegations } from './schema/delegations.js'
import { executionPlans } from './schema/execution-plans.js'
import { executionAttempts, executions } from './schema/executions.js'
import { PostgresDurableUsageStore } from './usage-store.js'
import { fromExecutionRow, toAttemptRow, toExecutionRow } from './execution-repository.js'

const REFERENCE_INTEGRITY_ERROR = 'DELEGATION_REFERENCE_INTEGRITY_ERROR'

export class PostgresDelegationRepository implements DelegationRepository, ChildAdmissionAllocator {
  constructor(readonly database: ControlPlaneDatabase) {}

  async allocate(input: Parameters<ChildAdmissionAllocator['allocate']>[0]): Promise<boolean> {
    const execution = ExecutionSchema.parse(input.execution)
    const attempt = ExecutionAttemptSchema.parse(input.attempt)
    const record = DelegationRecordSchema.parse(input.delegation)
    const request = input.request
    const receipt = assertChildAdmissionReceiptMatches(
      request,
      input.receipt,
      new Date().toISOString()
    )
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
      execution.correlation.workspaceId !== request.workspaceId ||
      receipt.selectionRef.length === 0
    ) {
      throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
    }

    return this.database.transaction(async (transaction) => {
      // The parent lock serializes sibling count/depth checks with all other
      // child allocations for this parent.
      const [parentRow] = await transaction
        .select()
        .from(executions)
        .where(eq(executions.executionId, request.parentExecutionId))
        .for('update')
        .limit(1)
      if (!parentRow) throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      const parent = fromExecutionRow(parentRow)
      if (
        parent.version !== request.parentExecutionVersion ||
        parent.latestAttemptId !== request.parentAttemptId ||
        parent.correlation.workspaceId !== request.workspaceId ||
        parent.executionPlan.executionPlanId !== request.parentPlan.executionPlanId ||
        parent.executionPlan.contentDigest !== request.parentPlan.contentDigest ||
        parent.executionPlan.schemaVersion !== request.parentPlan.schemaVersion ||
        !['running', 'awaiting_input'].includes(parent.state)
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }
      const [parentAttempt] = await transaction
        .select({
          attemptId: executionAttempts.attemptId,
          executionId: executionAttempts.executionId,
          sequence: executionAttempts.sequence,
          state: executionAttempts.state,
        })
        .from(executionAttempts)
        .where(
          and(
            eq(executionAttempts.attemptId, request.parentAttemptId),
            eq(executionAttempts.executionId, request.parentExecutionId)
          )
        )
        .for('update')
        .limit(1)
      if (
        !parentAttempt ||
        parentAttempt.executionId !== request.parentExecutionId ||
        parentAttempt.sequence !== parent.attemptCount ||
        !['running', 'awaiting_input'].includes(parentAttempt.state)
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }

      const [existingAllocation] = await transaction
        .select({ delegationId: delegations.delegationId })
        .from(delegations)
        .where(
          or(
            eq(delegations.delegationId, request.delegationId),
            eq(delegations.childExecutionId, request.childExecutionId)
          )
        )
        .limit(1)
      if (existingAllocation) return false

      const [parentPlanRow] = await transaction
        .select()
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, request.parentPlan.executionPlanId))
        .for('update')
        .limit(1)
      const parentPlan = parentPlanRow && assertExecutionPlanIntegrity(parentPlanRow.plan)
      if (
        !parentPlan ||
        parentPlan.contentDigest !== request.parentPlan.contentDigest ||
        parentPlan.schemaVersion !== request.parentPlan.schemaVersion
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }

      const [childPlanRow] = await transaction
        .select()
        .from(executionPlans)
        .where(eq(executionPlans.executionPlanId, request.childPlan.executionPlanId))
        .for('update')
        .limit(1)
      const childPlan = childPlanRow && assertExecutionPlanIntegrity(childPlanRow.plan)
      if (
        !childPlan ||
        childPlan.contentDigest !== request.childPlan.contentDigest ||
        childPlan.schemaVersion !== request.childPlan.schemaVersion
      ) {
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
      }

      const siblings = await transaction
        .select({ state: delegations.state })
        .from(delegations)
        .where(eq(delegations.parentExecutionId, request.parentExecutionId))
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
      let cursor: string = String(request.parentExecutionId)
      const ancestry = new Set<string>([cursor])
      while (true) {
        const cursorId = IdentifierSchemas.executionId.parse(cursor)
        const [ancestor] = await transaction
          .select({ parentExecutionId: delegations.parentExecutionId })
          .from(delegations)
          .where(eq(delegations.childExecutionId, cursorId))
          .limit(1)
        if (!ancestor) break
        const ancestorParentId = String(ancestor.parentExecutionId)
        if (ancestry.has(ancestorParentId)) {
          throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')
        }
        ancestry.add(ancestorParentId)
        cursor = ancestorParentId
        depth += 1
      }
      if (depth >= parentPlan.constraints.limits.childExecutions.maximumDepth) {
        throw new ChildAdmissionAllocationError('DELEGATION_DEPTH_EXCEEDED')
      }

      // Re-read actor, audience, role selection, and readiness after canonical
      // lineage/limits are locked and before the first execution/budget write.
      // Every canonical read in this authority recheck goes through this transaction's reader, which closes
      // when the recheck returns. No read uses the pool while the allocation transaction is open.
      const reader = createPgChildAdmissionReader(transaction, request.workspaceId)
      try {
        await input.assertCurrent(reader)
      } finally {
        reader.close()
      }
      assertChildAdmissionReceiptMatches(request, receipt, new Date().toISOString())

      const [existingExecution] = await transaction
        .select({ executionId: executions.executionId })
        .from(executions)
        .where(eq(executions.executionId, execution.executionId))
        .limit(1)
      if (existingExecution) return false
      const insertedExecution = await transaction
        .insert(executions)
        .values(toExecutionRow(execution))
        .onConflictDoNothing()
        .returning({ executionId: executions.executionId })
      if (insertedExecution.length !== 1) return false
      const insertedAttempt = await transaction
        .insert(executionAttempts)
        .values(toAttemptRow(attempt))
        .onConflictDoNothing()
        .returning({ attemptId: executionAttempts.attemptId })
      if (insertedAttempt.length !== 1)
        throw new ChildAdmissionAllocationError('CHILD_ADMISSION_DENIED')

      // Verify canonical context/plan ancestry before the transaction can
      // commit execution, attempt, budget, or delegation records.
      await lockAndVerifyReferences(transaction, record)
      await PostgresDurableUsageStore.withTransaction(transaction, request.workspaceId, (store) =>
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
      const insertedDelegation = await transaction
        .insert(delegations)
        .values(toRow(record))
        .onConflictDoNothing()
        .returning({ delegationId: delegations.delegationId })
      if (insertedDelegation.length !== 1) throw new Error(REFERENCE_INTEGRITY_ERROR)
      return true
    })
  }

  async insert(recordInput: DelegationRecord): Promise<boolean> {
    const record = DelegationRecordSchema.parse(recordInput)
    return this.database.transaction(async (transaction) => {
      // A replay remains idempotent after retention has removed old targets.
      const [duplicate] = await transaction
        .select({ delegationId: delegations.delegationId })
        .from(delegations)
        .where(
          or(
            eq(delegations.delegationId, record.delegationId),
            eq(delegations.childExecutionId, record.childExecutionId)
          )
        )
        .limit(1)
      if (duplicate) return false

      await lockAndVerifyReferences(transaction, record)
      const inserted = await transaction
        .insert(delegations)
        .values(toRow(record))
        .onConflictDoNothing()
        .returning({ delegationId: delegations.delegationId })
      return inserted.length === 1
    })
  }

  async get(delegationId: string): Promise<DelegationRecord | undefined> {
    const [row] = await this.database
      .select({ record: delegations.record })
      .from(delegations)
      .where(eq(delegations.delegationId, delegationId))
      .limit(1)
    return row ? DelegationRecordSchema.parse(row.record) : undefined
  }

  async findByChild(childExecutionId: string): Promise<DelegationRecord | undefined> {
    const [row] = await this.database
      .select({ record: delegations.record })
      .from(delegations)
      .where(eq(delegations.childExecutionId, childExecutionId))
      .limit(1)
    return row ? DelegationRecordSchema.parse(row.record) : undefined
  }

  async listByParent(parentExecutionId: string): Promise<readonly DelegationRecord[]> {
    const rows = await this.database
      .select({ record: delegations.record })
      .from(delegations)
      .where(eq(delegations.parentExecutionId, parentExecutionId))
      .orderBy(delegations.delegationId)
    return rows.map(({ record }) => DelegationRecordSchema.parse(record))
  }

  async compareAndSet(expectedRevision: number, recordInput: DelegationRecord): Promise<boolean> {
    const record = DelegationRecordSchema.parse(recordInput)
    return this.database.transaction(async (transaction) => {
      const [row] = await transaction
        .select()
        .from(delegations)
        .where(eq(delegations.delegationId, record.delegationId))
        .for('update')
      if (!row || row.revision !== expectedRevision) return false

      const current = DelegationRecordSchema.parse(row.record)
      if (
        row.delegationGroupId !== (current.delegationGroupId ?? null) ||
        row.parentExecutionId !== current.parentExecutionId ||
        row.childExecutionId !== current.childExecutionId ||
        row.inputDigest !== current.inputDigest ||
        row.state !== current.state ||
        current.revision !== expectedRevision ||
        row.acceptedAt.getTime() !== Date.parse(current.acceptedAt) ||
        row.updatedAt.getTime() !== Date.parse(current.updatedAt) ||
        !sameImmutableDelegation(current, record)
      ) {
        return false
      }

      const updated = await transaction
        .update(delegations)
        .set(toRow(record))
        .where(
          and(
            eq(delegations.delegationId, record.delegationId),
            eq(delegations.revision, expectedRevision),
            eq(delegations.inputDigest, current.inputDigest)
          )
        )
        .returning({ delegationId: delegations.delegationId })
      return updated.length === 1
    })
  }
}

async function lockAndVerifyReferences(
  transaction: Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0],
  record: DelegationRecord
): Promise<void> {
  // Read the parent plan without locking only to discover its context target.
  // The locked plan is checked against this reference before the insert.
  const ancestorContextReference = await readAncestorContextReference(transaction, record)
  const contextReferences = [
    {
      contextPackageId: record.contextPackageId,
      contentDigest: record.contextPackageDigest,
    },
    ancestorContextReference,
  ].toSorted((left, right) => compareCodePointOrder(left.contextPackageId, right.contextPackageId))
  const contextRows: Array<typeof contextPackages.$inferSelect> = []
  let previousContextPackageId: string | undefined
  for (const reference of contextReferences) {
    if (reference.contextPackageId === previousContextPackageId) continue
    const [contextRow] = await transaction
      .select()
      .from(contextPackages)
      .where(eq(contextPackages.contextPackageId, reference.contextPackageId))
      .for('update')
    if (!contextRow) throw new Error(REFERENCE_INTEGRITY_ERROR)
    contextRows.push(contextRow)
    previousContextPackageId = reference.contextPackageId
  }

  const planIds = [record.parentExecutionPlanId, record.childExecutionPlanId]
    .toSorted(compareCodePointOrder)
    .filter((planId, index, all) => index === 0 || planId !== all[index - 1])
  const planRows: Array<typeof executionPlans.$inferSelect> = []
  for (const planId of planIds) {
    const [planRow] = await transaction
      .select()
      .from(executionPlans)
      .where(eq(executionPlans.executionPlanId, planId))
      .for('update')
    if (!planRow) throw new Error(REFERENCE_INTEGRITY_ERROR)
    planRows.push(planRow)
  }

  const executionIds = [record.parentExecutionId, record.childExecutionId]
    .toSorted(compareCodePointOrder)
    .filter((executionId, index, all) => index === 0 || executionId !== all[index - 1])
  const executionRows: Array<typeof executions.$inferSelect> = []
  for (const executionId of executionIds) {
    const [executionRow] = await transaction
      .select()
      .from(executions)
      .where(eq(executions.executionId, executionId))
      .for('key share')
    if (!executionRow) throw new Error(REFERENCE_INTEGRITY_ERROR)
    executionRows.push(executionRow)
  }

  verifyReferenceRows(record, ancestorContextReference, contextRows, planRows, executionRows)

  // The plan/context claims are already locked in the shared global order.
  // Clear clocks only after every exact reference and owner row was validated.
  for (const contextRow of contextRows) {
    await transaction
      .update(contextPackages)
      .set({ unreferencedSince: null })
      .where(eq(contextPackages.contextPackageId, contextRow.contextPackageId))
  }
  for (const planRow of planRows) {
    await transaction
      .update(executionPlans)
      .set({ unreferencedSince: null })
      .where(eq(executionPlans.executionPlanId, planRow.executionPlanId))
  }
}

async function readAncestorContextReference(
  transaction: Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0],
  record: DelegationRecord
): Promise<ExecutionPlan['contextPackage']> {
  const [parentPlanRow] = await transaction
    .select()
    .from(executionPlans)
    .where(eq(executionPlans.executionPlanId, record.parentExecutionPlanId))
    .limit(1)
  if (!parentPlanRow) throw new Error(REFERENCE_INTEGRITY_ERROR)

  try {
    const parentPlan = assertExecutionPlanIntegrity(parentPlanRow.plan)
    if (
      !planRowMatches(parentPlanRow, parentPlan) ||
      parentPlan.executionPlanId !== record.parentExecutionPlanId ||
      parentPlan.contentDigest !== record.parentExecutionPlanDigest
    ) {
      throw new Error(REFERENCE_INTEGRITY_ERROR)
    }
    return parentPlan.contextPackage
  } catch {
    throw new Error(REFERENCE_INTEGRITY_ERROR)
  }
}

function verifyReferenceRows(
  record: DelegationRecord,
  ancestorContextReference: ExecutionPlan['contextPackage'],
  contextRows: readonly (typeof contextPackages.$inferSelect)[],
  planRows: readonly (typeof executionPlans.$inferSelect)[],
  executionRows: readonly (typeof executions.$inferSelect)[]
): void {
  let contextPackage: ReturnType<typeof assertContextPackageIntegrity>
  let ancestorContextPackage: ReturnType<typeof assertContextPackageIntegrity>
  let parentPlan: ExecutionPlan
  let childPlan: ExecutionPlan
  try {
    const contextPackagesById = new Map<string, ReturnType<typeof assertContextPackageIntegrity>>()
    for (const contextRow of contextRows) {
      const parsedContextPackage = assertContextPackageIntegrity(contextRow.contextPackage)
      if (!contextRowMatches(contextRow, parsedContextPackage)) {
        throw new Error(REFERENCE_INTEGRITY_ERROR)
      }
      contextPackagesById.set(contextRow.contextPackageId, parsedContextPackage)
    }
    contextPackage = contextPackagesById.get(record.contextPackageId)!
    ancestorContextPackage = contextPackagesById.get(ancestorContextReference.contextPackageId)!
    if (!contextPackage || !ancestorContextPackage) throw new Error(REFERENCE_INTEGRITY_ERROR)

    const parentPlanRow = planRows.find(
      ({ executionPlanId }) => executionPlanId === record.parentExecutionPlanId
    )
    const childPlanRow = planRows.find(
      ({ executionPlanId }) => executionPlanId === record.childExecutionPlanId
    )
    if (!parentPlanRow || !childPlanRow) throw new Error(REFERENCE_INTEGRITY_ERROR)
    parentPlan = assertExecutionPlanIntegrity(parentPlanRow.plan)
    childPlan = assertExecutionPlanIntegrity(childPlanRow.plan)
    if (
      !planRowMatches(parentPlanRow, parentPlan) ||
      !planRowMatches(childPlanRow, childPlan) ||
      !contextPinMatchesPackage(parentPlan.contextPackage, ancestorContextPackage) ||
      !contextPinMatchesPackage(childPlan.contextPackage, contextPackage) ||
      !contextPinMatchesReference(parentPlan.contextPackage, ancestorContextReference)
    ) {
      throw new Error(REFERENCE_INTEGRITY_ERROR)
    }
    assertExecutionPlanDerivedFrom(parentPlan, childPlan, ancestorContextPackage, contextPackage)
  } catch {
    throw new Error(REFERENCE_INTEGRITY_ERROR)
  }

  const parentExecution = executionRows.find(
    ({ executionId }) => executionId === record.parentExecutionId
  )
  const childExecution = executionRows.find(
    ({ executionId }) => executionId === record.childExecutionId
  )
  const parentPlanRow = planRows.find(
    ({ executionPlanId }) => executionPlanId === record.parentExecutionPlanId
  )
  const childPlanRow = planRows.find(
    ({ executionPlanId }) => executionPlanId === record.childExecutionPlanId
  )
  if (!parentExecution || !childExecution || !parentPlanRow || !childPlanRow) {
    throw new Error(REFERENCE_INTEGRITY_ERROR)
  }

  const sameContext =
    parentPlan.contextPackage.contextPackageId === contextPackage.contextPackageId &&
    parentPlan.contextPackage.contentDigest === contextPackage.contentDigest
  const derivedContext =
    contextPackage.parentContextPackage?.contextPackageId ===
      parentPlan.contextPackage.contextPackageId &&
    contextPackage.parentContextPackage.contentDigest === parentPlan.contextPackage.contentDigest
  if (
    record.parentExecutionId === record.childExecutionId ||
    childExecution.parentExecutionId !== record.parentExecutionId ||
    parentExecution.workspaceId !== childExecution.workspaceId ||
    !executionScopeCanNarrow(
      { workspaceId: parentExecution.workspaceId, ...executionScopeFieldsFromRow(parentExecution) },
      { workspaceId: childExecution.workspaceId, ...executionScopeFieldsFromRow(childExecution) }
    ) ||
    record.parentExecutionPlanId !== parentExecution.executionPlanId ||
    record.parentExecutionPlanDigest !== parentExecution.executionPlanDigest ||
    record.childExecutionPlanId !== childExecution.executionPlanId ||
    record.childExecutionPlanDigest !== childExecution.executionPlanDigest ||
    parentExecution.executionPlanId !== parentPlan.executionPlanId ||
    parentExecution.executionPlanDigest !== parentPlan.contentDigest ||
    childExecution.executionPlanId !== childPlan.executionPlanId ||
    childExecution.executionPlanDigest !== childPlan.contentDigest ||
    parentExecution.executionPlanSchemaVersion !== parentPlan.schemaVersion ||
    childExecution.executionPlanSchemaVersion !== childPlan.schemaVersion ||
    !executionMatchesPlan(parentExecution, parentPlan) ||
    !executionMatchesPlan(childExecution, childPlan) ||
    !executionScopeCanNarrow(parentPlan.correlation, childPlan.correlation) ||
    childPlan.parentExecutionPlan?.executionPlanId !== parentPlan.executionPlanId ||
    childPlan.parentExecutionPlan.contentDigest !== parentPlan.contentDigest ||
    (!sameContext && !derivedContext) ||
    record.contextPackageId !== contextPackage.contextPackageId ||
    record.contextPackageDigest !== contextPackage.contentDigest ||
    contextPackage.contentDigest !== record.contextPackageDigest ||
    !executionScopesEqual(contextPackage.projectState, {
      workspaceId: childExecution.workspaceId,
      ...executionScopeFieldsFromRow(childExecution),
    })
  ) {
    throw new Error(REFERENCE_INTEGRITY_ERROR)
  }
}

function contextRowMatches(
  row: typeof contextPackages.$inferSelect,
  contextPackage: ReturnType<typeof assertContextPackageIntegrity>
): boolean {
  return (
    row.contextPackageId === contextPackage.contextPackageId &&
    row.contentDigest === contextPackage.contentDigest &&
    row.schemaVersion === contextPackage.schemaVersion &&
    row.workspaceId === contextPackage.projectState.workspaceId &&
    row.projectId === (contextPackage.projectState.projectId ?? null) &&
    isDeepStrictEqual(row.executionScope, contextPackage.projectState.executionScope ?? null) &&
    row.compiledAt.toISOString() === contextPackage.compiledAt
  )
}

function contextPinMatchesPackage(
  reference: ExecutionPlan['contextPackage'],
  contextPackage: ReturnType<typeof assertContextPackageIntegrity>
): boolean {
  return (
    reference.contextPackageId === contextPackage.contextPackageId &&
    reference.contentDigest === contextPackage.contentDigest &&
    reference.schemaVersion === contextPackage.schemaVersion &&
    reference.compilerVersion === contextPackage.compiler.version
  )
}

function contextPinMatchesReference(
  left: ExecutionPlan['contextPackage'],
  right: ExecutionPlan['contextPackage']
): boolean {
  return (
    left.contextPackageId === right.contextPackageId &&
    left.contentDigest === right.contentDigest &&
    left.schemaVersion === right.schemaVersion &&
    left.compilerVersion === right.compilerVersion
  )
}

function planRowMatches(row: typeof executionPlans.$inferSelect, plan: ExecutionPlan): boolean {
  return (
    row.executionPlanId === plan.executionPlanId &&
    row.contentDigest === plan.contentDigest &&
    row.schemaVersion === plan.schemaVersion &&
    row.workspaceId === plan.correlation.workspaceId &&
    row.projectId === (plan.correlation.projectId ?? null) &&
    isDeepStrictEqual(row.executionScope, plan.correlation.executionScope ?? null) &&
    row.taskId === plan.correlation.taskId &&
    row.agentId === plan.correlation.agentId &&
    row.compiledAt.toISOString() === plan.compiledAt
  )
}

function executionMatchesPlan(
  execution: typeof executions.$inferSelect,
  plan: ExecutionPlan
): boolean {
  return (
    execution.workspaceId === plan.correlation.workspaceId &&
    execution.projectId === (plan.correlation.projectId ?? null) &&
    isDeepStrictEqual(execution.executionScope, plan.correlation.executionScope ?? null) &&
    execution.taskId === plan.correlation.taskId &&
    execution.agentId === plan.correlation.agentId
  )
}

function sameImmutableDelegation(left: DelegationRecord, right: DelegationRecord): boolean {
  return (
    left.delegationId === right.delegationId &&
    left.delegationGroupId === right.delegationGroupId &&
    left.parentExecutionId === right.parentExecutionId &&
    left.parentAttemptId === right.parentAttemptId &&
    left.admittedToolCallId === right.admittedToolCallId &&
    left.childExecutionId === right.childExecutionId &&
    left.parentExecutionPlanId === right.parentExecutionPlanId &&
    left.parentExecutionPlanDigest === right.parentExecutionPlanDigest &&
    left.childExecutionPlanId === right.childExecutionPlanId &&
    left.childExecutionPlanDigest === right.childExecutionPlanDigest &&
    left.contextPackageId === right.contextPackageId &&
    left.contextPackageDigest === right.contextPackageDigest &&
    left.role === right.role &&
    left.profileVersionId === right.profileVersionId &&
    left.objective === right.objective &&
    isDeepStrictEqual(left.policy, right.policy) &&
    left.inputDigest === right.inputDigest &&
    left.acceptedAt === right.acceptedAt &&
    left.deadlineAt === right.deadlineAt
  )
}

function toRow(record: DelegationRecord) {
  return {
    delegationId: record.delegationId,
    delegationGroupId: record.delegationGroupId ?? null,
    parentExecutionId: record.parentExecutionId,
    childExecutionId: record.childExecutionId,
    state: record.state,
    revision: record.revision,
    inputDigest: record.inputDigest,
    record,
    acceptedAt: new Date(record.acceptedAt),
    updatedAt: new Date(record.updatedAt),
  }
}
