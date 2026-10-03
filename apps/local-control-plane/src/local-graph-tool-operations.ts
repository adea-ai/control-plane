import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalJsonStringify,
  ExecutionCancellationCommandSchema,
  IdentifierSchemas,
  type ReadRequestEnvelope,
  type ServicePrincipal,
  type StateChangingCommandEnvelope,
  type GraphToolPin,
} from '@control-plane/contracts'
import { InteractionService, type Execution, type ExecutionAttempt } from '@control-plane/domain'
import type { ObjectStore } from '@control-plane/deployment'
import {
  GraphNodeApprovalRequiredError,
  GraphNodeEffectUnconfirmedError,
  GraphNodeOperationSchema,
  type GraphNodeOperation,
  type GraphNodeOperationPort,
} from '@control-plane/orchestration'
import {
  SqliteDurableUsageStore,
  SqliteToolCallRepository,
  SqliteToolRegistryRepository,
  SqliteGraphDefinitionRepository,
  type SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import {
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  ToolRegistry,
  toolExecutionContentDigest,
  toolExecutionContentDigestLegacy,
  toolInputMatchesDigest,
  toolRequestDigest,
  toolRequestDigestLegacy,
  type ToolRateLimiter,
} from '@control-plane/tool-execution'
import {
  DurableToolCallRequestSchema,
  ToolExecutionResultSchema,
  type DurableToolCallRequest,
  type ToolCall,
  type ToolExecutionResult,
  type ToolVersion,
} from '@control-plane/tool-sdk'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import {
  graphOperationIdempotencyKeyFor,
  LangGraphSqliteCheckpointSaver,
} from '@control-plane/langgraph-adapter'
import { assertExecutionPlanIntegrity, type ExecutionPlan } from '@control-plane/execution-plan'
import { ExecutionWorkflowInputSchema, GraphDefinitionCatalog } from '@control-plane/orchestration'
import type { WorkflowJobRecord } from '@control-plane/workflow-runtime'
import type { LocalControlPlaneComposition } from './composition.js'
import type { LocalControlApiComposition } from './local-api-composition.js'
import { authorizeLocalGraphTool } from './local-graph-tool-authority.js'
import { LocalGraphToolCommandReceipts } from './local-graph-tool-command-receipts.js'
import { ObjectStoreJsonToolExecutor } from './object-store-tool.js'

export interface LocalGraphToolPrice {
  readonly pin: GraphToolPin
  readonly currency: string
  /** Fixed operator tariff for this internal operation, never supplied by graph input. */
  readonly costMicrounits: number
}

export interface LocalGraphToolOperationsOptions {
  readonly api: LocalControlApiComposition
  readonly persistence: SqlitePersistenceProvider
  readonly objectStore: ObjectStore
  readonly prices: readonly LocalGraphToolPrice[]
  readonly now?: () => string
}

type RecoveryIdentity = { readonly executionId: string; readonly toolCallId?: string }
type RecoveryCommand = {
  readonly executionId: string
  readonly toolCallId: string
  readonly expectedRevision: number
  readonly action: 'resume' | 'cancel'
}

type RecoveryEvidence = {
  readonly execution: Execution
  readonly attempt: ExecutionAttempt
  readonly command: { readonly callerPrincipalId: string; readonly retentionExpiresAt: string }
  readonly plan: ExecutionPlan
  readonly version: ToolVersion
  readonly request: DurableToolCallRequest
  readonly result: ToolExecutionResult
  readonly deadline: number
  readonly checkpointId: string
  readonly workflowKey?: string
  readonly isCurrentLeaf?: boolean
  readonly artifactState: 'verified' | 'missing' | 'conflict'
}

type RecoveryCallInspection = {
  readonly toolCallId: string
  readonly revision: number
  readonly status: ToolCall['status']
  readonly artifact: { readonly state: RecoveryEvidence['artifactState'] | 'unverifiable' }
  readonly accounting: { readonly charged: boolean; readonly settled: boolean }
  readonly evidence?: RecoveryEvidence
}

/** Accepted-plan authority, persisted approvals and usage around a concrete immutable JSON effect. */
export class LocalGraphToolOperations implements GraphNodeOperationPort {
  readonly #options: LocalGraphToolOperationsOptions
  readonly #now: () => string
  readonly #active = new Map<AbortController, string>()
  readonly #ledger: DurableUsageLedger
  readonly #rateLimiter: ToolRateLimiter
  readonly #commandReceipts: LocalGraphToolCommandReceipts
  readonly #reconciliationLocks = new Map<string, Promise<unknown>>()
  #recoveryRuntime: LocalControlPlaneComposition | undefined

  constructor(options: LocalGraphToolOperationsOptions) {
    for (const price of options.prices) {
      if (
        !Number.isSafeInteger(price.costMicrounits) ||
        price.costMicrounits < 0 ||
        !/^[A-Z]{3}$/.test(price.currency)
      )
        throw new Error('GRAPH_TOOL_PRICE_INVALID')
    }
    this.#options = { ...options, prices: structuredClone(options.prices) }
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#ledger = new DurableUsageLedger({
      store: new SqliteDurableUsageStore(options.persistence),
    })
    this.#commandReceipts = new LocalGraphToolCommandReceipts(options.persistence)
    this.#rateLimiter = new SqliteGraphToolRateLimiter(options.persistence, this.#now)
  }

  bindRecoveryRuntime(composition: LocalControlPlaneComposition): void {
    if (this.#recoveryRuntime !== undefined) throw new Error('TOOL_EFFECT_RECOVERY_ALREADY_BOUND')
    this.#recoveryRuntime = composition
  }

  async invoke(operation: GraphNodeOperation): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController()
    this.#active.set(controller, operation.executionId)
    try {
      const { api, persistence, objectStore } = this.#options
      const registry = new ToolRegistry(
        new SqliteToolRegistryRepository(persistence, operation.workspaceId)
      )
      const authority = await authorizeLocalGraphTool(operation, {
        api,
        registry,
        resolveGraph: (workspaceId, selection) =>
          new GraphDefinitionCatalog(
            new SqliteGraphDefinitionRepository(persistence, workspaceId)
          ).getPinned(selection.reference),
      })
      const { plan, pin, version, command } = authority
      const deadline = Math.min(
        Date.parse(
          authority.execution.deadlineAt ??
            new Date(
              Date.parse(authority.execution.acceptedAt) +
                plan.constraints.limits.duration.maximumMs
            ).toISOString()
        ),
        Date.parse(command.retentionExpiresAt)
      )
      if (Date.parse(this.#now()) >= deadline) throw new Error('GRAPH_TOOL_DEADLINE_EXCEEDED')
      if (
        pin.operation !== 'store-json' ||
        version.executor.type !== 'internal' ||
        version.executor.reference !== 'local.object-store-json.v1' ||
        authority.toolOperation.requiredCapabilities.some(
          (capability) => capability !== 'object-store.write'
        )
      )
        throw new Error('GRAPH_TOOL_BINDING_DENIED')
      const prices = this.#options.prices.filter((price) => isDeepStrictEqual(price.pin, pin))
      if (prices.length !== 1 || prices[0]!.currency !== plan.constraints.limits.budget.currency)
        throw new Error('GRAPH_TOOL_PRICE_MISSING')
      const price = prices[0]!
      const cancelled = await persistence.transaction((transaction) =>
        transaction.get('graph-tool-cancellations', operation.executionId)
      )
      if (cancelled || controller.signal.aborted) throw new Error('GRAPH_TOOL_CANCELLED')
      await new DurableRuntimeBudgetAdmission({
        store: new SqliteDurableUsageStore(persistence),
        commands: api.commandRepository,
      }).authorize({
        execution: authority.execution,
        executionPlan: plan,
        attemptId: operation.attemptId,
      })
      const calls = new SqliteToolCallRepository(persistence, operation.workspaceId)
      const existing = await calls.getByIdempotencyKey(
        operation.workspaceId,
        operation.idempotencyKey
      )
      const requestedAt = existing?.requestedAt ?? this.#now()
      const attemptId = existing?.attemptId ?? operation.attemptId
      const suffix = createHash('sha256')
        .update(operation.idempotencyKey)
        .digest('hex')
        .slice(0, 26)
        .toUpperCase()
      const policySnapshotRef = `policy://${plan.policySnapshot.policyId}/${plan.policySnapshot.version}/${plan.policySnapshot.digest}`
      const request = DurableToolCallRequestSchema.parse({
        requestId: `req_${suffix}`,
        toolCallId: `tlc_${suffix}`,
        executionId: operation.executionId,
        attemptId,
        workspaceId: operation.workspaceId,
        profileId: plan.profile.profileId,
        toolDefinitionId: pin.toolDefinitionId,
        toolVersionId: pin.toolVersionId,
        operation: pin.operation,
        input: operation.input,
        idempotencyKey: operation.idempotencyKey,
        requestedAt,
        policySnapshotRef,
        audit: { principalRef: command.callerPrincipalId, traceId: `trc_${suffix}` },
        grant: {
          workspaceId: operation.workspaceId,
          profileId: plan.profile.profileId,
          toolDefinitionId: pin.toolDefinitionId,
          toolVersionId: pin.toolVersionId,
          operations: [pin.operation],
        },
        ...(authority.requiresApproval
          ? {
              approval: {
                interactionId: `int_${suffix}`,
                allowedPrincipalIds: [command.callerPrincipalId],
                requestedAt,
                expiresAt: new Date(
                  Math.min(
                    Date.parse(requestedAt) + plan.constraints.interaction.approvalExpiryMs,
                    deadline
                  )
                ).toISOString(),
              },
            }
          : {}),
      })
      const source = (stage: string) => ({
        sourceId: request.toolCallId,
        idempotencyKey: `${operation.idempotencyKey}:${stage}`,
      })
      await this.#ledger.reserve({
        workspaceId: operation.workspaceId,
        executionId: operation.executionId,
        attemptId,
        reservationKey: operation.idempotencyKey,
        maximumMicrounits: price.costMicrounits,
        maximumTokens: 0,
        source: source('reserve'),
      })
      const gateway = new ToolGateway(registry)
      gateway.registerExecutor(
        'internal',
        'local.object-store-json.v1',
        new ObjectStoreJsonToolExecutor(objectStore, {
          workspaceId: operation.workspaceId,
          projectId: authority.execution.correlation.projectId,
        })
      )
      const interactions = new InteractionService(api.interactions)
      const approvals = new InteractionToolApprovalCoordinator(interactions, api.interactions)
      const service = new PolicyControlledToolExecutionService({
        gateway,
        calls,
        now: this.#now,
        rateLimiter: this.#rateLimiter,
        authorizer: {
          authorize: async (candidate) => {
            if (
              candidate.toolCallId !== request.toolCallId ||
              candidate.policySnapshotRef !== policySnapshotRef ||
              !toolInputMatchesDigest(operation.input, candidate.inputDigest) ||
              candidate.principalRef !== command.callerPrincipalId
            )
              throw new Error('GRAPH_TOOL_POLICY_MISMATCH')
            return {
              effect: 'allow',
              decisionId: request.toolCallId,
              policyVersion: policySnapshotRef,
              reasonCode: 'ACCEPTED_PLAN_TOOL_GRANT',
              requiresApproval: authority.requiresApproval,
              evaluatedAt: requestedAt,
            }
          },
        },
        approvals: {
          review: async (input) => {
            const stored = await api.interactions.get(input.interactionId)
            if (
              stored?.state === 'pending' &&
              Date.parse(this.#now()) >= Date.parse(stored.expiresAt)
            )
              await interactions.expire(stored.interactionId, this.#now())
            return approvals.review(input)
          },
        },
      })
      try {
        const outcome = await service.execute(request, { signal: controller.signal })
        if (outcome.state === 'awaiting_approval')
          throw new GraphNodeApprovalRequiredError({
            interactionKey: request.approval!.interactionId,
            kind: 'approval',
            payload: { toolCallId: request.toolCallId, node: operation.node, name: operation.name },
          })
        if (outcome.state === 'succeeded') {
          await this.#ledger.charge({
            workspaceId: operation.workspaceId,
            executionId: operation.executionId,
            attemptId,
            reservationKey: operation.idempotencyKey,
            kind: 'tool_charge',
            quantity: { unit: 'calls', value: 1 },
            costMicrounits: price.costMicrounits,
            fundingSource: 'hq_managed',
            source: source('charge'),
          })
          await this.#ledger.settle({
            workspaceId: operation.workspaceId,
            executionId: operation.executionId,
            reservationKey: operation.idempotencyKey,
            source: source('settle'),
          })
          if (
            !outcome.result.output ||
            typeof outcome.result.output !== 'object' ||
            Array.isArray(outcome.result.output)
          )
            throw new Error('GRAPH_TOOL_OUTPUT_INVALID')
          return outcome.result.output
        }
        if (outcome.state === 'in_progress' || outcome.state === 'reconciliation_required')
          throw new GraphNodeEffectUnconfirmedError()
        throw new Error(`GRAPH_TOOL_${outcome.state.toUpperCase()}`)
      } catch (error) {
        if (error instanceof GraphNodeEffectUnconfirmedError) throw error
        // Only persisted terminal no-effect states can release the reservation.
        let call: ToolCall | undefined
        try {
          call = await calls.getByIdempotencyKey(operation.workspaceId, operation.idempotencyKey)
        } catch {
          // Receipt storage is unavailable: absence of an effect cannot be established.
          throw new GraphNodeEffectUnconfirmedError()
        }
        if (call && ['executing', 'reconciliation_required', 'succeeded'].includes(call.status))
          throw new GraphNodeEffectUnconfirmedError()
        if (call && ['failed', 'denied'].includes(call.status)) {
          try {
            await this.#ledger.settle({
              workspaceId: operation.workspaceId,
              executionId: operation.executionId,
              reservationKey: operation.idempotencyKey,
              source: source('settle'),
            })
          } catch {
            throw new GraphNodeEffectUnconfirmedError()
          }
        }
        throw error
      }
    } finally {
      this.#active.delete(controller)
    }
  }

  async inspect(envelopeValue: unknown, principal: ServicePrincipal): Promise<unknown> {
    const envelope = envelopeValue as ReadRequestEnvelope
    if (envelope.operation !== 'execution.tool-effect.inspect')
      throw new Error('TOOL_EFFECT_INSPECTION_INVALID')
    const identity = parseRecoveryIdentity(envelope.parameters)
    this.#assertInspectionScope(envelope, principal)
    const execution = await this.#options.api.executions.getExecution(identity.executionId)
    if (
      !execution ||
      execution.correlation.workspaceId !== envelope.workspaceId ||
      execution.correlation.projectId !== envelope.projectId
    )
      throw new Error('TOOL_EFFECT_SCOPE_REJECTED')
    const calls = new SqliteToolCallRepository(
      this.#options.persistence,
      execution.correlation.workspaceId
    )
    const selected =
      identity.toolCallId === undefined
        ? (await calls.listByExecution(execution.executionId)).slice(0, 64)
        : await this.#getExecutionCall(
            calls,
            identity.toolCallId,
            execution.executionId,
            execution.correlation.workspaceId
          )
    const inspections = await Promise.all(selected.map((call) => this.#inspectCall(call)))
    return {
      executionId: execution.executionId,
      workspaceId: execution.correlation.workspaceId,
      projectId: execution.correlation.projectId,
      calls: inspections,
    }
  }

  async reconcile(envelopeValue: unknown, principal: ServicePrincipal): Promise<unknown> {
    const envelope = envelopeValue as StateChangingCommandEnvelope
    if (envelope.operation !== 'execution.tool-effect.reconcile')
      throw new Error('TOOL_EFFECT_RECONCILIATION_INVALID')
    const command = parseRecoveryCommand(envelope.payload)
    this.#assertInspectionScope(envelope, principal)
    if (envelope.payloadHash !== sha256(canonicalJsonStringify(envelope.payload)))
      throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
    const receiptCommand = {
      callerPrincipalId: principal.principalId,
      workspaceId: envelope.workspaceId,
      projectId: envelope.projectId!,
      operation: 'execution.tool-effect.reconcile' as const,
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      contractVersion: envelope.contractVersion,
      correlation: envelope.correlation,
      ...(envelope.requestId === undefined ? {} : { requestId: envelope.requestId }),
      ...(envelope.issuedAt === undefined ? {} : { issuedAt: envelope.issuedAt }),
      payloadHash: envelope.payloadHash,
      payload: envelope.payload,
    }
    const lockKey = canonicalJsonStringify([
      receiptCommand.callerPrincipalId,
      receiptCommand.workspaceId,
      receiptCommand.operation,
      receiptCommand.idempotencyKey,
    ])
    return await this.#serializeReconciliation(lockKey, async () => {
      const claim = await this.#commandReceipts.claim(receiptCommand, this.#now())
      if (claim.state !== 'owned') return claim.response
      const accepted = claim.receipt.command
      const acceptedRequestId = accepted.requestId ?? envelope.requestId
      const acceptedEnvelope: StateChangingCommandEnvelope = {
        ...envelope,
        caller: { servicePrincipalId: accepted.callerPrincipalId },
        contractVersion: accepted.contractVersion ?? envelope.contractVersion,
        correlation: accepted.correlation ?? envelope.correlation,
        ...(acceptedRequestId === undefined
          ? {}
          : { requestId: IdentifierSchemas.requestId.parse(acceptedRequestId) }),
        workspaceId: IdentifierSchemas.workspaceId.parse(accepted.workspaceId),
        projectId: IdentifierSchemas.projectId.parse(accepted.projectId),
        commandId: IdentifierSchemas.commandId.parse(accepted.commandId),
        idempotencyKey: accepted.idempotencyKey,
        payloadHash: accepted.payloadHash,
        operation: accepted.operation,
        issuedAt: accepted.issuedAt ?? envelope.issuedAt,
        payload: accepted.payload,
      }
      let completed = false
      try {
        const enqueuedResponse = await this.#existingRecoveryResponse(claim.receipt.intent, command)
        if (enqueuedResponse !== undefined) {
          const response = await this.#commandReceipts.complete(
            claim,
            enqueuedResponse,
            this.#now()
          )
          completed = true
          return response
        }
        const result = await this.#reconcileCommand(
          acceptedEnvelope,
          principal,
          command,
          claim.receipt.intent,
          async (intent) => this.#commandReceipts.saveIntent(claim, intent, this.#now())
        )
        const response = await this.#commandReceipts.complete(claim, result, this.#now())
        completed = true
        return response
      } finally {
        if (!completed)
          await this.#commandReceipts.release(claim, this.#now()).catch(() => undefined)
      }
    })
  }

  async #serializeReconciliation<Result>(
    key: string,
    operation: () => Promise<Result>
  ): Promise<Result> {
    const previous = this.#reconciliationLocks.get(key)
    const pending = (
      previous === undefined ? Promise.resolve() : previous.catch(() => undefined)
    ).then(operation) as Promise<Result>
    this.#reconciliationLocks.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.#reconciliationLocks.get(key) === pending) this.#reconciliationLocks.delete(key)
    }
  }

  async #existingRecoveryResponse(
    intentValue: unknown,
    command: RecoveryCommand
  ): Promise<unknown | undefined> {
    if (!isJsonObject(intentValue) || intentValue['kind'] !== 'resume') return undefined
    const executionId = IdentifierSchemas.executionId.safeParse(intentValue['executionId'])
    const toolCallId = IdentifierSchemas.toolCallId.safeParse(intentValue['toolCallId'])
    const recoveryId = intentValue['recoveryId']
    const workflowKey = intentValue['workflowKey']
    const checkpointId = intentValue['checkpointId']
    const workspaceId = intentValue['workspaceId']
    const parentWorkflowKey = intentValue['parentWorkflowKey']
    const inputDigest = intentValue['inputDigest']
    const recoveryDigest = intentValue['recoveryDigest']
    const response = intentValue['response']
    if (
      !executionId.success ||
      !toolCallId.success ||
      executionId.data !== command.executionId ||
      toolCallId.data !== command.toolCallId ||
      typeof recoveryId !== 'string' ||
      typeof workflowKey !== 'string' ||
      typeof checkpointId !== 'string' ||
      typeof workspaceId !== 'string' ||
      (parentWorkflowKey !== undefined && typeof parentWorkflowKey !== 'string') ||
      typeof inputDigest !== 'string' ||
      typeof recoveryDigest !== 'string' ||
      !isJsonObject(response) ||
      response['outcome'] !== 'recovery_scheduled' ||
      workflowKey !== `${executionId.data}:graph-recovery:${recoveryId}`
    )
      throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
    const runtime = this.#recoveryRuntime
    const job = await runtime?.workflowJobs?.get(workflowKey)
    if (job === undefined) return undefined
    const input = ExecutionWorkflowInputSchema.safeParse(job.input)
    const recovery = {
      recoveryId,
      checkpointId,
      ...(parentWorkflowKey === undefined ? {} : { parentWorkflowKey }),
    }
    if (
      job.workflowKey !== workflowKey ||
      !input.success ||
      input.data.executionId !== executionId.data ||
      input.data.graph?.workspaceId !== workspaceId ||
      !isJsonObject(job.recovery) ||
      sha256(canonicalJsonStringify(input.data)) !== inputDigest ||
      sha256(canonicalJsonStringify(job.recovery)) !== recoveryDigest ||
      !isDeepStrictEqual(job.recovery, recovery) ||
      response['executionId'] !== executionId.data ||
      response['toolCallId'] !== toolCallId.data ||
      response['workflowKey'] !== workflowKey
    )
      throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
    return response
  }

  async #reconcileCommand(
    envelope: StateChangingCommandEnvelope,
    principal: ServicePrincipal,
    command: RecoveryCommand,
    existingIntent: unknown,
    persistIntent: (intent: unknown) => Promise<unknown>
  ): Promise<unknown> {
    const inspection = await this.inspect(
      {
        ...envelope,
        operation: 'execution.tool-effect.inspect',
        parameters: {
          executionId: command.executionId,
          toolCallId: command.toolCallId,
        },
      },
      principal
    )
    const entry = (inspection as { calls: RecoveryCallInspection[] }).calls[0]
    if (!entry || entry.toolCallId !== command.toolCallId)
      throw new Error('TOOL_EFFECT_CALL_MISSING')
    const call = await new SqliteToolCallRepository(
      this.#options.persistence,
      envelope.workspaceId
    ).get(command.toolCallId)
    if (!call) throw new Error('TOOL_EFFECT_CALL_MISSING')
    if (call.revision !== command.expectedRevision) {
      if (call.status !== 'succeeded' || entry.artifact.state !== 'verified')
        throw new Error('TOOL_EFFECT_STALE_REVISION')
    }
    if (command.action === 'cancel') {
      const execution = await this.#options.api.executions.getExecution(command.executionId)
      if (!execution) throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
      if (['completed', 'failed', 'cancelled', 'timed_out'].includes(execution.state)) {
        if (entry.artifact.state === 'verified' && entry.evidence !== undefined) {
          const recovered = await this.#commitKnownSuccess(call, entry.evidence, call.revision)
          if (recovered === undefined) return { outcome: 'held', reason: 'accounting_unconfirmed' }
          const accounting = await this.#repairAccounting(recovered)
          if (!accounting.charged || !accounting.settled)
            return { outcome: 'held', reason: 'accounting_unconfirmed' }
        }
        return { outcome: 'held', reason: 'execution_terminal' }
      }
      const cancelIntent = {
        schemaVersion: 1,
        kind: 'cancel',
        executionId: command.executionId,
        toolCallId: command.toolCallId,
        response: { outcome: 'cancelled', executionId: command.executionId },
      }
      if (existingIntent === undefined) await persistIntent(cancelIntent)
      else assertReconciliationIntent(existingIntent, cancelIntent)
      if (entry.artifact.state === 'verified' && entry.evidence !== undefined) {
        const recovered = await this.#commitKnownSuccess(call, entry.evidence, call.revision)
        if (recovered !== undefined) {
          const accounting = await this.#repairAccounting(recovered)
          if (!accounting.charged || !accounting.settled)
            return { outcome: 'held', reason: 'accounting_unconfirmed' }
        }
      }
      const confirmed = await this.cancel(
        command.executionId,
        `graph:${command.executionId}`,
        `operator-cancel:${envelope.commandId}`
      )
      if (!confirmed) return { outcome: 'held', reason: 'effect_or_accounting_unconfirmed' }
      const runtime = this.#recoveryRuntime
      if (!runtime) throw new Error('TOOL_EFFECT_RECOVERY_NOT_CONFIGURED')
      await this.#signalWorkflowCancellation(envelope, command.executionId)
      await runtime.executionLifecycleActivities.persistStatus({
        executionId: command.executionId,
        attemptId: call.attemptId,
        state: 'cancelled',
        effectKey: `tool-effect-recovery:cancel:${envelope.commandId}`,
      })
      return { outcome: 'cancelled', executionId: command.executionId }
    }
    if (entry.artifact.state !== 'verified' || entry.evidence === undefined)
      return { outcome: 'held', reason: entry.artifact.state }
    const runtime = this.#recoveryRuntime
    if (!runtime) throw new Error('TOOL_EFFECT_RECOVERY_NOT_CONFIGURED')
    if (runtime.durableExecution !== 'embedded-sqlite' || !runtime.workflowDispatcher)
      throw new Error('TOOL_EFFECT_RECOVERY_UNSUPPORTED')
    const evidence = entry.evidence
    const cancellation = await this.#options.persistence.transaction((transaction) =>
      transaction.get('graph-tool-cancellations', evidence.execution.executionId)
    )
    const deadlineOpen = Date.parse(this.#now()) < evidence.deadline
    const currentLeaf = evidence.workflowKey === undefined || evidence.isCurrentLeaf === true
    const authorityCurrent =
      evidence.execution.state === 'reconciliation_required' &&
      evidence.attempt.state === 'reconciliation_required' &&
      (evidence.version.lifecycle === 'published' || evidence.version.lifecycle === 'deprecated')
    const intentAllowsContinuation =
      existingIntent === undefined ||
      (isJsonObject(existingIntent) && typeof existingIntent['workflowKey'] === 'string')
    const canContinue =
      cancellation === undefined &&
      currentLeaf &&
      authorityCurrent &&
      deadlineOpen &&
      intentAllowsContinuation
    const plan = canContinue ? recoveryPlan(call, evidence) : undefined
    const intent = plan?.intent ?? {
      schemaVersion: 1,
      kind: 'resume',
      executionId: command.executionId,
      toolCallId: command.toolCallId,
      checkpointId: evidence.checkpointId,
      ...(evidence.workflowKey === undefined ? {} : { parentWorkflowKey: evidence.workflowKey }),
      deadlineAt: new Date(evidence.deadline).toISOString(),
      response: { outcome: 'accounted_awaiting_cancel', toolCallId: call.toolCallId },
    }
    if (existingIntent === undefined) await persistIntent(intent)
    else assertReconciliationIntent(existingIntent, intent)

    const recovered = await this.#commitKnownSuccess(call, evidence, command.expectedRevision)
    if (!recovered) throw new Error('TOOL_EFFECT_STALE_REVISION')
    const accounting = await this.#repairAccounting(recovered)
    if (!accounting.charged || !accounting.settled)
      return { outcome: 'held', reason: 'accounting_unconfirmed' }
    if (!canContinue) {
      if (!currentLeaf) return { outcome: 'held', reason: 'recovery_checkpoint_advanced' }
      return { outcome: 'accounted_awaiting_cancel', toolCallId: call.toolCallId }
    }
    if (existingIntent !== undefined && isJsonObject(existingIntent)) {
      if (existingIntent['workflowKey'] === undefined)
        return (
          existingIntent['response'] ?? {
            outcome: 'accounted_awaiting_cancel',
            toolCallId: call.toolCallId,
          }
        )
      if (existingIntent['workflowKey'] !== plan?.intent.workflowKey)
        throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
    }
    if (plan === undefined) throw new Error('TOOL_EFFECT_RECOVERY_PLAN_MISSING')
    await runtime.workflowDispatcher.submitRecovery(plan.input, plan.recovery)
    return plan.intent.response
  }

  async #signalWorkflowCancellation(
    envelope: StateChangingCommandEnvelope,
    executionId: string
  ): Promise<void> {
    const accepted = await this.#options.api.commandRepository.getByExecutionId(executionId)
    if (!accepted) throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
    const payload = { executionId }
    const request = ExecutionCancellationCommandSchema.parse({
      caller: { servicePrincipalId: accepted.callerPrincipalId },
      contractVersion: envelope.contractVersion,
      requestId: envelope.requestId,
      workspaceId: accepted.workspaceId,
      projectId: accepted.projectId,
      correlation: envelope.correlation,
      commandId: envelope.commandId,
      idempotencyKey: envelope.idempotencyKey,
      payloadHash: sha256(canonicalJsonStringify(payload)),
      operation: 'execution.cancel',
      issuedAt: this.#now(),
      payload,
    })
    await this.#options.api.executionCancellationService.cancel(request, accepted.callerPrincipalId)
  }

  #assertInspectionScope(
    envelope: Pick<ReadRequestEnvelope, 'workspaceId' | 'projectId' | 'caller'>,
    principal: ServicePrincipal
  ): void {
    if (
      !principal.workspaceIds.includes(envelope.workspaceId) ||
      envelope.projectId === undefined ||
      !principal.projectIds.includes(envelope.projectId) ||
      (envelope.caller !== undefined &&
        envelope.caller.servicePrincipalId !== principal.principalId)
    )
      throw new Error('TOOL_EFFECT_SCOPE_REJECTED')
  }

  async #getExecutionCall(
    calls: SqliteToolCallRepository,
    toolCallId: string,
    executionId: string,
    workspaceId: string
  ): Promise<readonly ToolCall[]> {
    const call = await calls.get(toolCallId)
    if (!call || call.executionId !== executionId || call.workspaceId !== workspaceId)
      throw new Error('TOOL_EFFECT_CALL_MISSING')
    return [call]
  }

  async #inspectCall(call: ToolCall): Promise<RecoveryCallInspection> {
    const accounting = await this.#accountingState(call)
    const evidence = await this.#resolveEvidence(call).catch(() => {
      return undefined
    })
    const artifact = evidence?.artifactState ?? 'unverifiable'
    const inspection: RecoveryCallInspection = {
      toolCallId: call.toolCallId,
      revision: call.revision,
      status: call.status,
      artifact: { state: artifact },
      accounting,
    }
    if (evidence?.artifactState === 'verified')
      Object.defineProperty(inspection, 'evidence', { value: evidence, enumerable: false })
    return inspection
  }

  async #resolveEvidence(call: ToolCall): Promise<RecoveryEvidence> {
    if (!call.idempotencyKey.startsWith('graph-op-v1:'))
      throw new Error('TOOL_EFFECT_NOT_LOCAL_GRAPH')
    const { api, persistence, objectStore } = this.#options
    const execution = await api.executions.getExecution(call.executionId)
    const attempt = await api.executions.getAttempt(call.attemptId)
    const command = await api.commandRepository.getByExecutionId(call.executionId)
    if (
      !execution ||
      !attempt ||
      !command ||
      execution.latestAttemptId !== call.attemptId ||
      command.workspaceId !== call.workspaceId ||
      execution.correlation.workspaceId !== call.workspaceId
    )
      throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
    const storedPlan = await api.executionPlans.get(execution.executionPlan)
    if (!storedPlan) throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
    const plan = assertExecutionPlanIntegrity(storedPlan)
    if (!plan.graph || !isDeepStrictEqual(command.executionPlan, execution.executionPlan))
      throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
    const graph = await new GraphDefinitionCatalog(
      new SqliteGraphDefinitionRepository(persistence, call.workspaceId)
    ).getPinned(plan.graph.reference)
    if (!isDeepStrictEqual(graph.reference, plan.graph.reference))
      throw new Error('TOOL_EFFECT_PIN_MISMATCH')
    if (
      !isDeepStrictEqual(call.executor, {
        type: 'internal',
        reference: 'local.object-store-json.v1',
      })
    )
      throw new Error('TOOL_EFFECT_PIN_MISMATCH')
    const registry = new ToolRegistry(
      new SqliteToolRegistryRepository(persistence, call.workspaceId)
    )
    const version = await registry.readVersion(call.toolVersionId, call.workspaceId)
    if (
      version.toolDefinitionId !== call.toolDefinitionId ||
      version.executor.type !== 'internal' ||
      version.executor.reference !== 'local.object-store-json.v1'
    )
      throw new Error('TOOL_EFFECT_PIN_MISMATCH')
    const pinnedNodes: {
      node: (typeof graph.content.nodes)[number]
      pin: GraphToolPin
    }[] = []
    for (const node of graph.content.nodes) {
      const operation = node.operation
      if (operation.kind !== 'tool' || operation.toolPin === undefined) continue
      const pin = operation.toolPin
      if (
        pin.toolDefinitionId === call.toolDefinitionId &&
        pin.toolVersionId === call.toolVersionId &&
        pin.contentDigest === version.contentDigest &&
        pin.operation === call.operation
      )
        pinnedNodes.push({ node, pin })
    }
    if (pinnedNodes.length === 0) throw new Error('TOOL_EFFECT_PIN_MISMATCH')
    const threadId = `graph:${execution.executionId}`
    const checkpointSaver = new LangGraphSqliteCheckpointSaver(persistence, 'managed-graphs')
    const jobSnapshot = await this.#recoveryRuntime?.workflowJobs?.getExecutionGraphJobsSnapshot(
      execution.executionId
    )
    const hasRootJob = jobSnapshot?.some(({ job }) => job.workflowKey === execution.executionId)
    let lineage: RecoveryJobLineage | undefined
    if (jobSnapshot !== undefined && jobSnapshot.length > 0) {
      if (!hasRootJob) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
      lineage = validateRecoveryJobLineage(jobSnapshot, {
        execution,
        attempt,
        plan,
        workspaceId: call.workspaceId,
      })
    }
    const checkpointSources = new Map<
      string | undefined,
      { readonly workflowKey?: string; readonly isCurrentLeaf?: boolean }
    >()
    if (lineage !== undefined) {
      for (const job of lineage.jobs) {
        const checkpointId = job.outcome?.graphCheckpointId
        if (checkpointId === undefined) continue
        checkpointSources.set(checkpointId, {
          workflowKey: job.workflowKey,
          isCurrentLeaf:
            job.workflowKey === lineage.leaf.workflowKey &&
            checkpointId === lineage.leaf.outcome?.graphCheckpointId,
        })
      }
      if (checkpointSources.size === 0) throw new Error('TOOL_EFFECT_CHECKPOINT_MISSING')
    } else {
      // Compatibility is limited to invocations with no exact-execution journal rows.
      checkpointSources.set(undefined, {})
    }
    const threadKey = `${call.workspaceId}:${execution.executionId}:${threadId}`
    const matchingCandidates: {
      node: (typeof graph.content.nodes)[number]
      pin: GraphToolPin
      checkpointId: string
      workflowKey?: string
      isCurrentLeaf?: boolean
      input: Record<string, unknown>
    }[] = []
    for (const [checkpointId, source] of checkpointSources) {
      const tuple = await checkpointSaver.getTuple({
        configurable: {
          thread_id: threadKey,
          ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId }),
        },
      })
      if (!tuple) throw new Error('TOOL_EFFECT_CHECKPOINT_MISSING')
      if (
        tuple.config.configurable?.['thread_id'] !== threadKey ||
        tuple.config.configurable?.['checkpoint_id'] !== tuple.checkpoint.id ||
        (checkpointId !== undefined && tuple.checkpoint.id !== checkpointId)
      )
        throw new Error('TOOL_EFFECT_CHECKPOINT_MISMATCH')
      const checkpointStep = tuple.metadata?.step
      if (
        typeof checkpointStep !== 'number' ||
        !Number.isSafeInteger(checkpointStep) ||
        checkpointStep < -1
      )
        throw new Error('TOOL_EFFECT_CHECKPOINT_MISMATCH')
      const visitOrdinal = checkpointStep + 1
      if (!Number.isSafeInteger(visitOrdinal) || visitOrdinal < 0)
        throw new Error('TOOL_EFFECT_CHECKPOINT_MISMATCH')
      const channels = tuple.checkpoint.channel_values as Record<string, unknown>
      const values = isJsonObject(channels['values']) ? channels['values'] : {}
      for (const { node, pin } of pinnedNodes) {
        const idempotencyKey = graphOperationIdempotencyKeyFor({
          workspaceId: call.workspaceId,
          executionId: execution.executionId,
          threadId,
          graph: graph.reference,
          node: node.node,
          visitOrdinal,
        })
        if (idempotencyKey !== call.idempotencyKey) continue
        const matchingInputs = [values, channels['input']].filter(
          (candidate): candidate is Record<string, unknown> =>
            isJsonObject(candidate) && toolInputMatchesDigest(candidate, call.inputDigest)
        )
        const distinctInputs = new Map(
          matchingInputs.map((candidate) => [canonicalJsonStringify(candidate), candidate])
        )
        if (distinctInputs.size !== 1) throw new Error('TOOL_EFFECT_CHECKPOINT_MISMATCH')
        matchingCandidates.push({
          node,
          pin,
          checkpointId: tuple.checkpoint.id,
          ...(source.workflowKey === undefined ? {} : { workflowKey: source.workflowKey }),
          ...(source.isCurrentLeaf === undefined ? {} : { isCurrentLeaf: source.isCurrentLeaf }),
          input: [...distinctInputs.values()][0]!,
        })
      }
    }
    const candidates =
      lineage !== undefined &&
      (call.status === 'executing' || call.status === 'reconciliation_required')
        ? matchingCandidates.filter(
            (candidate) =>
              candidate.isCurrentLeaf === true && candidate.workflowKey === lineage.leaf.workflowKey
          )
        : matchingCandidates
    if (candidates.length !== 1) throw new Error('TOOL_EFFECT_CHECKPOINT_MISMATCH')
    const selectedCandidate = candidates[0]!
    const { node, pin, input } = selectedCandidate
    const suffix = createHash('sha256')
      .update(call.idempotencyKey)
      .digest('hex')
      .slice(0, 26)
      .toUpperCase()
    const request = DurableToolCallRequestSchema.parse({
      requestId: `req_${suffix}`,
      toolCallId: `tlc_${suffix}`,
      executionId: execution.executionId,
      attemptId: call.attemptId,
      workspaceId: call.workspaceId,
      profileId: plan.profile.profileId,
      toolDefinitionId: pin.toolDefinitionId,
      toolVersionId: pin.toolVersionId,
      operation: pin.operation,
      input,
      grant: {
        workspaceId: call.workspaceId,
        profileId: plan.profile.profileId,
        toolDefinitionId: pin.toolDefinitionId,
        toolVersionId: pin.toolVersionId,
        operations: [pin.operation],
      },
      audit: { principalRef: command.callerPrincipalId, traceId: `trc_${suffix}` },
      idempotencyKey: call.idempotencyKey,
      requestedAt: call.requestedAt,
      policySnapshotRef: call.policySnapshotRef,
    })
    if (
      request.toolCallId !== call.toolCallId ||
      request.requestId !== `req_${suffix}` ||
      call.principalRef !== command.callerPrincipalId ||
      ![toolRequestDigest(request), toolRequestDigestLegacy(request)].includes(call.requestDigest)
    )
      throw new Error('TOOL_EFFECT_REQUEST_MISMATCH')
    const operation = GraphNodeOperationSchema.parse({
      executionId: execution.executionId,
      attemptId: call.attemptId,
      workspaceId: call.workspaceId,
      workflowId: `wfl_${execution.executionId.slice(4)}`,
      threadId,
      node: node.node,
      kind: 'tool' as const,
      name: node.operation.name,
      input,
      idempotencyKey: call.idempotencyKey,
      toolPin: pin,
    })
    const authority = await authorizeLocalGraphTool(operation, {
      api,
      registry,
      historicalVerification: true,
      resolveGraph: (workspaceId, selection) =>
        new GraphDefinitionCatalog(
          new SqliteGraphDefinitionRepository(persistence, workspaceId)
        ).getPinned(selection.reference),
    })
    if (authority.version.toolDefinitionId !== call.toolDefinitionId)
      throw new Error('TOOL_EFFECT_AUTHORITY_MISMATCH')
    const body = new TextEncoder().encode(canonicalJsonStringify(input))
    const contentDigest = sha256Bytes(body)
    const artifactRef = `art_${createHash('sha256')
      .update(canonicalJsonStringify([call.workspaceId, execution.executionId, request.requestId]))
      .digest('hex')
      .slice(0, 26)
      .toUpperCase()}`
    const expectedOutput = { artifactRef, contentDigest, size: body.byteLength }
    let artifactState: RecoveryEvidence['artifactState'] = 'missing'
    try {
      const object = await objectStore.get(artifactRef)
      const metadata = object.metadata
      const matches =
        object.key === artifactRef &&
        object.size === body.byteLength &&
        object.contentType === 'application/json' &&
        object.sha256 === contentDigest &&
        sha256Bytes(object.body) === contentDigest &&
        Buffer.from(object.body).equals(Buffer.from(body)) &&
        metadata['workspace'] === call.workspaceId &&
        metadata['workspace-id'] === call.workspaceId &&
        metadata['project-id'] === execution.correlation.projectId &&
        metadata['execution'] === execution.executionId &&
        metadata['execution-id'] === execution.executionId &&
        metadata['sensitivity'] === 'internal' &&
        metadata['artifact-state'] === undefined
      artifactState = matches ? 'verified' : 'conflict'
    } catch {
      artifactState = 'missing'
    }
    const result = ToolExecutionResultSchema.parse({
      toolDefinitionId: pin.toolDefinitionId,
      toolVersionId: pin.toolVersionId,
      operation: pin.operation,
      output: expectedOutput,
      artifactRefs: call.result?.artifactRefs ?? [],
      executor: version.executor,
      attempts: call.result?.attempts ?? 1,
      audit: {
        principalRef: command.callerPrincipalId,
        traceId: `trc_${suffix}`,
        contentDigest: toolExecutionContentDigest({
          requestId: request.requestId,
          toolVersionId: pin.toolVersionId,
          operation: pin.operation,
          input,
          output: expectedOutput,
        }),
      },
    })
    if (call.result !== undefined && !isDeepStrictEqual(call.result, result)) {
      const legacyResult = {
        ...result,
        audit: {
          ...result.audit,
          contentDigest: toolExecutionContentDigestLegacy({
            requestId: request.requestId,
            toolVersionId: pin.toolVersionId,
            operation: pin.operation,
            input,
            output: expectedOutput,
          }),
        },
      }
      if (!isDeepStrictEqual(call.result, legacyResult)) artifactState = 'conflict'
    }
    return {
      execution,
      attempt,
      command,
      plan,
      version,
      request,
      result,
      deadline: Math.min(
        Date.parse(
          execution.deadlineAt ??
            new Date(
              Date.parse(execution.acceptedAt) + plan.constraints.limits.duration.maximumMs
            ).toISOString()
        ),
        Date.parse(command.retentionExpiresAt)
      ),
      checkpointId: selectedCandidate.checkpointId,
      ...(selectedCandidate.workflowKey === undefined
        ? {}
        : { workflowKey: selectedCandidate.workflowKey }),
      ...(selectedCandidate.isCurrentLeaf === undefined
        ? {}
        : { isCurrentLeaf: selectedCandidate.isCurrentLeaf }),
      artifactState,
    }
  }

  async #commitKnownSuccess(
    call: ToolCall,
    evidence: RecoveryEvidence,
    expectedRevision: number
  ): Promise<(RecoveryEvidence & { call: ToolCall }) | undefined> {
    if (evidence.artifactState !== 'verified') return undefined
    if (call.status === 'succeeded') {
      if (!call.result || !isDeepStrictEqual(call.result.output, evidence.result.output))
        throw new Error('TOOL_EFFECT_RESULT_CONFLICT')
      return { ...evidence, call }
    }
    if (!['executing', 'reconciliation_required'].includes(call.status))
      throw new Error('TOOL_EFFECT_STATE_CONFLICT')
    if (call.revision !== expectedRevision) return undefined
    const at = this.#now()
    const next: ToolCall = {
      ...call,
      revision: call.revision + 1,
      status: 'succeeded',
      result: evidence.result,
      completedAt: at,
      history: [...call.history, { status: 'succeeded', at }],
    }
    const repository = new SqliteToolCallRepository(this.#options.persistence, call.workspaceId)
    if (!(await repository.compareAndSet(call.revision, next))) {
      const latest = await repository.get(call.toolCallId)
      if (
        latest?.status === 'succeeded' &&
        latest.result &&
        isDeepStrictEqual(latest.result.output, evidence.result.output)
      )
        return { ...evidence, call: latest }
      return undefined
    }
    return { ...evidence, call: next }
  }

  async #accountingState(call: ToolCall): Promise<{ charged: boolean; settled: boolean }> {
    return new SqliteDurableUsageStore(this.#options.persistence).transaction(
      call.workspaceId,
      async (transaction) => ({
        charged: (await transaction.getEffect(`${call.idempotencyKey}:charge`)) !== undefined,
        settled: (await transaction.getEffect(`${call.idempotencyKey}:settle`)) !== undefined,
      })
    )
  }

  async #repairAccounting(
    evidence: RecoveryEvidence & { call: ToolCall }
  ): Promise<{ charged: boolean; settled: boolean }> {
    const { call, execution, plan } = evidence
    const prices = this.#options.prices.filter(
      (price) =>
        price.pin.toolDefinitionId === call.toolDefinitionId &&
        price.pin.toolVersionId === call.toolVersionId &&
        price.pin.contentDigest === evidence.version.contentDigest &&
        price.pin.operation === call.operation
    )
    if (prices.length !== 1 || prices[0]!.currency !== plan.constraints.limits.budget.currency)
      throw new Error('TOOL_EFFECT_PRICE_UNAVAILABLE')
    const store = new SqliteDurableUsageStore(this.#options.persistence)
    const budget = await store.transaction(call.workspaceId, (transaction) =>
      transaction.getBudget(execution.executionId)
    )
    const reservation = budget?.reservations.find(
      ({ reservationKey }) => reservationKey === call.idempotencyKey
    )
    if (
      !reservation ||
      (reservation.attemptId !== undefined && reservation.attemptId !== call.attemptId)
    )
      throw new Error('TOOL_EFFECT_RESERVATION_MISSING')
    const ledger = new DurableUsageLedger({ store, now: this.#now })
    const source = (stage: string) => ({
      sourceId: call.toolCallId,
      idempotencyKey: `${call.idempotencyKey}:${stage}`,
    })
    // Always replay both idempotent ledger operations. Their stored effect
    // fingerprints validate that existing receipts represent this exact
    // tariff and settlement instead of treating any matching key as proof.
    await ledger.charge({
      workspaceId: call.workspaceId,
      executionId: call.executionId,
      attemptId: call.attemptId,
      reservationKey: call.idempotencyKey,
      kind: 'tool_charge',
      quantity: { unit: 'calls', value: 1 },
      costMicrounits: prices[0]!.costMicrounits,
      fundingSource: 'hq_managed',
      source: source('charge'),
    })
    await ledger.settle({
      workspaceId: call.workspaceId,
      executionId: call.executionId,
      reservationKey: call.idempotencyKey,
      source: source('settle'),
    })
    return this.#accountingState(call)
  }

  async cancel(executionId: string, threadId: string, idempotencyKey: string): Promise<boolean> {
    IdentifierSchemas.executionId.parse(executionId)
    if (threadId !== `graph:${executionId}`) throw new Error('GRAPH_TOOL_THREAD_MISMATCH')
    const { api, persistence } = this.#options
    // Intent survives crashes and precedes every future delivery.
    await persistence.transaction(async (transaction) => {
      if (!(await transaction.get('graph-tool-cancellations', executionId)))
        await transaction.put({
          namespace: 'graph-tool-cancellations',
          id: executionId,
          value: { threadId, idempotencyKey },
        })
    })
    for (const [controller, activeExecutionId] of this.#active)
      if (activeExecutionId === executionId) controller.abort()
    const execution = await api.executions.getExecution(executionId)
    if (!execution) return false
    const calls = new SqliteToolCallRepository(persistence, execution.correlation.workspaceId)
    let confirmed = true
    for (const call of await calls.listByExecution(executionId)) {
      if (!call.idempotencyKey.startsWith('graph-op-v1:')) continue
      if (call.status === 'executing' || call.status === 'reconciliation_required') {
        confirmed = false
        continue
      }
      if (call.status === 'succeeded') {
        const accounted = await new SqliteDurableUsageStore(persistence).transaction(
          call.workspaceId,
          async (transaction) =>
            (await transaction.getEffect(`${call.idempotencyKey}:charge`)) !== undefined &&
            (await transaction.getEffect(`${call.idempotencyKey}:settle`)) !== undefined
        )
        if (!accounted) confirmed = false
        continue
      }
      if (['requested', 'awaiting_approval', 'authorized'].includes(call.status)) {
        const at = this.#now()
        const next: ToolCall = {
          ...call,
          revision: call.revision + 1,
          status: 'denied',
          errorCode: 'GRAPH_TOOL_CANCELLED',
          completedAt: at,
          history: [...call.history, { status: 'denied', at, reasonCode: 'GRAPH_TOOL_CANCELLED' }],
        }
        if (!(await calls.compareAndSet(call.revision, next))) {
          confirmed = false
          continue
        }
      }
      // A previous cancellation may have committed denial before settlement failed.
      if (
        ['requested', 'awaiting_approval', 'authorized', 'failed', 'denied'].includes(call.status)
      ) {
        try {
          if (call.approvalInteractionId)
            await new InteractionService(api.interactions).resolveTerminal(
              call.approvalInteractionId,
              this.#now()
            )
          await this.#ledger.settle({
            workspaceId: call.workspaceId,
            executionId,
            reservationKey: call.idempotencyKey,
            source: { sourceId: call.toolCallId, idempotencyKey: `${call.idempotencyKey}:settle` },
          })
        } catch {
          confirmed = false
        }
      }
    }
    return confirmed
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256Bytes(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

type RecoveryJobLineage = {
  readonly jobs: readonly WorkflowJobRecord[]
  readonly leaf: WorkflowJobRecord
}

function validateRecoveryJobLineage(
  snapshot: readonly { readonly revision: number; readonly job: WorkflowJobRecord }[],
  authority: {
    readonly execution: Execution
    readonly attempt: ExecutionAttempt
    readonly plan: ExecutionPlan
    readonly workspaceId: string
  }
): RecoveryJobLineage {
  const { execution, attempt, plan, workspaceId } = authority
  const rootKey = execution.executionId
  const recoveryPrefix = `${rootKey}:graph-recovery:`
  const jobsByKey = new Map<string, WorkflowJobRecord>()
  const inputsByKey = new Map<string, ReturnType<typeof ExecutionWorkflowInputSchema.parse>>()
  const roots = snapshot.filter(({ job }) => job.workflowKey === rootKey)
  if (roots.length !== 1) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
  const root = roots[0]!.job

  for (const { job } of snapshot) {
    if (jobsByKey.has(job.workflowKey)) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    if (job.workflowKey === rootKey) {
      if (job.recovery !== undefined) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    } else if (
      !job.workflowKey.startsWith(recoveryPrefix) ||
      job.recovery === undefined ||
      job.workflowKey !== `${recoveryPrefix}${job.recovery.recoveryId}`
    ) {
      throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    }
    if (
      job.status !== 'succeeded' ||
      job.outcome === undefined ||
      job.outcome.executionId !== execution.executionId ||
      job.outcome.attemptId !== attempt.attemptId ||
      !['reconciliation_required', 'completed'].includes(job.outcome.status) ||
      (job.outcome.status === 'reconciliation_required' &&
        job.outcome.graphCheckpointId === undefined)
    ) {
      // A queued/running child is not yet evidence. HTTP reconciliation holds until it completes;
      // exact-key enqueue deduplication remains a separate store-level guarantee.
      throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    }

    let input: ReturnType<typeof ExecutionWorkflowInputSchema.parse>
    try {
      input = ExecutionWorkflowInputSchema.parse(job.input)
    } catch {
      throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    }
    if (
      input.executionId !== execution.executionId ||
      input.workflowId !== `wfl_${execution.executionId.slice(4)}` ||
      !isDeepStrictEqual(input.executionPlan, execution.executionPlan) ||
      input.graph === undefined ||
      input.graph.workspaceId !== workspaceId ||
      input.graph.threadId !== `graph:${execution.executionId}` ||
      !isDeepStrictEqual(input.graph.reference, plan.graph?.reference) ||
      !isDeepStrictEqual(input.graph.input, plan.graph?.input)
    )
      throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    jobsByKey.set(job.workflowKey, job)
    inputsByKey.set(job.workflowKey, input)
  }

  const childrenByParent = new Map<string, WorkflowJobRecord>()
  for (const { job } of snapshot) {
    if (job.workflowKey === rootKey) continue
    const recovery = job.recovery!
    let parent: WorkflowJobRecord | undefined
    if (recovery.parentWorkflowKey !== undefined) {
      parent = jobsByKey.get(recovery.parentWorkflowKey)
    } else {
      const candidates = [...jobsByKey.values()].filter(
        (candidate) =>
          candidate.workflowKey !== job.workflowKey &&
          candidate.outcome?.graphCheckpointId === recovery.checkpointId
      )
      if (candidates.length !== 1) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_AMBIGUOUS')
      parent = candidates[0]
    }
    if (
      parent === undefined ||
      parent.outcome?.status !== 'reconciliation_required' ||
      parent.outcome.graphCheckpointId !== recovery.checkpointId ||
      !isDeepStrictEqual(inputsByKey.get(parent.workflowKey), inputsByKey.get(job.workflowKey)) ||
      childrenByParent.has(parent.workflowKey)
    )
      throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    childrenByParent.set(parent.workflowKey, job)
  }

  const chain: WorkflowJobRecord[] = []
  const visited = new Set<string>()
  let current: WorkflowJobRecord | undefined = root
  while (current !== undefined) {
    if (visited.has(current.workflowKey)) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
    visited.add(current.workflowKey)
    chain.push(current)
    current = childrenByParent.get(current.workflowKey)
  }
  if (chain.length !== jobsByKey.size) throw new Error('TOOL_EFFECT_RECOVERY_CHAIN_INVALID')
  return { jobs: chain, leaf: chain.at(-1)! }
}

function parseRecoveryIdentity(value: unknown): RecoveryIdentity {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some((key) => !['executionId', 'toolCallId'].includes(key))
  )
    throw new Error('TOOL_EFFECT_INSPECTION_INVALID')
  return {
    executionId: IdentifierSchemas.executionId.parse(value['executionId']),
    ...(value['toolCallId'] === undefined
      ? {}
      : { toolCallId: IdentifierSchemas.toolCallId.parse(value['toolCallId']) }),
  }
}

function parseRecoveryCommand(value: unknown): RecoveryCommand {
  if (
    !isJsonObject(value) ||
    Object.keys(value).some(
      (key) => !['executionId', 'toolCallId', 'expectedRevision', 'action'].includes(key)
    ) ||
    !Number.isSafeInteger(value['expectedRevision']) ||
    (value['expectedRevision'] as number) <= 0 ||
    (value['action'] !== 'resume' && value['action'] !== 'cancel')
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_INVALID')
  return {
    executionId: IdentifierSchemas.executionId.parse(value['executionId']),
    toolCallId: IdentifierSchemas.toolCallId.parse(value['toolCallId']),
    expectedRevision: value['expectedRevision'] as number,
    action: value['action'],
  }
}

function recoveryPlan(call: ToolCall, evidence: RecoveryEvidence) {
  const recoveryId = sha256(
    `${evidence.execution.executionId}:${call.toolCallId}:${evidence.checkpointId}`
  ).slice(0, 48)
  const input = ExecutionWorkflowInputSchema.parse({
    executionId: evidence.execution.executionId,
    workflowId: `wfl_${evidence.execution.executionId.slice(4)}`,
    executionPlan: evidence.execution.executionPlan,
    deadlineAt: new Date(evidence.deadline).toISOString(),
    ...(evidence.execution.marketplacePluginReferences === undefined
      ? {}
      : { marketplacePluginReferences: evidence.execution.marketplacePluginReferences }),
    graph: {
      workspaceId: evidence.execution.correlation.workspaceId,
      reference: evidence.plan.graph!.reference,
      threadId: `graph:${evidence.execution.executionId}`,
      input: evidence.plan.graph!.input,
    },
  })
  const recovery = {
    recoveryId,
    checkpointId: evidence.checkpointId,
    ...(evidence.workflowKey === undefined ? {} : { parentWorkflowKey: evidence.workflowKey }),
  }
  const workflowKey = `${evidence.execution.executionId}:graph-recovery:${recoveryId}`
  const response = {
    outcome: 'recovery_scheduled',
    executionId: evidence.execution.executionId,
    toolCallId: call.toolCallId,
    workflowKey,
  }
  const intent = {
    schemaVersion: 1,
    kind: 'resume',
    executionId: evidence.execution.executionId,
    toolCallId: call.toolCallId,
    workspaceId: evidence.execution.correlation.workspaceId,
    projectId: evidence.execution.correlation.projectId,
    checkpointId: evidence.checkpointId,
    ...(evidence.workflowKey === undefined ? {} : { parentWorkflowKey: evidence.workflowKey }),
    deadlineAt: new Date(evidence.deadline).toISOString(),
    recoveryId,
    workflowKey,
    inputDigest: sha256(canonicalJsonStringify(input)),
    recoveryDigest: sha256(canonicalJsonStringify(recovery)),
    response,
  }
  return { input, recovery, intent }
}

function assertReconciliationIntent(existingValue: unknown, candidateValue: unknown): void {
  if (!isJsonObject(existingValue) || !isJsonObject(candidateValue))
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  const identityKeys = [
    'schemaVersion',
    'kind',
    'executionId',
    'toolCallId',
    'workspaceId',
    'projectId',
    'checkpointId',
    'parentWorkflowKey',
    'deadlineAt',
  ]
  if (
    identityKeys.some(
      (key) =>
        canonicalJsonStringify(existingValue[key] ?? null) !==
        canonicalJsonStringify(candidateValue[key] ?? null)
    )
  )
    throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
  const storedWorkflowKey = existingValue['workflowKey']
  const candidateWorkflowKey = candidateValue['workflowKey']
  if (storedWorkflowKey === undefined && candidateWorkflowKey !== undefined)
    throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
  if (storedWorkflowKey !== undefined && typeof storedWorkflowKey !== 'string')
    throw new Error('TOOL_EFFECT_RECONCILIATION_RECEIPT_CORRUPT')
  if (candidateWorkflowKey !== undefined && storedWorkflowKey !== candidateWorkflowKey)
    throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
  if (storedWorkflowKey !== undefined && candidateWorkflowKey !== undefined) {
    for (const key of ['recoveryId', 'inputDigest', 'recoveryDigest'] as const) {
      if (existingValue[key] !== candidateValue[key])
        throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
    }
    if (
      canonicalJsonStringify(existingValue['response']) !==
      canonicalJsonStringify(candidateValue['response'])
    )
      throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
  } else if (storedWorkflowKey === undefined) {
    if (
      canonicalJsonStringify(existingValue['response']) !==
      canonicalJsonStringify(candidateValue['response'])
    )
      throw new Error('TOOL_EFFECT_RECONCILIATION_CONFLICT')
  }
}

class SqliteGraphToolRateLimiter implements ToolRateLimiter {
  constructor(
    readonly persistence: SqlitePersistenceProvider,
    readonly now: () => string
  ) {}
  async consume(key: string, limit: number, windowMs: number): Promise<boolean> {
    const at = Date.parse(this.now())
    if (!Number.isFinite(at)) throw new Error('GRAPH_TOOL_CLOCK_INVALID')
    const id = createHash('sha256').update(key).digest('hex')
    return this.persistence.transaction(async (transaction) => {
      const record = await transaction.get('graph-tool-rate-limits', id)
      const raw = record?.value as { timestamps?: unknown } | undefined
      if (
        record !== undefined &&
        (raw === null ||
          typeof raw !== 'object' ||
          !Array.isArray(raw.timestamps) ||
          raw.timestamps.some(
            (item) => typeof item !== 'number' || !Number.isFinite(item) || item > at
          ))
      )
        throw new Error('GRAPH_TOOL_RATE_STATE_INVALID')
      const timestamps = ((raw?.timestamps ?? []) as number[]).filter(
        (item) => item > at - windowMs
      )
      if (timestamps.length >= limit) return false
      await transaction.put({
        namespace: 'graph-tool-rate-limits',
        id,
        ...(record ? { expectedRevision: record.revision } : {}),
        value: { timestamps: [...timestamps, at] },
      })
      return true
    })
  }
}
