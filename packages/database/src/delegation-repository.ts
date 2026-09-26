import { isDeepStrictEqual } from 'node:util'
import { assertContextPackageIntegrity } from '@control-plane/context'
import { compareCodePointOrder } from '@control-plane/contracts'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import { and, eq, or } from 'drizzle-orm'
import {
  DelegationRecordSchema,
  type DelegationRecord,
  type DelegationRepository,
} from '@control-plane/orchestration'
import type { ControlPlaneDatabase } from './connection.js'
import { contextPackages } from './schema/context-packages.js'
import { delegations } from './schema/delegations.js'
import { executionPlans } from './schema/execution-plans.js'
import { executions } from './schema/executions.js'

const REFERENCE_INTEGRITY_ERROR = 'DELEGATION_REFERENCE_INTEGRITY_ERROR'

export class PostgresDelegationRepository implements DelegationRepository {
  constructor(readonly database: ControlPlaneDatabase) {}

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
      .for('key share')
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
      .for('key share')
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
    parentExecution.projectId !== childExecution.projectId ||
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
    !sameScope(parentPlan.correlation, childPlan.correlation) ||
    childPlan.parentExecutionPlan?.executionPlanId !== parentPlan.executionPlanId ||
    childPlan.parentExecutionPlan.contentDigest !== parentPlan.contentDigest ||
    (!sameContext && !derivedContext) ||
    record.contextPackageId !== contextPackage.contextPackageId ||
    record.contextPackageDigest !== contextPackage.contentDigest ||
    contextPackage.contentDigest !== record.contextPackageDigest ||
    contextPackage.projectState.workspaceId !== parentExecution.workspaceId ||
    contextPackage.projectState.projectId !== parentExecution.projectId
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
    row.projectId === contextPackage.projectState.projectId &&
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
    row.projectId === plan.correlation.projectId &&
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
    execution.projectId === plan.correlation.projectId &&
    execution.taskId === plan.correlation.taskId &&
    execution.agentId === plan.correlation.agentId
  )
}

function sameScope(
  left: Pick<ExecutionPlan['correlation'], 'workspaceId' | 'projectId'>,
  right: Pick<ExecutionPlan['correlation'], 'workspaceId' | 'projectId'>
): boolean {
  return left.workspaceId === right.workspaceId && left.projectId === right.projectId
}

function sameImmutableDelegation(left: DelegationRecord, right: DelegationRecord): boolean {
  return (
    left.delegationId === right.delegationId &&
    left.delegationGroupId === right.delegationGroupId &&
    left.parentExecutionId === right.parentExecutionId &&
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
