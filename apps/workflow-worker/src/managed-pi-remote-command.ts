import { createHash } from 'node:crypto'
import { ContextPackageSchema, type ContextPackageRepository } from '@control-plane/context'
import {
  RuntimeConnectionDiscoveryReadModelSchema,
  type RuntimeConnectionDiscoveryReadModel,
} from '@control-plane/contracts'
import type { Execution, ExecutionAttempt, InteractionRepository } from '@control-plane/domain'
import type { ExecutionWorkflowInput } from '@control-plane/orchestration'
import type { ExecutionPlan } from '@control-plane/execution-plan'
import { translateExecutionPlanToManagedPi } from '@control-plane/managed-pi-adapter'
import {
  GatewayCommandEnvelopeSchema,
  GatewayProtocolManifest,
  type GatewayCommandEnvelope,
} from '@control-plane/runtime-gateway-protocol'
import type { RemoteRuntimeCommandFactory } from './remote-workflow-runtime.js'
import type { WorkflowInteractionResponse } from './execution-workflow.js'

export interface ManagedPiRuntimeDiscoveryReader {
  getRuntimeConnection(input: {
    readonly workspaceId: string
    readonly projectId: string
    readonly runtimeConnectionId: string
  }): Promise<RuntimeConnectionDiscoveryReadModel | undefined>
}

export interface ManagedPiExecutionReader {
  getExecution(executionId: string): Promise<Execution | undefined>
}

export interface ManagedPiRemoteCommandFactoryOptions {
  readonly contextPackages: Pick<ContextPackageRepository, 'get'>
  readonly runtimeDiscovery: ManagedPiRuntimeDiscoveryReader
  readonly executions: ManagedPiExecutionReader
  readonly interactions: Pick<InteractionRepository, 'get'>
  readonly now?: () => Date
}

export class ManagedPiRemoteCommandFactory implements RemoteRuntimeCommandFactory {
  readonly #contextPackages: Pick<ContextPackageRepository, 'get'>
  readonly #executions: ManagedPiExecutionReader
  readonly #interactions: Pick<InteractionRepository, 'get'>
  readonly #now: () => Date
  readonly #runtimeDiscovery: ManagedPiRuntimeDiscoveryReader

  constructor(options: ManagedPiRemoteCommandFactoryOptions) {
    this.#contextPackages = options.contextPackages
    this.#runtimeDiscovery = options.runtimeDiscovery
    this.#executions = options.executions
    this.#interactions = options.interactions
    this.#now = options.now ?? (() => new Date())
  }

  async createExecute(input: {
    readonly executionId: string
    readonly attempt: ExecutionAttempt
    readonly executionPlan: ExecutionPlan
    readonly marketplacePluginReferences?: ExecutionWorkflowInput['marketplacePluginReferences']
    readonly effectKey: string
  }): Promise<GatewayCommandEnvelope> {
    const contextPackageValue = await this.#contextPackages.get({
      contextPackageId: input.executionPlan.contextPackage.contextPackageId,
      contentDigest: input.executionPlan.contextPackage.contentDigest,
    })
    if (contextPackageValue === undefined) throw new Error('REMOTE_RUNTIME_CONTEXT_MISSING')
    const contextPackage = ContextPackageSchema.parse(contextPackageValue)
    if (
      contextPackage.projectState.workspaceId !== input.executionPlan.correlation.workspaceId ||
      contextPackage.projectState.projectId !== input.executionPlan.correlation.projectId
    ) {
      throw new Error('REMOTE_RUNTIME_CONTEXT_SCOPE_MISMATCH')
    }
    const grants = contextPackage.providerComposition?.localProjectGrantRefs ?? []
    if (grants.length !== 1 || !/^grant:[A-Za-z0-9._:-]+$/.test(grants[0] ?? '')) {
      throw new Error('REMOTE_RUNTIME_PROJECT_GRANT_REQUIRED')
    }
    const runtime = await this.#runtime(input.attempt, input.executionPlan.correlation)
    const configuration = translateExecutionPlanToManagedPi(
      input.executionPlan,
      runtime.versions.adapter
    )
    return this.#command({
      executionId: input.executionId,
      attempt: input.attempt,
      workspaceId: input.executionPlan.correlation.workspaceId,
      runtime,
      effectKey: input.effectKey,
      operation: 'runtime.execute',
      requiredCapabilities: input.executionPlan.runtimeRequirements.map(
        ({ capability }) => capability
      ),
      parameters: {
        configuration,
        grantRef: grants[0],
        ...(input.marketplacePluginReferences === undefined
          ? {}
          : { marketplacePluginReferences: input.marketplacePluginReferences }),
      },
    })
  }

  async createInteraction(input: {
    readonly executionId: string
    readonly attempt: ExecutionAttempt
    readonly response: WorkflowInteractionResponse
    readonly effectKey: string
  }): Promise<GatewayCommandEnvelope> {
    const [execution, interaction] = await Promise.all([
      this.#executions.getExecution(input.executionId),
      this.#interactions.get(input.response.interactionId),
    ])
    if (execution === undefined) throw new Error('REMOTE_RUNTIME_EXECUTION_MISSING')
    if (
      interaction === undefined ||
      interaction.executionId !== input.executionId ||
      interaction.attemptId !== input.attempt.attemptId ||
      interaction.state !== 'responded' ||
      interaction.response === undefined
    ) {
      throw new Error('REMOTE_RUNTIME_INTERACTION_MISSING')
    }
    if (
      interaction.response.responseId !== input.response.responseId ||
      interaction.response.action !== input.response.action
    ) {
      throw new Error('REMOTE_RUNTIME_INTERACTION_STALE')
    }
    const runtime = await this.#runtime(input.attempt, execution.correlation)
    const handleId = `managed-pi:${input.attempt.attemptId}`
    const action = interaction.response.action
    if (action === 'input') {
      const value = interaction.response.value
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (text.length === 0) throw new Error('REMOTE_RUNTIME_INTERACTION_INPUT_INVALID')
      return this.#command({
        executionId: input.executionId,
        attempt: input.attempt,
        workspaceId: execution.correlation.workspaceId,
        runtime,
        effectKey: input.effectKey,
        operation: 'runtime.input',
        requiredCapabilities: ['interaction.user-input'],
        parameters: { handleId, interactionId: interaction.interactionId, text },
      })
    }
    if (action === 'approve' || action === 'grant' || action === 'deny') {
      return this.#command({
        executionId: input.executionId,
        attempt: input.attempt,
        workspaceId: execution.correlation.workspaceId,
        runtime,
        effectKey: input.effectKey,
        operation: 'runtime.approval',
        requiredCapabilities: ['interaction.approval'],
        parameters: {
          handleId,
          interactionId: interaction.interactionId,
          decision: action === 'deny' ? 'deny' : 'approve',
        },
      })
    }
    if (action === 'cancel') {
      return this.#command({
        executionId: input.executionId,
        attempt: input.attempt,
        workspaceId: execution.correlation.workspaceId,
        runtime,
        effectKey: input.effectKey,
        operation: 'runtime.cancel',
        requiredCapabilities: ['execution.cancel'],
        parameters: { handleId, requestedAt: interaction.response.respondedAt },
      })
    }
    throw new Error('REMOTE_RUNTIME_INTERACTION_UNSUPPORTED')
  }

  async createCancel(input: {
    readonly executionId: string
    readonly attempt: ExecutionAttempt
    readonly effectKey: string
    readonly reason: 'user_request' | 'deadline'
    readonly issuedAt?: string
  }): Promise<GatewayCommandEnvelope> {
    const execution = await this.#executions.getExecution(input.executionId)
    if (execution === undefined) throw new Error('REMOTE_RUNTIME_EXECUTION_MISSING')
    const runtime = await this.#runtime(input.attempt, execution.correlation)
    const issuedAt = input.issuedAt === undefined ? this.#now() : new Date(input.issuedAt)
    return this.#command({
      executionId: input.executionId,
      attempt: input.attempt,
      workspaceId: execution.correlation.workspaceId,
      runtime,
      effectKey: input.effectKey,
      operation: 'runtime.cancel',
      requiredCapabilities: ['execution.cancel'],
      respectAttemptDeadline: false,
      maximumDurationMs: 5 * 60 * 1_000,
      issuedAt,
      parameters: {
        handleId: `managed-pi:${input.attempt.attemptId}`,
        requestedAt: issuedAt.toISOString(),
      },
    })
  }

  async #runtime(
    attempt: ExecutionAttempt,
    correlation: { readonly workspaceId: string; readonly projectId: string }
  ): Promise<RuntimeConnectionDiscoveryReadModel> {
    const runtimeConnectionId = attempt.runtime?.runtimeConnectionId
    if (runtimeConnectionId === undefined) throw new Error('REMOTE_RUNTIME_ROUTE_MISSING')
    const value = await this.#runtimeDiscovery.getRuntimeConnection({
      workspaceId: correlation.workspaceId,
      projectId: correlation.projectId,
      runtimeConnectionId,
    })
    if (value === undefined) throw new Error('REMOTE_RUNTIME_CONNECTION_MISSING')
    const runtime = RuntimeConnectionDiscoveryReadModelSchema.parse(value)
    const node = runtime.node
    const grant = runtime.access.localProjectGrant
    if (
      !['pi', 'managed-pi'].includes(runtime.family) ||
      runtime.runtimeDefinitionId !== attempt.runtime?.runtimeDefinitionId ||
      node?.runtimeNodeRefId !== attempt.runtime?.runtimeNodeRefId ||
      runtime.status !== 'available' ||
      node?.status !== 'online' ||
      runtime.connection.status !== 'connected' ||
      runtime.connection.availability !== 'healthy' ||
      runtime.freshness.state !== 'fresh' ||
      (grant.required
        ? grant.state !== 'granted'
        : !['not_required', 'granted'].includes(grant.state)) ||
      runtime.access.entitlement.state !== 'allowed' ||
      runtime.eligibility.state !== 'eligible'
    ) {
      throw new Error('REMOTE_RUNTIME_CONNECTION_INELIGIBLE')
    }
    return runtime
  }

  #command(input: {
    readonly executionId: string
    readonly attempt: ExecutionAttempt
    readonly workspaceId: string
    readonly runtime: RuntimeConnectionDiscoveryReadModel
    readonly effectKey: string
    readonly operation: GatewayCommandEnvelope['operation']
    readonly requiredCapabilities: readonly string[]
    readonly parameters: Record<string, unknown>
    readonly respectAttemptDeadline?: boolean
    readonly maximumDurationMs?: number
    readonly issuedAt?: Date
  }): GatewayCommandEnvelope {
    const issuedAt = input.issuedAt ?? this.#now()
    const protocolVersion = gatewayProtocolVersion(input.runtime.versions.protocol)
    const payload = JSON.parse(
      JSON.stringify({ version: 1, parameters: input.parameters })
    ) as Record<string, unknown>
    const deadline = input.respectAttemptDeadline === false ? undefined : input.attempt.deadlineAt
    const maximumDurationMs = input.maximumDurationMs ?? 60 * 60 * 1_000
    const expiresAt = new Date(
      Math.min(
        issuedAt.getTime() + maximumDurationMs,
        deadline === undefined ? Number.POSITIVE_INFINITY : Date.parse(deadline)
      )
    )
    if (expiresAt.getTime() <= issuedAt.getTime()) throw new Error('REMOTE_RUNTIME_COMMAND_EXPIRED')
    const identity = `${input.effectKey}:${input.operation}`
    return GatewayCommandEnvelopeSchema.parse({
      type: 'command',
      schemaVersion: 1,
      protocolVersion,
      sequence: 0,
      nodeId: input.attempt.runtime?.runtimeNodeRefId,
      workspaceId: input.workspaceId,
      traceId: identifier('trc', input.executionId),
      sentAt: issuedAt.toISOString(),
      channelGeneration: 1,
      commandId: identifier('cmd', identity),
      idempotencyKey: `remote:${hash(identity).slice(0, 48)}`,
      payloadHash: `sha256:${hash(JSON.stringify(payload))}`,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      family: 'runtime',
      operation: input.operation,
      driver: { family: 'managed-pi', version: input.runtime.versions.adapter },
      runtimeConnectionId: input.runtime.runtimeConnectionId,
      executionId: input.executionId,
      attemptId: input.attempt.attemptId,
      requiredCapabilities: [...new Set(input.requiredCapabilities)].sort(),
      payload,
    })
  }
}

function gatewayProtocolVersion(value: string | undefined): { major: number; minor: number } {
  const match = /^(\d+)\.(\d+)\.\d+$/.exec(value ?? '')
  if (match === null) throw new Error('REMOTE_RUNTIME_PROTOCOL_MISSING')
  const version = { major: Number(match[1]), minor: Number(match[2]) }
  if (
    !GatewayProtocolManifest.supported.some(
      (supported) => supported.major === version.major && supported.minor === version.minor
    )
  ) {
    throw new Error('REMOTE_RUNTIME_PROTOCOL_UNSUPPORTED')
  }
  return version
}

function identifier(prefix: 'cmd' | 'trc', value: string): string {
  const digest = createHash('sha256').update(value).digest()
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  return `${prefix}_${Array.from(digest.subarray(0, 26), (byte) => alphabet[byte & 31]).join('')}`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
