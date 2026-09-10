import { createHash } from 'node:crypto'
import type { RuntimeConnectionDiscoveryReadModel } from '@control-plane/contracts'
import type { Execution, ExecutionAttempt } from '@control-plane/domain'
import type { ExecutionPlan } from '@control-plane/execution-plan'
import { RuntimeCapabilitySchema, evaluateCapabilities } from '@control-plane/runtime-sdk'
import type { RuntimeAttemptRouter } from './cloud-execution-activities.js'

export interface RuntimeDiscoveryReadPort {
  listRuntimeConnections(scope: {
    readonly workspaceId: string
    readonly projectId?: string
  }): Promise<readonly RuntimeConnectionDiscoveryReadModel[]>
}

export interface RuntimeDiscoveryAttemptRouterOptions {
  readonly discovery: RuntimeDiscoveryReadPort
  readonly now?: () => string
}

type SelectedRuntime = NonNullable<ExecutionAttempt['runtime']>

export class RuntimeDiscoveryAttemptRouter implements RuntimeAttemptRouter {
  readonly #discovery: RuntimeDiscoveryReadPort
  readonly #now: () => string

  constructor(options: RuntimeDiscoveryAttemptRouterOptions) {
    this.#discovery = options.discovery
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  async resolve(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
  }): Promise<SelectedRuntime> {
    const evaluatedAt = this.#now()
    const discovered = await this.#discovery.listRuntimeConnections({
      workspaceId: input.execution.correlation.workspaceId,
      projectId: input.execution.correlation.projectId,
    })
    const candidates = discovered
      .map((connection) => candidate(connection, input.executionPlan, evaluatedAt))
      .filter((value) => value !== undefined)
      .toSorted(compareCandidates)
    const selected = candidates[0]
    if (selected === undefined) throw new Error('WORKFLOW_RUNTIME_UNAVAILABLE')
    const inputDigest = digest({
      executionId: input.execution.executionId,
      executionPlanId: input.executionPlan.executionPlanId,
      executionPlanDigest: input.executionPlan.contentDigest,
      runtimeRequirements: [...input.executionPlan.runtimeRequirements].toSorted((left, right) =>
        left.capability.localeCompare(right.capability)
      ),
      constraints: {
        allowedFamilies: [...input.executionPlan.constraints.runtime.allowedFamilies].toSorted(),
        allowedLocations: [...input.executionPlan.constraints.runtime.allowedLocations].toSorted(),
      },
      candidates: candidates.map(({ connection, degraded }) => ({
        runtimeConnectionId: connection.runtimeConnectionId,
        runtimeDefinitionId: connection.runtimeDefinitionId,
        runtimeNodeRefId: connection.node?.runtimeNodeRefId,
        observedAt: connection.observedAt,
        degraded,
      })),
    })
    const decisionDigest = digest({
      inputDigest,
      runtimeConnectionId: selected.connection.runtimeConnectionId,
      runtimeDefinitionId: selected.connection.runtimeDefinitionId,
      runtimeNodeRefId: selected.runtimeNodeRefId,
    })
    return {
      runtimeDefinitionId: selected.connection.runtimeDefinitionId,
      runtimeNodeRefId: selected.runtimeNodeRefId,
      runtimeConnectionId: selected.connection.runtimeConnectionId,
      routingDecision: {
        routingVersion: 1,
        policy: input.executionPlan.policySnapshot,
        evaluatedAt,
        inputDigest,
        decisionDigest,
        selectedRank: 1,
        candidateCount: candidates.length,
        reasonCodes: [selected.degraded ? 'RUNTIME_SELECTED_DEGRADED' : 'RUNTIME_SELECTED'],
      },
    }
  }
}

interface Candidate {
  readonly connection: RuntimeConnectionDiscoveryReadModel
  readonly runtimeNodeRefId: NonNullable<
    RuntimeConnectionDiscoveryReadModel['node']
  >['runtimeNodeRefId']
  readonly degraded: boolean
}

function candidate(
  connection: RuntimeConnectionDiscoveryReadModel,
  plan: ExecutionPlan,
  evaluatedAt: string
): Candidate | undefined {
  if (!['available', 'degraded'].includes(connection.status)) return undefined
  if (!['connected', 'degraded'].includes(connection.connection.status)) return undefined
  if (!['healthy', 'degraded'].includes(connection.connection.availability)) return undefined
  if (connection.freshness.state !== 'fresh') return undefined
  if (
    connection.freshness.expiresAt !== undefined &&
    Date.parse(connection.freshness.expiresAt) <= Date.parse(evaluatedAt)
  ) {
    return undefined
  }
  if (!['compatible', 'degraded'].includes(connection.compatibility.state)) return undefined
  if (!runtimeFamilyAllowed(connection.family, plan.constraints.runtime.allowedFamilies)) {
    return undefined
  }
  if (!locationAllowed(connection, plan.constraints.runtime.allowedLocations)) return undefined
  const node = connection.node
  if (node?.status !== 'online' || node.health !== 'online') return undefined
  if (connection.eligibility.state === 'ineligible') return undefined
  if (connection.access.entitlement.state !== 'allowed') return undefined
  const grant = connection.access.localProjectGrant
  if (
    grant.required ? grant.state !== 'granted' : !['not_required', 'granted'].includes(grant.state)
  ) {
    return undefined
  }
  const capabilityDecision = evaluateCapabilities(
    connection.capabilityDetails.flatMap((capability) => {
      const parsed = RuntimeCapabilitySchema.safeParse(capability)
      return parsed.success ? [parsed.data] : []
    }),
    plan.runtimeRequirements
  )
  if (!capabilityDecision.eligible) return undefined
  return {
    connection,
    runtimeNodeRefId: node.runtimeNodeRefId,
    degraded:
      connection.status === 'degraded' ||
      connection.connection.status === 'degraded' ||
      connection.connection.health === 'degraded' ||
      connection.connection.availability === 'degraded' ||
      connection.compatibility.state === 'degraded' ||
      connection.eligibility.state === 'degraded' ||
      capabilityDecision.mode === 'degraded',
  }
}

function runtimeFamilyAllowed(family: string, allowed: readonly string[]): boolean {
  return allowed.includes(family) || (family === 'managed-pi' && allowed.includes('pi'))
}

function locationAllowed(
  connection: RuntimeConnectionDiscoveryReadModel,
  allowed: readonly ('local' | 'remote' | 'hybrid')[]
): boolean {
  const location =
    connection.node?.location === 'remote_host' || connection.location === 'agent_hq_cloud'
      ? 'remote'
      : 'local'
  return allowed.includes(location) || allowed.includes('hybrid')
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.degraded !== right.degraded) return left.degraded ? 1 : -1
  return left.connection.runtimeConnectionId.localeCompare(right.connection.runtimeConnectionId)
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
