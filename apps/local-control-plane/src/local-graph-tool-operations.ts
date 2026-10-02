import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalJsonStringify,
  IdentifierSchemas,
  type GraphToolPin,
} from '@control-plane/contracts'
import { InteractionService } from '@control-plane/domain'
import type { ObjectStore } from '@control-plane/deployment'
import {
  GraphNodeApprovalRequiredError,
  GraphNodeEffectUnconfirmedError,
  type GraphNodeOperation,
  type GraphNodeOperationPort,
} from '@control-plane/orchestration'
import {
  SqliteDurableUsageStore,
  SqliteToolCallRepository,
  SqliteToolRegistryRepository,
  type SqlitePersistenceProvider,
} from '@control-plane/sqlite-persistence'
import {
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  ToolRegistry,
  type ToolRateLimiter,
} from '@control-plane/tool-execution'
import { DurableToolCallRequestSchema, type ToolCall } from '@control-plane/tool-sdk'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'
import type { LocalControlApiComposition } from './local-api-composition.js'
import { authorizeLocalGraphTool } from './local-graph-tool-authority.js'
import { ObjectStoreJsonToolExecutor } from './object-store-tool.js'
import { GraphDefinitionCatalog } from '@control-plane/orchestration'
import { SqliteGraphDefinitionRepository } from '@control-plane/sqlite-persistence'

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

/** Accepted-plan authority, persisted approvals and usage around a concrete immutable JSON effect. */
export class LocalGraphToolOperations implements GraphNodeOperationPort {
  readonly #options: LocalGraphToolOperationsOptions
  readonly #now: () => string
  readonly #active = new Map<AbortController, string>()
  readonly #ledger: DurableUsageLedger
  readonly #rateLimiter: ToolRateLimiter

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
    this.#rateLimiter = new SqliteGraphToolRateLimiter(options.persistence, this.#now)
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
        new ObjectStoreJsonToolExecutor(objectStore)
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
              candidate.inputDigest !== digest(operation.input) ||
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

function digest(value: unknown) {
  return 'sha256:' + createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
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
