import { createHash } from 'node:crypto'
import { canonicalJsonStringify, IdentifierSchemas } from '@control-plane/contracts'
import type {
  JsonValue,
  PersistenceProvider,
  PersistenceTransaction,
} from '@control-plane/deployment'
import { assertContextPackageIntegrity } from '@control-plane/context'
import {
  ExecutionSchema,
  ExecutionAttemptSchema,
  InteractionRequestSchema,
} from '@control-plane/domain'
import {
  assertExecutionPlanIntegrity,
  assertExecutionPlanDerivedFrom,
  deriveExecutionPlan,
  deriveExecutionPlanWithAuthority,
  type CurrentExecutionScopeAuthority,
  type ExecutionPlan,
} from '@control-plane/execution-plan'
import {
  DelegationToolAdmissionSchema,
  DelegationRecordSchema,
  delegationInputDigestV2,
} from '@control-plane/orchestration'
import {
  PiChildContinuationGrantSchema,
  PiDurableAdmissionSchema,
  piChildContinuationAdmissionDigest,
  piChildContinuationStartRequestDigest,
  assertGrantMatchesAuthority,
  assertPiChildContinuationRequest,
  assertPiChildContinuationSnapshot,
  assertPiChildContinuationToolCall,
  type PiChildContinuationGrant,
  type PiChildContinuationGrantRepository,
  type PiDurableAdmission,
} from '@control-plane/pi-durable-adapter'
import {
  RuntimeExecutionHandleSchema,
  RuntimeStartRequestSchema,
  type RuntimeExecutionHandle,
  type RuntimeStartRequest,
} from '@control-plane/runtime-sdk'

const namespace = 'pi-child-continuations'
const storedId = (value: string) => `r-${createHash('sha256').update(value).digest('hex')}`
const same = (a: unknown, b: unknown) => canonicalJsonStringify(a) === canonicalJsonStringify(b)
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as JsonValue
function denied(): never {
  throw new Error('PI_CHILD_CONTINUATION_DENIED')
}

export interface PiChildContinuationTransactionContext {
  readonly transaction: PersistenceTransaction
  readonly grant: PiChildContinuationGrant
  readonly mode: 'retain' | 'resume'
}
export interface PiChildContinuationJournalMetadata {
  /** Fresh server journal state; mandatory for minting, not a new replay grant. */
  readonly state: string
  readonly handle: RuntimeExecutionHandle
  readonly request: RuntimeStartRequest
  readonly admission: PiDurableAdmission
}
export interface SqlitePiChildContinuationRepositoryOptions {
  readonly provider: Pick<PersistenceProvider, 'transaction'>
  readonly workspaceId: string
  readonly now: () => string
  /** Read the actual bound journal, verifying its stored request/admission digest first.
   * This port is metadata only: no paid inference, effect, nested canonical transaction or new work. */
  readonly readChildMetadata?: (
    input: PiChildContinuationTransactionContext
  ) => Promise<PiChildContinuationJournalMetadata | undefined>
  /** Synchronous read-only native journal check after all awaited guards.
   * Required for new retention; must not yield, mutate authority, or claim an owner. */
  readonly readChildMetadataNow?: (
    input: PiChildContinuationTransactionContext
  ) => PiChildContinuationJournalMetadata | undefined
  /** Mandatory current actor, source, approval-grant, policy, provider and spending authority.
   * Canonical reads must use the supplied transaction; never call nested repositories. */
  /** Server-owned live parent/child scope grants; required for explicit scope plans.
   * Factory and reads must remain bound to this same canonical transaction. */
  readonly scopeAuthority?: (
    input: PiChildContinuationTransactionContext
  ) => CurrentExecutionScopeAuthority
  readonly assertCurrent?: (input: PiChildContinuationTransactionContext) => Promise<void>
}

/** Immutable per-child-attempt winner in the canonical execution writer transaction.
 * Completed parents cannot mint grants. Existing exact grants can resume after parent
 * completion under their original current authority; no expiry/selection/budget refresh. */
export class SqlitePiChildContinuationRepository implements PiChildContinuationGrantRepository {
  constructor(readonly options: SqlitePiChildContinuationRepositoryOptions) {
    IdentifierSchemas.workspaceId.parse(options.workspaceId)
  }
  async retain(
    input: PiChildContinuationGrant
  ): Promise<{ grant: PiChildContinuationGrant; replayed: boolean }> {
    try {
      const grant = PiChildContinuationGrantSchema.parse(input)
      if (grant.workspaceId !== this.options.workspaceId) denied()
      return await this.options.provider.transaction(async (transaction) => {
        const id = storedId(grant.child.attemptId)
        const row = await transaction.get(namespace, id)
        if (row) {
          const winner = PiChildContinuationGrantSchema.parse(row.value)
          if (!same(winner, grant)) denied()
          await this.#validate(transaction, winner, 'resume')
          return { grant: winner, replayed: true }
        }
        await this.#validate(transaction, grant, 'retain')
        await transaction.put({ namespace, id, value: json(grant) })
        return { grant, replayed: false }
      })
    } catch {
      denied()
    }
  }
  async getByChildAttempt(
    workspaceId: string,
    attemptId: string
  ): Promise<PiChildContinuationGrant | undefined> {
    try {
      IdentifierSchemas.workspaceId.parse(workspaceId)
      IdentifierSchemas.attemptId.parse(attemptId)
      if (workspaceId !== this.options.workspaceId) denied()
      return await this.options.provider.transaction(async (transaction) => {
        const row = await transaction.get(namespace, storedId(attemptId))
        if (!row) return undefined
        const grant = PiChildContinuationGrantSchema.parse(row.value)
        if (grant.workspaceId !== workspaceId || grant.child.attemptId !== attemptId) denied()
        await this.#validate(transaction, grant, 'resume')
        return grant
      })
    } catch {
      denied()
    }
  }
  async #validate(
    tx: PersistenceTransaction,
    grant: PiChildContinuationGrant,
    mode: 'retain' | 'resume'
  ) {
    const readChildMetadata = this.options.readChildMetadata
    const assertCurrent = this.options.assertCurrent
    if (!readChildMetadata || !assertCurrent) denied()
    const context = { transaction: tx, grant: structuredClone(grant), mode } as const
    const now = this.options.now()
    if (
      !Number.isFinite(Date.parse(now)) ||
      Date.parse(now) >= Date.parse(grant.expiresAt) ||
      Date.parse(now) < Date.parse(grant.createdAt)
    )
      denied()
    const parentExecution = ExecutionSchema.parse(
      (await tx.get('executions', storedId(grant.parent.executionId)))?.value
    )
    const childExecution = ExecutionSchema.parse(
      (await tx.get('executions', storedId(grant.child.executionId)))?.value
    )
    const parentAttempt = ExecutionAttemptSchema.parse(
      (await tx.get('execution-attempts', storedId(grant.parent.attemptId)))?.value
    )
    const childAttempt = ExecutionAttemptSchema.parse(
      (await tx.get('execution-attempts', storedId(grant.child.attemptId)))?.value
    )
    const parentPlan = await plan(tx, grant.parent.executionPlan)
    const childPlan = await plan(tx, grant.child.executionPlan)
    await assertAncestry(tx, childPlan)
    const suffix = grant.workspaceId.toLowerCase()
    const source = await tx.get(
      `delegation-tool-sources-${suffix}`,
      grant.sourceKey.slice('pi-tool:'.length)
    )
    const requestId = IdentifierSchemas.requestId.parse(
      (source?.value as { requestId?: unknown })?.requestId
    )
    const admission = DelegationToolAdmissionSchema.parse(
      (await tx.get(`delegation-tool-admissions-${suffix}`, storedId(requestId)))?.value
    )
    const callIndex = await tx.get(
      `delegation-tool-call-admissions-${suffix}`,
      storedId(grant.admittedToolCallId)
    )
    if (
      admission.sourceKey !== grant.sourceKey ||
      (callIndex?.value as { requestId?: unknown })?.requestId !== requestId
    )
      denied()
    assertPiChildContinuationRequest(grant, admission.request)
    const deriveOptions = this.options.scopeAuthority
    const explicitlyScoped = parentPlan.schemaVersion === 2 || childPlan.schemaVersion === 2
    if (explicitlyScoped && !deriveOptions) denied()
    const derived = explicitlyScoped
      ? await deriveExecutionPlanWithAuthority(parentPlan, admission.command.delegation.childPlan, {
          callerPrincipalId: grant.canonicalActorPrincipalId,
          authority: deriveOptions!(context),
          now,
        })
      : deriveExecutionPlan(parentPlan, admission.command.delegation.childPlan)
    if (!same(admission.command.delegation.parentPlan, parentPlan) || !same(derived, childPlan))
      denied()
    const delegation = DelegationRecordSchema.parse(
      (await tx.get('delegations', storedId(admission.command.delegation.delegationId)))?.value
    )
    const childIndex = await tx.get('delegation-by-child', storedId(grant.child.executionId))
    if (
      (childIndex?.value as { delegationId?: unknown })?.delegationId !== delegation.delegationId ||
      admission.command.delegation.childExecutionId !== grant.child.executionId ||
      admission.command.dispatch.childAttemptId !== grant.child.attemptId ||
      admission.command.dispatch.delegationId !== delegation.delegationId ||
      delegation.objective !== admission.command.delegation.objective ||
      delegation.role !== admission.command.delegation.role ||
      delegation.profileVersionId !== admission.command.delegation.profileVersionId ||
      !same(delegation.policy, admission.command.delegation.policy) ||
      delegation.inputDigest !==
        delegationInputDigestV2({
          ...admission.command.delegation,
          // initialDispatch is transport routing: delegate() hashes the
          // delegation without it, so recompute over the same shape no matter
          // which admission writer embedded the dispatch envelope.
          initialDispatch: undefined,
        }) ||
      delegation.parentExecutionId !== grant.parent.executionId ||
      delegation.parentAttemptId !== grant.parent.attemptId ||
      delegation.childExecutionId !== grant.child.executionId ||
      delegation.childAttemptId !== grant.child.attemptId ||
      delegation.admittedToolCallId !== grant.admittedToolCallId ||
      delegation.parentExecutionPlanId !== parentPlan.executionPlanId ||
      delegation.parentExecutionPlanDigest !== parentPlan.contentDigest ||
      delegation.childExecutionPlanId !== childPlan.executionPlanId ||
      delegation.childExecutionPlanDigest !== childPlan.contentDigest ||
      delegation.contextPackageId !== childPlan.contextPackage.contextPackageId ||
      delegation.contextPackageDigest !== childPlan.contextPackage.contentDigest ||
      !['dispatched', 'running', 'awaiting_input'].includes(delegation.state) ||
      delegation.pendingProgress !== undefined ||
      delegation.pendingCancellationAt ||
      delegation.pendingDispatch
    )
      denied()
    const callNamespace = `tool-calls-${storedId(grant.workspaceId)}`
    const callId = storedId(canonicalJsonStringify([grant.workspaceId, grant.admittedToolCallId]))
    const storedCall = (await tx.get(callNamespace, callId))?.value as
      | { workspaceId?: unknown; toolCallId?: unknown; call?: unknown }
      | undefined
    if (
      storedCall?.workspaceId !== grant.workspaceId ||
      storedCall.toolCallId !== grant.admittedToolCallId
    )
      denied()
    assertPiChildContinuationToolCall(grant, admission.request, storedCall.call)
    const output = (storedCall.call as { result?: { output?: { delegationId?: unknown } } }).result
      ?.output
    if (output?.delegationId !== delegation.delegationId) denied()
    for (const deadline of [
      parentExecution.deadlineAt,
      parentAttempt.deadlineAt,
      childExecution.deadlineAt,
      childAttempt.deadlineAt,
      delegation.deadlineAt,
    ])
      if (deadline && Date.parse(grant.expiresAt) > Date.parse(deadline)) denied()
    const callKey = storedId(
      canonicalJsonStringify([grant.workspaceId, admission.request.idempotencyKey])
    )
    const callIdentity = (
      await tx.get(`tool-call-idempotency-${storedId(grant.workspaceId)}`, callKey)
    )?.value as
      | { workspaceId?: unknown; idempotencyKey?: unknown; toolCallId?: unknown }
      | undefined
    if (
      callIdentity?.workspaceId !== grant.workspaceId ||
      callIdentity.idempotencyKey !== admission.request.idempotencyKey ||
      callIdentity.toolCallId !== grant.admittedToolCallId
    )
      denied()
    if (grant.approval.interactionId) {
      const interaction = InteractionRequestSchema.parse(
        (await tx.get('interaction-requests', storedId(grant.approval.interactionId)))?.value
      )
      if (
        interaction.interactionId !== grant.approval.interactionId ||
        interaction.kind !== 'approval' ||
        interaction.state !== 'responded' ||
        interaction.response?.action !== 'approve' ||
        interaction.executionId !== grant.parent.executionId ||
        interaction.attemptId !== grant.parent.attemptId ||
        interaction.response.respondingPrincipalId !== grant.approval.principalRef ||
        !interaction.allowedPrincipalIds.includes(interaction.response.respondingPrincipalId) ||
        !same(interaction.allowedPrincipalIds, admission.request.approval?.allowedPrincipalIds) ||
        interaction.requestedAt !== admission.request.approval?.requestedAt ||
        interaction.expiresAt !== admission.request.approval?.expiresAt ||
        Date.parse(interaction.expiresAt) <= Date.parse(now) ||
        Date.parse(interaction.response.respondedAt) > Date.parse(grant.createdAt) ||
        Date.parse(interaction.response.respondedAt) < Date.parse(interaction.requestedAt)
      )
        denied()
    }
    const metadata = await readChildMetadata(context)
    if (
      !metadata ||
      (mode === 'retain' && !['starting', 'running', 'awaiting_input'].includes(metadata.state))
    )
      denied()
    const handle = RuntimeExecutionHandleSchema.parse(metadata.handle)
    const request = RuntimeStartRequestSchema.parse(metadata.request)
    const runtimeAdmission = PiDurableAdmissionSchema.parse(metadata.admission)
    if (
      piChildContinuationAdmissionDigest(runtimeAdmission) !== grant.child.admissionDigest ||
      piChildContinuationStartRequestDigest(request) !== grant.child.startRequestDigest
    )
      denied()
    assertGrantMatchesAuthority(grant, { request, admission: runtimeAdmission })
    assertPiChildContinuationSnapshot(
      grant,
      {
        parentExecution,
        parentAttempt,
        childExecution,
        childAttempt,
        parentPlan,
        childPlan,
        childHandle: handle,
      },
      { mode, now }
    )
    if (mode === 'retain') {
      const refreshedMetadata = await readChildMetadata(context)
      if (!refreshedMetadata || !same(refreshedMetadata, metadata)) denied()
    }
    await assertCurrent(context)
    if (mode === 'retain') {
      // No awaited native read after the final current-authority check.
      // The real journal reader is synchronous and cannot introduce a new await gap.
      const readNow = this.options.readChildMetadataNow
      if (!readNow) denied()
      const finalMetadata = readNow(context)
      if (
        !finalMetadata ||
        !['starting', 'running', 'awaiting_input'].includes(finalMetadata.state) ||
        !same(finalMetadata, metadata)
      )
        denied()
    }
    // Awaited metadata/current ports cannot authorize an expired grant.
    const finalNow = this.options.now()
    if (
      !Number.isFinite(Date.parse(finalNow)) ||
      Date.parse(finalNow) >= Date.parse(grant.expiresAt) ||
      Date.parse(finalNow) < Date.parse(now)
    )
      denied()
  }
}

async function plan(
  tx: PersistenceTransaction,
  reference: { executionPlanId: string; contentDigest: string; schemaVersion?: number }
): Promise<ExecutionPlan> {
  const value = assertExecutionPlanIntegrity(
    (await tx.get('execution-plans', storedId(reference.executionPlanId)))?.value
  )
  if (
    value.executionPlanId !== reference.executionPlanId ||
    value.contentDigest !== reference.contentDigest ||
    (reference.schemaVersion !== undefined && reference.schemaVersion !== value.schemaVersion)
  )
    denied()
  const context = assertContextPackageIntegrity(
    (await tx.get('context-packages', storedId(value.contextPackage.contextPackageId)))?.value
  )
  if (
    context.contextPackageId !== value.contextPackage.contextPackageId ||
    context.contentDigest !== value.contextPackage.contentDigest
  )
    denied()
  // Existing canonical delegations pin owners/plans and plans pin contexts. Clear
  // auxiliary first-unreferenced clocks in the same writer as this new reference.
  await tx.delete('retention-plan-reference-windows', storedId(value.executionPlanId))
  await tx.delete('retention-context-reference-windows', storedId(context.contextPackageId))
  return value
}
async function assertAncestry(tx: PersistenceTransaction, leaf: ExecutionPlan) {
  let child = leaf
  const seen = new Set<string>()
  for (let depth = 0; child.parentExecutionPlan; depth++) {
    if (depth >= 64 || seen.has(child.executionPlanId)) denied()
    seen.add(child.executionPlanId)
    const parent = await plan(tx, child.parentExecutionPlan)
    const parentContext = (
      await tx.get('context-packages', storedId(parent.contextPackage.contextPackageId))
    )?.value
    const childContext = (
      await tx.get('context-packages', storedId(child.contextPackage.contextPackageId))
    )?.value
    assertExecutionPlanDerivedFrom(parent, child, parentContext, childContext)
    child = parent
  }
}
