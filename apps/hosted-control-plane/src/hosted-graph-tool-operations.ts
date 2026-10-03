import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import {
  canonicalJsonStringify,
  GraphToolPinSchema,
  IdentifierSchemas,
  type GraphToolPin,
} from '@control-plane/contracts'
import { InteractionService, type CommandAcceptanceRepository } from '@control-plane/domain'
import type { ObjectStore } from '@control-plane/deployment'
import {
  GraphDefinitionCatalog,
  GraphNodeApprovalRequiredError,
  GraphNodeEffectUnconfirmedError,
  type GraphNodeOperation,
  type GraphNodeOperationPort,
} from '@control-plane/orchestration'
import {
  PostgresDurableUsageStore,
  PostgresExecutionPlanRepository,
  PostgresExecutionRepository,
  PostgresHostedGraphToolConfigurationRepository,
  PostgresGraphDefinitionRepository,
  PostgresGraphToolCancellationRepository,
  PostgresInteractionRepository,
  PostgresToolCallRepository,
  PostgresToolRegistryRepository,
  PostgresToolRateLimiter,
  type ControlPlaneDatabase,
} from '@control-plane/database'
import { assertExecutionPlanIntegrity } from '@control-plane/execution-plan'
import {
  InteractionToolApprovalCoordinator,
  PolicyControlledToolExecutionService,
  ToolGateway,
  ToolRegistry,
  ToolRegistryError,
  toolInputMatchesDigest,
} from '@control-plane/tool-execution'
import type { ToolRateLimiter } from '@control-plane/tool-execution/execution'
import {
  DurableToolCallRequestSchema,
  type ToolCall,
  type ToolDefinition,
  type ToolVersionDraft,
} from '@control-plane/tool-sdk'
import { ScopedObjectStoreJsonToolExecutor } from '@control-plane/object-store'
import { DurableUsageLedger } from '@control-plane/usage-ledger'
import { DurableRuntimeBudgetAdmission } from '@control-plane/workflow-worker'

const semver = createRequire(import.meta.url)('semver') as {
  satisfies(version: string, range: string): boolean
}

const HOSTED_GRAPH_TOOL_NAME = 'hosted-object-store-json'
const HOSTED_GRAPH_TOOL_VERSION = '1.0.0'
export const HOSTED_GRAPH_TOOL_EXECUTOR = 'hosted.object-store-json.v1'
const HOSTED_GRAPH_TOOL_OPERATION = 'store-json'

export interface HostedGraphToolConfiguration {
  readonly schemaVersion: 1
  readonly toolDefinitionId: string
  readonly toolVersionId: string
  readonly currency: string
  readonly costMicrounits: number
  readonly createdAt: string
  readonly publishedAt: string
}

export interface HostedGraphToolBinding {
  readonly configuration: HostedGraphToolConfiguration
  readonly configurationDigest: string
  readonly definition: ToolDefinition
  readonly draft: ToolVersionDraft
  readonly pin: GraphToolPin
}

/** Strict schema for operator-owned, immutable tool identity and tariff configuration. */
export function parseHostedGraphToolConfiguration(input: unknown): HostedGraphToolConfiguration {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
  const record = input as Record<string, unknown>
  const expectedKeys = [
    'costMicrounits',
    'createdAt',
    'currency',
    'publishedAt',
    'schemaVersion',
    'toolDefinitionId',
    'toolVersionId',
  ]
  if (!isDeepStrictEqual(Object.keys(record).toSorted(), expectedKeys)) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
  if (
    record['schemaVersion'] !== 1 ||
    typeof record['currency'] !== 'string' ||
    !/^[A-Z]{3}$/.test(record['currency']) ||
    typeof record['costMicrounits'] !== 'number' ||
    !Number.isSafeInteger(record['costMicrounits']) ||
    record['costMicrounits'] < 1 ||
    typeof record['createdAt'] !== 'string' ||
    typeof record['publishedAt'] !== 'string'
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
  const createdAt = parseOperatorTimestamp(record['createdAt'])
  const publishedAt = parseOperatorTimestamp(record['publishedAt'])
  if (Date.parse(publishedAt) < Date.parse(createdAt)) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
  try {
    return Object.freeze({
      schemaVersion: 1,
      toolDefinitionId: IdentifierSchemas.toolDefinitionId.parse(record['toolDefinitionId']),
      toolVersionId: IdentifierSchemas.toolVersionId.parse(record['toolVersionId']),
      currency: record['currency'],
      costMicrounits: record['costMicrounits'],
      createdAt,
      publishedAt,
    })
  } catch {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
}

export function createHostedGraphToolBinding(input: unknown): HostedGraphToolBinding {
  const configuration = parseHostedGraphToolConfiguration(input)
  const toolDefinitionId = IdentifierSchemas.toolDefinitionId.parse(configuration.toolDefinitionId)
  const toolVersionId = IdentifierSchemas.toolVersionId.parse(configuration.toolVersionId)
  const definition: ToolDefinition = {
    toolDefinitionId,
    name: HOSTED_GRAPH_TOOL_NAME,
    displayName: 'Hosted JSON artifact writer',
    description: 'Writes one immutable JSON artifact in the accepted project scope.',
    ownership: { scope: 'system' },
    createdAt: configuration.createdAt,
  }
  const draft: ToolVersionDraft = {
    toolDefinitionId,
    toolVersionId,
    semanticVersion: HOSTED_GRAPH_TOOL_VERSION,
    inputSchema: { type: 'object', additionalProperties: true },
    outputSchema: {
      type: 'object',
      properties: {
        artifactRef: { type: 'string' },
        contentDigest: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
        size: { type: 'integer', minimum: 0 },
      },
      required: ['artifactRef', 'contentDigest', 'size'],
      additionalProperties: false,
    },
    operations: [
      {
        name: HOSTED_GRAPH_TOOL_OPERATION,
        requiredCapabilities: ['object-store.write'],
        riskClass: 'medium',
        approvalMode: 'always',
        idempotency: 'inherent',
      },
    ],
    executor: { type: 'internal', reference: HOSTED_GRAPH_TOOL_EXECUTOR },
    limits: {
      maxInputBytes: 1_048_576,
      maxOutputBytes: 4_096,
      timeoutMs: 30_000,
      rateLimit: { maxCalls: 60, windowMs: 60_000 },
    },
    createdAt: configuration.createdAt,
    publishedAt: configuration.publishedAt,
  }
  const pin: GraphToolPin = GraphToolPinSchema.parse({
    toolDefinitionId: definition.toolDefinitionId,
    toolVersionId: draft.toolVersionId,
    contentDigest: `sha256:${digest(draft)}`,
    operation: HOSTED_GRAPH_TOOL_OPERATION,
  })
  return Object.freeze({
    configuration,
    configurationDigest: digest(configuration),
    definition: Object.freeze(definition),
    draft: Object.freeze(draft),
    pin,
  })
}

function parseOperatorTimestamp(value: string): string {
  const parsed = Date.parse(value)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString() !== value
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_CONFIG_INVALID')
  }
  return value
}

export interface HostedGraphToolOperationsOptions {
  readonly configuration: HostedGraphToolConfiguration
  readonly database: ControlPlaneDatabase
  readonly objectStore: ObjectStore
  readonly plans: PostgresExecutionPlanRepository
  readonly executions: PostgresExecutionRepository
  readonly commands: Pick<CommandAcceptanceRepository, 'getByExecutionId'>
  readonly interactions: PostgresInteractionRepository
  readonly now?: () => string
}

/** Durable, server-owned authority and effects for the one Hosted graph tool. */
export class HostedGraphToolOperations implements GraphNodeOperationPort {
  readonly #options: HostedGraphToolOperationsOptions
  readonly #binding: HostedGraphToolBinding
  readonly #now: () => string
  readonly #active = new Map<AbortController, string>()
  readonly #ledger: DurableUsageLedger
  readonly #usageStore: PostgresDurableUsageStore
  readonly #rateLimiter: PostgresToolRateLimiter
  readonly #cancellations: PostgresGraphToolCancellationRepository
  readonly #configurationRepository: PostgresHostedGraphToolConfigurationRepository

  constructor(options: HostedGraphToolOperationsOptions) {
    this.#binding = createHostedGraphToolBinding(options.configuration)
    this.#options = { ...options, configuration: this.#binding.configuration }
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#usageStore = new PostgresDurableUsageStore(options.database)
    this.#ledger = new DurableUsageLedger({ store: this.#usageStore, now: this.#now })
    this.#rateLimiter = new PostgresToolRateLimiter(options.database)
    this.#cancellations = new PostgresGraphToolCancellationRepository(options.database)
    this.#configurationRepository = new PostgresHostedGraphToolConfigurationRepository(
      options.database
    )
  }

  get toolPin(): GraphToolPin {
    return structuredClone(this.#binding.pin)
  }

  async pinConfiguration(): Promise<void> {
    await this.#configurationRepository.pin({
      schemaVersion: 1,
      toolDefinitionId: this.#binding.pin.toolDefinitionId,
      toolVersionId: this.#binding.pin.toolVersionId,
      contentDigest: this.#binding.pin.contentDigest,
      operation: this.#binding.pin.operation,
      currency: this.#binding.configuration.currency,
      costMicrounits: this.#binding.configuration.costMicrounits,
      configurationDigest: this.#binding.configurationDigest,
    })
  }

  async ensureToolRegistered(workspaceId: string): Promise<void> {
    await this.pinConfiguration()
    const registryRepository = new PostgresToolRegistryRepository(
      this.#options.database,
      workspaceId
    )
    const registry = new ToolRegistry(registryRepository)
    const existingDefinition = await registryRepository.getDefinition(
      this.#binding.definition.toolDefinitionId
    )
    if (existingDefinition === undefined) {
      try {
        await registry.createDefinition(this.#binding.definition)
      } catch (error) {
        if (!(error instanceof ToolRegistryError) || error.code !== 'DEFINITION_EXISTS') throw error
      }
    }
    const definition = await registryRepository.getDefinition(
      this.#binding.definition.toolDefinitionId
    )
    if (!definition || !isDeepStrictEqual(definition, this.#binding.definition)) {
      throw new Error('HOSTED_GRAPH_TOOL_DEFINITION_CONFLICT')
    }

    let version = await registryRepository.getVersion(this.#binding.pin.toolVersionId)
    if (version === undefined) {
      try {
        await registry.publishVersion(this.#binding.draft)
      } catch (error) {
        if (
          !(error instanceof ToolRegistryError) ||
          !['VERSION_EXISTS', 'SEMANTIC_VERSION_CONFLICT'].includes(error.code)
        )
          throw error
      }
      version = await registryRepository.getVersion(this.#binding.pin.toolVersionId)
    }
    if (
      !version ||
      version.contentDigest !== this.#binding.pin.contentDigest ||
      version.toolDefinitionId !== this.#binding.pin.toolDefinitionId ||
      version.semanticVersion !== HOSTED_GRAPH_TOOL_VERSION ||
      version.lifecycle !== 'published' ||
      !isHostedGraphToolDraft(version, this.#binding.draft)
    ) {
      throw new Error('HOSTED_GRAPH_TOOL_VERSION_CONFLICT')
    }
  }

  async invoke(operation: GraphNodeOperation): Promise<Readonly<Record<string, unknown>>> {
    if (operation.kind !== 'tool' || operation.toolPin === undefined) {
      throw new Error('HOSTED_GRAPH_TOOL_BINDING_DENIED')
    }
    const controller = new AbortController()
    this.#active.set(controller, operation.executionId)
    try {
      await this.ensureToolRegistered(operation.workspaceId)
      const authority = await authorizeHostedGraphTool(operation, this.#options, this.#binding)
      const { execution, plan, command, pin, toolOperation } = authority
      const deadline = Math.min(
        Date.parse(
          execution.deadlineAt ??
            new Date(
              Date.parse(execution.acceptedAt) + plan.constraints.limits.duration.maximumMs
            ).toISOString()
        ),
        Date.parse(command.retentionExpiresAt)
      )
      if (!Number.isFinite(deadline) || Date.parse(this.#now()) >= deadline) {
        throw new Error('HOSTED_GRAPH_TOOL_DEADLINE_EXCEEDED')
      }
      if (
        !isDeepStrictEqual(pin, this.#binding.pin) ||
        pin.operation !== HOSTED_GRAPH_TOOL_OPERATION ||
        toolOperation.requiredCapabilities.length !== 1 ||
        toolOperation.requiredCapabilities[0] !== 'object-store.write'
      ) {
        throw new Error('HOSTED_GRAPH_TOOL_BINDING_DENIED')
      }
      if (plan.constraints.limits.budget.currency !== this.#binding.configuration.currency) {
        throw new Error('HOSTED_GRAPH_TOOL_PRICE_MISSING')
      }
      if (await this.#cancellations.get(operation.executionId, operation.workspaceId)) {
        throw new Error('HOSTED_GRAPH_TOOL_CANCELLED')
      }
      await new DurableRuntimeBudgetAdmission({
        store: this.#usageStore,
        commands: this.#options.commands,
      }).authorize({
        execution,
        executionPlan: plan,
        attemptId: operation.attemptId,
      })

      const calls = new PostgresToolCallRepository(this.#options.database, operation.workspaceId, {
        admissionFence: (transaction, call) =>
          this.#cancellations.assertNotCancelledInTransaction(
            transaction,
            call.executionId,
            call.workspaceId
          ),
      })
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
      })
      const source = (stage: string) => ({
        sourceId: `${request.toolCallId}:${this.#binding.configurationDigest}`,
        idempotencyKey: `${operation.idempotencyKey}:${stage}`,
      })
      const admissionRateLimiter = createHostedGraphToolAdmissionRateLimiter({
        database: this.#options.database,
        cancellations: this.#cancellations,
        rateLimiter: this.#rateLimiter,
        now: this.#now,
        workspaceId: operation.workspaceId,
        executionId: operation.executionId,
        attemptId,
        reservationKey: operation.idempotencyKey,
        maximumMicrounits: this.#binding.configuration.costMicrounits,
        reserveSource: source('reserve'),
        toolCallId: request.toolCallId,
      })

      const registry = new ToolRegistry(
        new PostgresToolRegistryRepository(this.#options.database, operation.workspaceId)
      )
      const gateway = new ToolGateway(registry)
      gateway.registerExecutor(
        'internal',
        HOSTED_GRAPH_TOOL_EXECUTOR,
        new ScopedObjectStoreJsonToolExecutor(
          this.#options.objectStore,
          HOSTED_GRAPH_TOOL_EXECUTOR,
          {
            workspaceId: operation.workspaceId,
            projectId: execution.correlation.projectId,
          }
        )
      )
      const interactions = new InteractionService(this.#options.interactions)
      const approvals = new InteractionToolApprovalCoordinator(
        interactions,
        this.#options.interactions
      )
      const service = new PolicyControlledToolExecutionService({
        gateway,
        calls,
        now: this.#now,
        rateLimiter: admissionRateLimiter,
        authorizer: {
          authorize: async (candidate) => {
            if (
              candidate.toolCallId !== request.toolCallId ||
              candidate.policySnapshotRef !== policySnapshotRef ||
              !toolInputMatchesDigest(operation.input, candidate.inputDigest) ||
              candidate.principalRef !== command.callerPrincipalId
            ) {
              throw new Error('HOSTED_GRAPH_TOOL_POLICY_MISMATCH')
            }
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
            const stored = await this.#options.interactions.get(input.interactionId)
            if (
              stored?.state === 'pending' &&
              Date.parse(this.#now()) >= Date.parse(stored.expiresAt)
            ) {
              await interactions.expire(stored.interactionId, this.#now())
            }
            return approvals.review(input)
          },
        },
      })
      try {
        const outcome = await service.execute(request, { signal: controller.signal })
        if (outcome.state === 'awaiting_approval') {
          const approval = request.approval
          if (!approval) throw new Error('HOSTED_GRAPH_APPROVAL_INTERACTION_MISSING')
          throw new GraphNodeApprovalRequiredError({
            interactionKey: approval.interactionId,
            kind: 'approval',
            payload: { toolCallId: request.toolCallId, node: operation.node, name: operation.name },
          })
        }
        if (outcome.state === 'succeeded') {
          await this.#ledger.charge({
            workspaceId: operation.workspaceId,
            executionId: operation.executionId,
            attemptId,
            reservationKey: operation.idempotencyKey,
            kind: 'tool_charge',
            quantity: { unit: 'calls', value: 1 },
            costMicrounits: this.#binding.configuration.costMicrounits,
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
          ) {
            throw new Error('HOSTED_GRAPH_TOOL_OUTPUT_INVALID')
          }
          return outcome.result.output
        }
        if (outcome.state === 'in_progress' || outcome.state === 'reconciliation_required') {
          throw new GraphNodeEffectUnconfirmedError()
        }
        throw new Error(`HOSTED_GRAPH_TOOL_${outcome.state.toUpperCase()}`)
      } catch (error) {
        if (error instanceof GraphNodeEffectUnconfirmedError) throw error
        let call: ToolCall | undefined
        try {
          call = await calls.getByIdempotencyKey(operation.workspaceId, operation.idempotencyKey)
        } catch {
          throw new GraphNodeEffectUnconfirmedError()
        }
        if (call && ['executing', 'reconciliation_required', 'succeeded'].includes(call.status)) {
          throw new GraphNodeEffectUnconfirmedError()
        }
        if (call && ['failed', 'denied'].includes(call.status)) {
          try {
            await this.#settleIfReserved(call)
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

  async cancel(executionIdInput: string, threadId: string, idempotencyKey: string) {
    const executionId = IdentifierSchemas.executionId.parse(executionIdInput)
    if (threadId !== `graph:${executionId}`) throw new Error('GRAPH_TOOL_THREAD_MISMATCH')
    const execution = await this.#options.executions.getExecution(executionId)
    if (!execution) return false
    await this.#cancellations.record({
      workspaceId: execution.correlation.workspaceId,
      executionId,
      threadId,
      idempotencyKey,
    })
    for (const [controller, activeExecutionId] of this.#active) {
      if (activeExecutionId === executionId) controller.abort()
    }
    const calls = new PostgresToolCallRepository(
      this.#options.database,
      execution.correlation.workspaceId
    )
    let confirmed = true
    for (const call of await calls.listByExecution(executionId)) {
      if (!call.idempotencyKey.startsWith('graph-op-v1:')) continue
      if (call.status === 'executing' || call.status === 'reconciliation_required') {
        confirmed = false
        continue
      }
      if (call.status === 'succeeded') {
        const accounted = await this.#usageStore.transaction(
          call.workspaceId,
          async (transaction) =>
            (await transaction.getEffect(`${call.idempotencyKey}:charge`)) !== undefined &&
            (await transaction.getEffect(`${call.idempotencyKey}:settle`)) !== undefined
        )
        if (!accounted) confirmed = false
        continue
      }
      let cancelledWithoutEffect =
        call.status === 'denied' && call.errorCode === 'GRAPH_TOOL_CANCELLED'
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
        cancelledWithoutEffect = true
      }
      if (
        ['requested', 'awaiting_approval', 'authorized', 'failed', 'denied'].includes(call.status)
      ) {
        if (call.approvalInteractionId) {
          try {
            await new InteractionService(this.#options.interactions).resolveTerminal(
              call.approvalInteractionId,
              this.#now()
            )
          } catch {
            confirmed = false
          }
        }
        if (cancelledWithoutEffect) {
          try {
            await this.#rateLimiter.release(
              [call.workspaceId, call.principalRef, call.toolDefinitionId, call.operation].join(
                ':'
              ),
              call.toolCallId
            )
          } catch {
            confirmed = false
          }
        }
        try {
          await this.#settleIfReserved(call)
        } catch {
          confirmed = false
        }
      }
    }
    return confirmed
  }

  async #settleIfReserved(call: ToolCall): Promise<void> {
    const hasReservation = await this.#usageStore.transaction(
      call.workspaceId,
      async (transaction) => Boolean(await transaction.getEffect(`${call.idempotencyKey}:reserve`))
    )
    if (!hasReservation) return
    await this.#ledger.settle({
      workspaceId: call.workspaceId,
      executionId: call.executionId,
      reservationKey: call.idempotencyKey,
      source: {
        sourceId: `${call.toolCallId}:${this.#binding.configurationDigest}`,
        idempotencyKey: `${call.idempotencyKey}:settle`,
      },
    })
  }
}

export async function authorizeHostedGraphTool(
  operation: GraphNodeOperation,
  options: HostedGraphToolOperationsOptions,
  binding: HostedGraphToolBinding = createHostedGraphToolBinding(options.configuration)
) {
  const [execution, attempt, command] = await Promise.all([
    options.executions.getExecution(operation.executionId),
    options.executions.getAttempt(operation.attemptId),
    options.commands.getByExecutionId(operation.executionId),
  ])
  if (
    operation.kind !== 'tool' ||
    !execution ||
    !attempt ||
    !command ||
    execution.correlation.workspaceId !== operation.workspaceId ||
    execution.correlation.projectId !== command.projectId ||
    command.workspaceId !== operation.workspaceId ||
    operation.workflowId !== `wfl_${execution.executionId.slice(4)}` ||
    operation.threadId !== `graph:${execution.executionId}` ||
    execution.latestAttemptId !== operation.attemptId ||
    attempt.executionId !== execution.executionId ||
    !isDeepStrictEqual(command.executionPlan, execution.executionPlan) ||
    !['running', 'awaiting_input'].includes(execution.state) ||
    !['running', 'awaiting_input'].includes(attempt.state)
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_EXECUTION_AUTHORITY_MISMATCH')
  }
  const stored = await options.plans.get(execution.executionPlan)
  if (!stored) throw new Error('HOSTED_GRAPH_TOOL_PLAN_MISSING')
  const plan = assertExecutionPlanIntegrity(stored)
  if (!plan.graph || !isDeepStrictEqual(plan.correlation, execution.correlation)) {
    throw new Error('HOSTED_GRAPH_TOOL_PLAN_MISMATCH')
  }
  const graph = await new GraphDefinitionCatalog(
    new PostgresGraphDefinitionRepository(options.database, operation.workspaceId)
  ).getPinned(plan.graph.reference)
  const graphNode = graph.content.nodes.find(({ node }) => node === operation.node)
  if (
    !isDeepStrictEqual(graph.reference, plan.graph.reference) ||
    !graphNode ||
    graphNode.operation.kind !== 'tool' ||
    graphNode.operation.name !== operation.name ||
    !graphNode.operation.toolPin
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_NODE_MISMATCH')
  }
  const pin = GraphToolPinSchema.parse(graphNode.operation.toolPin)
  if (
    !isDeepStrictEqual(pin, binding.pin) ||
    ('toolPin' in operation && !isDeepStrictEqual(operation.toolPin, pin))
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_PIN_MISMATCH')
  }
  const registry = new ToolRegistry(
    new PostgresToolRegistryRepository(options.database, operation.workspaceId)
  )
  const definition = await registry.readDefinition(pin.toolDefinitionId, operation.workspaceId)
  const version = await registry.readVersion(pin.toolVersionId, operation.workspaceId)
  if (
    version.toolDefinitionId !== pin.toolDefinitionId ||
    version.contentDigest !== pin.contentDigest ||
    !['published', 'deprecated'].includes(version.lifecycle)
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_VERSION_MISMATCH')
  }
  const toolOperation = version.operations.find(({ name }) => name === pin.operation)
  const grants = plan.constraints.tools.grants.filter(
    (grant) =>
      grant.tool.toolId === definition.name &&
      semver.satisfies(version.semanticVersion, grant.tool.versionRange) &&
      grant.operations.includes(pin.operation)
  )
  if (!toolOperation || grants.length === 0) throw new Error('HOSTED_GRAPH_TOOL_GRANT_DENIED')
  if (
    grants.some((grant) =>
      toolOperation.requiredCapabilities.some(
        (capability) => !grant.requiredCapabilities.includes(capability)
      )
    )
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_CAPABILITY_DENIED')
  }
  const riskCeiling = { safe: 0, read: 0, write: 1, destructive: 2, privileged: 3 } as const
  const operationRisk = { low: 0, medium: 1, high: 2, critical: 3 } as const
  if (
    grants.some((grant) => operationRisk[toolOperation.riskClass] > riskCeiling[grant.riskClass])
  ) {
    throw new Error('HOSTED_GRAPH_TOOL_RISK_DENIED')
  }
  const destructive = grants.some((grant) =>
    ['destructive', 'privileged'].includes(grant.riskClass)
  )
  if (destructive && plan.constraints.interaction.destructiveOperations === 'deny') {
    throw new Error('HOSTED_GRAPH_TOOL_POLICY_DENIED')
  }
  const requiresApproval =
    toolOperation.approvalMode === 'always' ||
    grants.some((grant) => grant.approval !== 'none') ||
    plan.constraints.interaction.approvals === 'required' ||
    destructive
  if (requiresApproval && plan.constraints.interaction.approvals === 'disabled') {
    throw new Error('HOSTED_GRAPH_TOOL_APPROVAL_DISABLED')
  }
  return {
    execution,
    attempt,
    command,
    plan,
    pin,
    definition,
    version,
    toolOperation,
    requiresApproval,
  }
}

/** Atomically admits quota and a budget reservation after a durable call exists. */
export function createHostedGraphToolAdmissionRateLimiter(input: {
  readonly database: ControlPlaneDatabase
  readonly cancellations: PostgresGraphToolCancellationRepository
  readonly rateLimiter: PostgresToolRateLimiter
  readonly now: () => string
  readonly workspaceId: string
  readonly executionId: string
  readonly attemptId: string
  readonly reservationKey: string
  readonly maximumMicrounits: number
  readonly reserveSource: { readonly sourceId: string; readonly idempotencyKey: string }
  readonly toolCallId: string
}): ToolRateLimiter {
  return {
    consume: async (key, limit, windowMs, requestedAt, toolCallId) => {
      if (toolCallId !== input.toolCallId) throw new Error('HOSTED_GRAPH_TOOL_CALL_MISMATCH')
      return input.database.transaction(async (transaction) => {
        await input.cancellations.assertNotCancelledInTransaction(
          transaction,
          input.executionId,
          input.workspaceId
        )
        const admitted = await input.rateLimiter.consumeInTransaction(
          transaction,
          key,
          limit,
          windowMs,
          requestedAt,
          toolCallId
        )
        if (!admitted) return false
        await PostgresDurableUsageStore.withTransaction(
          transaction,
          input.workspaceId,
          async (store) =>
            new DurableUsageLedger({ store, now: input.now }).reserve({
              workspaceId: input.workspaceId,
              executionId: input.executionId,
              attemptId: input.attemptId,
              reservationKey: input.reservationKey,
              maximumMicrounits: input.maximumMicrounits,
              maximumTokens: 0,
              source: input.reserveSource,
            })
        )
        return true
      })
    },
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJsonStringify(value)).digest('hex')
}

function isHostedGraphToolDraft(
  version: Awaited<ReturnType<ToolRegistry['readVersion']>>,
  expectedDraft: ToolVersionDraft
): boolean {
  if (!version) return false
  const {
    revision: _revision,
    lifecycle: _lifecycle,
    contentDigest: _contentDigest,
    ...draft
  } = version
  return isDeepStrictEqual(draft, expectedDraft)
}
