import { createHash } from 'node:crypto'
import {
  compareCodePointOrder,
  executionScopeOf,
  executionScopesEqual,
} from '@control-plane/contracts'
import type { RuntimeConnectionDiscoveryReadModel } from '@control-plane/contracts'
import type { Execution, ExecutionAttempt } from '@control-plane/domain'
import type { ExecutionPlan } from '@control-plane/execution-plan'
import { availableRuntimesFromDiscovery } from '@control-plane/contracts'
import { selectRuntimesExposingHarness } from '@control-plane/policy'
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
  /**
   * Optional accepted harness (#670 path 1, #678): when set, only candidates
   * whose discovered harness ids contain this exact id are eligible, applied
   * before ranking. If none qualify the attempt fails closed with
   * NO_COMPATIBLE_RUNTIME; there is no fallback to another harness or runtime.
   * No pin means no behavior change.
   */
  readonly pinnedHarnessId?: string
}

type SelectedRuntime = NonNullable<ExecutionAttempt['runtime']>

export class RuntimeDiscoveryAttemptRouter implements RuntimeAttemptRouter {
  readonly #discovery: RuntimeDiscoveryReadPort
  readonly #now: () => string

  readonly #pinnedHarnessId: string | undefined

  constructor(options: RuntimeDiscoveryAttemptRouterOptions) {
    this.#discovery = options.discovery
    this.#now = options.now ?? (() => new Date().toISOString())
    this.#pinnedHarnessId = options.pinnedHarnessId
  }

  async resolve(input: {
    readonly execution: Execution
    readonly executionPlan: ExecutionPlan
  }): Promise<SelectedRuntime> {
    const scope = executionScopeOf(input.execution.correlation)
    if (
      input.executionPlan.schemaVersion !== 1 ||
      scope.kind !== 'project' ||
      !executionScopesEqual(input.execution.correlation, input.executionPlan.correlation)
    ) {
      throw new Error('WORKFLOW_RUNTIME_SCOPE_UNSUPPORTED')
    }
    const evaluatedAt = this.#now()
    const discovered = await this.#discovery.listRuntimeConnections({
      workspaceId: input.execution.correlation.workspaceId,
      projectId: scope.projectId,
    })
    // Accepted-harness hard filter (#678) runs on the eligible set BEFORE
    // ranking: only candidates exposing the exact pinned harness id survive.
    // An empty set with a pin is a typed NO_COMPATIBLE_RUNTIME denial.
    const live = selectRuntimesExposingHarness(
      discovered
        .map((connection) => candidate(connection, input.executionPlan, evaluatedAt))
        .filter((value) => value !== undefined)
        .map((value) => ({ ...value, harnessIds: harnessIdsOf(value.connection) })),
      this.#pinnedHarnessId
    )
    // TDD-A377: a local location the plan could use, that is not live-eligible right now, is never
    // silently replaced by a remote runtime. While one exists the choice is restricted to local
    // candidates, so a healthy local runtime still wins over a remote one that merely ranks first,
    // and an empty local set is a typed denial instead of an implicit cloud reroute.
    const liveIds = new Set(live.map(({ connection }) => connection.runtimeConnectionId))
    const localFenced = discovered.some(
      (connection) =>
        !liveIds.has(connection.runtimeConnectionId) &&
        fencedLocalRuntime(connection, input.executionPlan, this.#pinnedHarnessId)
    )
    const remoteHostFenced = discovered.some(
      (connection) =>
        !liveIds.has(connection.runtimeConnectionId) &&
        fencedRemoteHostRuntime(connection, input.executionPlan, this.#pinnedHarnessId)
    )
    const eligible = localFenced
      ? live.filter(({ connection }) => !isRemoteLocation(connection))
      : remoteHostFenced
        ? live.filter(({ connection }) => !isCloudServiceRuntime(connection))
        : live
    const candidates = eligible.toSorted(compareCandidates)
    const selected = candidates[0]
    if (selected === undefined) {
      throw new Error(
        localFenced && live.length > 0
          ? 'WORKFLOW_RUNTIME_LOCAL_UNAVAILABLE_NO_FALLBACK'
          : remoteHostFenced && live.length > 0
            ? 'WORKFLOW_RUNTIME_REMOTE_HOST_UNAVAILABLE_NO_FALLBACK'
            : 'WORKFLOW_RUNTIME_UNAVAILABLE'
      )
    }
    const inputDigest = digest({
      executionId: input.execution.executionId,
      executionPlanId: input.executionPlan.executionPlanId,
      executionPlanDigest: input.executionPlan.contentDigest,
      runtimeRequirements: [...input.executionPlan.runtimeRequirements].toSorted((left, right) =>
        compareCodePointOrder(left.capability, right.capability)
      ),
      constraints: {
        allowedFamilies: [...input.executionPlan.constraints.runtime.allowedFamilies].toSorted(),
        allowedLocations: [...input.executionPlan.constraints.runtime.allowedLocations].toSorted(),
      },
      // Pinned attempts bind the accepted harness into the evidence; unpinned
      // digests are unchanged.
      ...(this.#pinnedHarnessId === undefined ? {} : { acceptedHarnessId: this.#pinnedHarnessId }),
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
        reasonCodes: [
          selected.degraded ? 'RUNTIME_SELECTED_DEGRADED' : 'RUNTIME_SELECTED',
          ...(this.#pinnedHarnessId === undefined ? [] : ['HARNESS_PINNED']),
        ],
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
  const capabilityDecision = capabilityDecisionOf(connection, plan)
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

// Exact identity. The former managed-pi -> pi alias had no canonical mapping
// behind it (the managed driver identifies as managed-pi end to end), so it is
// removed rather than preserved.
function runtimeFamilyAllowed(family: string, allowed: readonly string[]): boolean {
  return allowed.includes(family)
}

function harnessIdsOf(connection: RuntimeConnectionDiscoveryReadModel): readonly string[] {
  return availableRuntimesFromDiscovery([connection])[0]?.harnessIds ?? []
}

/**
 * The harness identity a connection would expose if it were available. The discovery family is the
 * harness id (see availableRuntimesFromDiscovery), but that mapper drops unavailable and revoked
 * records, so it cannot answer whether an offline or revoked connection matches a pin. Matching is
 * still exact family identity; only the availability filter is left out.
 */
function staticHarnessIdsOf(connection: RuntimeConnectionDiscoveryReadModel): readonly string[] {
  return [connection.family]
}

function isEnrolledRemoteHost(connection: RuntimeConnectionDiscoveryReadModel): boolean {
  return connection.node?.location === 'remote_host'
}

function isCloudServiceRuntime(connection: RuntimeConnectionDiscoveryReadModel): boolean {
  return connection.node?.location === 'agent_hq_cloud' || connection.location === 'agent_hq_cloud'
}

function isRemoteLocation(connection: RuntimeConnectionDiscoveryReadModel): boolean {
  return isEnrolledRemoteHost(connection) || isCloudServiceRuntime(connection)
}

function locationAllowed(
  connection: RuntimeConnectionDiscoveryReadModel,
  allowed: readonly ('local' | 'remote' | 'hybrid')[]
): boolean {
  const location = isRemoteLocation(connection) ? 'remote' : 'local'
  return allowed.includes(location) || allowed.includes('hybrid')
}

/**
 * A route the plan could use but cannot use now must not trigger location fallback.
 *
 * Only runtimes that are statically unusable for this plan are exempt: a disallowed family or
 * location, missing capability, an unpinned harness, a denied entitlement, or a compatibility state
 * of `incompatible` or `capability_missing`. Everything else that keeps a connection out of the live
 * candidate set (offline, stale, reconnecting, unknown health, revoked or missing grant, revoked or
 * unavailable compatibility, no node, ineligible) is an unavailable location, not a different one.
 */
function canRuntimeServePlanIfAvailable(
  connection: RuntimeConnectionDiscoveryReadModel,
  plan: ExecutionPlan,
  pinnedHarnessId: string | undefined
): boolean {
  return (
    locationAllowed(connection, plan.constraints.runtime.allowedLocations) &&
    runtimeFamilyAllowed(connection.family, plan.constraints.runtime.allowedFamilies) &&
    (pinnedHarnessId === undefined || staticHarnessIdsOf(connection).includes(pinnedHarnessId)) &&
    connection.access.entitlement.state !== 'denied' &&
    !['incompatible', 'capability_missing'].includes(connection.compatibility.state) &&
    capabilityDecisionOf(connection, plan).eligible
  )
}

/**
 * A local-location runtime the plan could have used, but which is not usable right now. While one
 * exists, a remote runtime must not be chosen in its place: that would be an implicit cloud reroute.
 */
function fencedLocalRuntime(
  connection: RuntimeConnectionDiscoveryReadModel,
  plan: ExecutionPlan,
  pinnedHarnessId: string | undefined
): boolean {
  return (
    !isRemoteLocation(connection) &&
    canRuntimeServePlanIfAvailable(connection, plan, pinnedHarnessId)
  )
}

/**
 * An unavailable enrolled remote_host is a device route, not the cloud service. Do not replace it
 * with the cloud service when it otherwise could have served this plan.
 */
function fencedRemoteHostRuntime(
  connection: RuntimeConnectionDiscoveryReadModel,
  plan: ExecutionPlan,
  pinnedHarnessId: string | undefined
): boolean {
  return (
    isEnrolledRemoteHost(connection) &&
    canRuntimeServePlanIfAvailable(connection, plan, pinnedHarnessId)
  )
}

function capabilityDecisionOf(
  connection: RuntimeConnectionDiscoveryReadModel,
  plan: ExecutionPlan
) {
  return evaluateCapabilities(
    connection.capabilityDetails.flatMap((capability) => {
      const parsed = RuntimeCapabilitySchema.safeParse(capability)
      return parsed.success ? [parsed.data] : []
    }),
    plan.runtimeRequirements
  )
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (left.degraded !== right.degraded) return left.degraded ? 1 : -1
  return compareCodePointOrder(
    left.connection.runtimeConnectionId,
    right.connection.runtimeConnectionId
  )
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`
}
