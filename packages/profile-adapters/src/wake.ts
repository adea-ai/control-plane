import type { DeploymentProfile } from '@control-plane/deployment'
import {
  ExecutionWorkflowInputSchema,
  type ExecutionWorkflowInput,
} from '@control-plane/orchestration'
import {
  assertProfileCompositionResidency,
  assertProfileGuards,
  type ProfileExecutionGuards,
  type RetainedProfileWorkflowWakeGeneration,
  type TrustedProfilePlacement,
} from './guards.js'
import { bindProfileStorage, ExecutionProfiles, ProfileAdapterError } from './index.js'
import type { ExecutionProfile } from './index.js'

export type ProfileWorkflowWakeKind = 'embedded-sqlite-queue' | 'restate-ingress'

/** Server-owned adapter to the existing embedded or Restate workflow dispatcher. */
export interface ProfileWorkflowWakeDriver {
  readonly deploymentProfile: DeploymentProfile
  readonly kind: ProfileWorkflowWakeKind
  submit(input: ExecutionWorkflowInput): Promise<void>
}

export interface ProfileWorkflowWakeTopologyContext {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly expectedWakeKind: ProfileWorkflowWakeKind
  readonly placement: TrustedProfilePlacement
}

/** Confirms the exact dispatcher instance against server-owned topology. */
export interface CurrentProfileWorkflowWakeTopologyGuard {
  assertCurrent(
    context: ProfileWorkflowWakeTopologyContext,
    driver: ProfileWorkflowWakeDriver
  ): Promise<void>
}

export interface BindProfileWorkflowWakeInput {
  readonly profile: ExecutionProfile
  readonly deployment: Parameters<typeof bindProfileStorage>[1]
  readonly driver: ProfileWorkflowWakeDriver
  readonly placement: TrustedProfilePlacement
  readonly guards: ProfileExecutionGuards
  readonly topology: CurrentProfileWorkflowWakeTopologyGuard
}

/** Durable server repositories used to bind a wake to its admitted identity. */
export interface RetainedProfileWorkflowWakeRecords {
  readonly commands: {
    getByExecutionId(executionId: string): Promise<RetainedWorkflowCommandRecord | undefined>
    getExecution(executionId: string): Promise<RetainedWorkflowExecutionRecord | undefined>
  }
  readonly executions: {
    getAttempt(attemptId: string): Promise<RetainedWorkflowAttemptRecord | undefined>
  }
  readonly plans: {
    get(
      reference: ExecutionWorkflowInput['executionPlan']
    ): Promise<RetainedWorkflowPlanRecord | undefined>
  }
}

export interface RetainedWorkflowPlanRecord {
  readonly executionPlanId: string
  readonly contentDigest: string
  readonly schemaVersion: number
  readonly correlation: {
    readonly workspaceId: string
    readonly projectId?: string | undefined
    readonly taskId: string
    readonly agentId: string
    readonly executionScope?: unknown | undefined
  }
  readonly graph?:
    | {
        readonly reference: NonNullable<ExecutionWorkflowInput['graph']>['reference']
        readonly input: NonNullable<ExecutionWorkflowInput['graph']>['input']
      }
    | undefined
}

export interface RetainedWorkflowCommandRecord {
  readonly executionId: string
  readonly commandId: string
  readonly version: number
  readonly status: string
  readonly workspaceId: string
  readonly projectId?: string | undefined
  readonly taskId: string
  readonly agentId: string
  readonly executionScope?: unknown | undefined
  readonly executionPlan: ExecutionWorkflowInput['executionPlan']
}

export interface RetainedWorkflowExecutionRecord {
  readonly executionId: string
  readonly state: string
  readonly version: number
  readonly correlation: {
    readonly workspaceId: string
    readonly projectId?: string | undefined
    readonly taskId: string
    readonly agentId: string
    readonly executionScope?: unknown | undefined
  }
  readonly executionPlan: ExecutionWorkflowInput['executionPlan']
  readonly marketplacePluginReferences?:
    | ExecutionWorkflowInput['marketplacePluginReferences']
    | undefined
  readonly deadlineAt?: string | undefined
  readonly attemptCount: number
  readonly latestAttemptId?: string | undefined
}

export interface RetainedWorkflowAttemptRecord {
  readonly attemptId: string
  readonly executionId: string
  readonly sequence: number
  readonly state: string
  readonly version: number
}

export interface BindRetainedProfileWorkflowWakeInput extends BindProfileWorkflowWakeInput {
  readonly retainedRecords: RetainedProfileWorkflowWakeRecords
}

export interface BoundProfileWorkflowWake {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly kind: ProfileWorkflowWakeKind
  submit(input: ExecutionWorkflowInput): Promise<void>
}

/**
 * Binds the already-selected durable wake path without providing an alternate
 * route. The trusted authority and residency guards run before every submit.
 */
export async function bindProfileWorkflowWake(
  input: BindProfileWorkflowWakeInput
): Promise<BoundProfileWorkflowWake> {
  return bindProfileWorkflowWakeInternal(input)
}

/**
 * Production binding for wake submissions. Each submit resolves the persisted
 * command, execution and any latest attempt, checks the workflow target
 * against those records, and admits only an accepted/reconciliation-required
 * zero-attempt execution. It then re-reads command and execution generations
 * immediately before calling the exact topology-guarded dispatcher. Existing
 * attempts fail closed; this does not certify active-attempt replay or make the
 * separate stores and dispatcher atomic.
 */
export async function bindRetainedProfileWorkflowWake(
  input: BindRetainedProfileWorkflowWakeInput
): Promise<BoundProfileWorkflowWake> {
  return bindProfileWorkflowWakeInternal(input, input.retainedRecords)
}

async function bindProfileWorkflowWakeInternal(
  input: BindProfileWorkflowWakeInput,
  retainedRecords?: RetainedProfileWorkflowWakeRecords
): Promise<BoundProfileWorkflowWake> {
  const storage = bindProfileStorage(input.profile, input.deployment)
  const placement = Object.freeze({ ...input.placement })
  const driver = input.driver
  const submit = driver.submit.bind(driver)
  const expectedKind = expectedWakeKind(input.profile)
  if (driver.deploymentProfile !== storage.deploymentProfile || driver.kind !== expectedKind) {
    throw new ProfileAdapterError('PROFILE_WAKE_MISMATCH', {
      profile: storage.profile,
      deploymentProfile: storage.deploymentProfile,
      wakeProfile: driver.deploymentProfile,
      wakeKind: driver.kind,
      expectedWakeKind: expectedKind,
    })
  }
  validatePlacement(storage.profile, placement)
  const topologyContext: ProfileWorkflowWakeTopologyContext = Object.freeze({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    expectedWakeKind: expectedKind,
    placement,
  })
  await assertWakeTopology(input.topology, topologyContext, driver)
  await assertProfileCompositionResidency({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    placement,
    guard: input.guards.residency,
  })
  await assertWakeTopology(input.topology, topologyContext, driver)

  return Object.freeze({
    profile: storage.profile,
    deploymentProfile: storage.deploymentProfile,
    kind: driver.kind,
    submit: async (inputValue: ExecutionWorkflowInput) => {
      const parsed = ExecutionWorkflowInputSchema.parse(inputValue)
      const retained =
        retainedRecords === undefined
          ? undefined
          : await resolveRetainedWakeGeneration(parsed, retainedRecords)
      await assertWakeTopology(input.topology, topologyContext, driver)
      // The retained value is the admission snapshot. Pass the same snapshot to
      // both workflow.wake guard phases; post-submit guards must not mistake it
      // for a fresh execution state after the dispatcher may create an attempt.
      const guardContext = {
        profile: storage.profile,
        deploymentProfile: storage.deploymentProfile,
        operation: 'workflow.wake',
        placement,
        target: {
          kind: 'workflow',
          executionId: parsed.executionId,
          workflowId: parsed.workflowId,
          executionPlanId: parsed.executionPlan.executionPlanId,
          contentDigest: parsed.executionPlan.contentDigest,
          schemaVersion: parsed.executionPlan.schemaVersion,
          ...(parsed.graph === undefined ? {} : { workspaceId: parsed.graph.workspaceId }),
          ...(retained === undefined ? {} : { retained }),
        },
      } as const
      await assertProfileGuards(input.guards, guardContext)
      if (retained !== undefined && retainedRecords !== undefined) {
        await assertRetainedWakeGenerationCurrent(parsed, retained, retainedRecords)
      }
      await submit(parsed)
      await assertProfileGuards(input.guards, guardContext)
      await assertWakeTopology(input.topology, topologyContext, driver)
    },
  })
}

async function resolveRetainedWakeGeneration(
  input: ExecutionWorkflowInput,
  records: RetainedProfileWorkflowWakeRecords
): Promise<RetainedProfileWorkflowWakeGeneration> {
  const [command, execution, plan] = await Promise.all([
    records.commands.getByExecutionId(input.executionId),
    records.commands.getExecution(input.executionId),
    records.plans.get(input.executionPlan),
  ])
  if (
    !command ||
    !execution ||
    !plan ||
    !matchesRetainedWorkflow(input, command, execution, plan)
  ) {
    throw new ProfileAdapterError('PROFILE_WAKE_RETAINED_RECORD_INVALID')
  }

  const attempt =
    execution.latestAttemptId === undefined
      ? undefined
      : await records.executions.getAttempt(execution.latestAttemptId)
  if (
    (execution.attemptCount === 0) !== (execution.latestAttemptId === undefined) ||
    (execution.latestAttemptId !== undefined &&
      (attempt === undefined ||
        attempt.attemptId !== execution.latestAttemptId ||
        attempt.executionId !== execution.executionId ||
        attempt.sequence !== execution.attemptCount))
  ) {
    throw new ProfileAdapterError('PROFILE_WAKE_RETAINED_RECORD_INVALID')
  }

  const zeroAttemptWake =
    execution.attemptCount === 0 &&
    execution.latestAttemptId === undefined &&
    (execution.state === 'accepted' || execution.state === 'reconciliation_required')
  if (
    !['accepted', 'processing', 'reconciliation_required'].includes(command.status) ||
    !zeroAttemptWake
  ) {
    throw new ProfileAdapterError('PROFILE_WAKE_RETAINED_RECORD_INVALID')
  }

  return Object.freeze({
    command: Object.freeze({
      commandId: command.commandId,
      version: command.version,
      status: command.status,
    }),
    execution: Object.freeze({
      version: execution.version,
      state: execution.state,
      attemptCount: execution.attemptCount,
    }),
  })
}

async function assertRetainedWakeGenerationCurrent(
  input: ExecutionWorkflowInput,
  expected: RetainedProfileWorkflowWakeGeneration,
  records: RetainedProfileWorkflowWakeRecords
): Promise<void> {
  let current: RetainedProfileWorkflowWakeGeneration
  try {
    current = await resolveRetainedWakeGeneration(input, records)
  } catch (error) {
    if (
      error instanceof ProfileAdapterError &&
      error.code === 'PROFILE_WAKE_RETAINED_RECORD_INVALID'
    ) {
      throw new ProfileAdapterError('PROFILE_WAKE_RETAINED_RECORD_STALE')
    }
    throw error
  }
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new ProfileAdapterError('PROFILE_WAKE_RETAINED_RECORD_STALE')
  }
}

function matchesRetainedWorkflow(
  input: ExecutionWorkflowInput,
  command: RetainedWorkflowCommandRecord,
  execution: RetainedWorkflowExecutionRecord,
  plan: RetainedWorkflowPlanRecord
): boolean {
  const correlation = execution.correlation
  return (
    command.executionId === input.executionId &&
    execution.executionId === input.executionId &&
    samePlan(input.executionPlan, plan) &&
    samePlan(input.executionPlan, command.executionPlan) &&
    samePlan(input.executionPlan, execution.executionPlan) &&
    command.workspaceId === correlation.workspaceId &&
    command.projectId === correlation.projectId &&
    command.taskId === correlation.taskId &&
    command.agentId === correlation.agentId &&
    canonicalJson(command.executionScope) === canonicalJson(correlation.executionScope) &&
    plan.correlation.workspaceId === correlation.workspaceId &&
    plan.correlation.projectId === correlation.projectId &&
    plan.correlation.taskId === correlation.taskId &&
    plan.correlation.agentId === correlation.agentId &&
    canonicalJson(plan.correlation.executionScope) === canonicalJson(correlation.executionScope) &&
    execution.deadlineAt === input.deadlineAt &&
    matchesWorkflowGraph(input, plan) &&
    canonicalJson(input.marketplacePluginReferences) ===
      canonicalJson(execution.marketplacePluginReferences)
  )
}

function matchesWorkflowGraph(
  input: ExecutionWorkflowInput,
  plan: RetainedWorkflowPlanRecord
): boolean {
  if (plan.graph === undefined) return input.graph === undefined
  return (
    input.graph !== undefined &&
    input.graph.workspaceId === plan.correlation.workspaceId &&
    input.graph.threadId === `graph:${input.executionId}` &&
    canonicalJson(input.graph.reference) === canonicalJson(plan.graph.reference) &&
    canonicalJson(input.graph.input) === canonicalJson(plan.graph.input)
  )
}

function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(canonicalValue(value))
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareCodePointOrder(left, right))
        .map(([key, entry]) => [key, canonicalValue(entry)])
    )
  }
  return value
}

function compareCodePointOrder(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0)!)
  const rightPoints = Array.from(right, (character) => character.codePointAt(0)!)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index]! - rightPoints[index]!
    if (difference !== 0) return difference
  }
  return leftPoints.length - rightPoints.length
}

function samePlan(
  left: ExecutionWorkflowInput['executionPlan'],
  right:
    | RetainedWorkflowCommandRecord['executionPlan']
    | RetainedWorkflowExecutionRecord['executionPlan']
    | Pick<RetainedWorkflowPlanRecord, 'executionPlanId' | 'contentDigest' | 'schemaVersion'>
): boolean {
  return (
    left.executionPlanId === right.executionPlanId &&
    left.contentDigest === right.contentDigest &&
    left.schemaVersion === right.schemaVersion
  )
}

function expectedWakeKind(profile: ExecutionProfile): ProfileWorkflowWakeKind {
  return profile === ExecutionProfiles.local ? 'embedded-sqlite-queue' : 'restate-ingress'
}

async function assertWakeTopology(
  guard: CurrentProfileWorkflowWakeTopologyGuard,
  context: ProfileWorkflowWakeTopologyContext,
  driver: ProfileWorkflowWakeDriver
): Promise<void> {
  if (
    driver.deploymentProfile !== context.deploymentProfile ||
    driver.kind !== context.expectedWakeKind
  ) {
    throw new ProfileAdapterError('PROFILE_WAKE_MISMATCH', {
      profile: context.profile,
      deploymentProfile: driver.deploymentProfile,
      wakeKind: driver.kind,
      expectedWakeKind: context.expectedWakeKind,
    })
  }
  await guard.assertCurrent(context, driver)
}

function validatePlacement(profile: ExecutionProfile, placement: TrustedProfilePlacement): void {
  if (
    placement.controlPlaneHostId.length === 0 ||
    placement.runtimeHostId.length === 0 ||
    placement.coLocated !== (placement.controlPlaneHostId === placement.runtimeHostId)
  ) {
    throw new ProfileAdapterError('PROFILE_PLACEMENT_MISMATCH', { profile })
  }
  if (
    (profile === ExecutionProfiles.local && placement.runtimeLocation !== 'local_device') ||
    (profile === ExecutionProfiles.selfHosted && placement.runtimeLocation !== 'remote_host') ||
    (profile === ExecutionProfiles.hosted && placement.runtimeLocation !== 'agent_hq_cloud')
  ) {
    throw new ProfileAdapterError('PROFILE_PLACEMENT_MISMATCH', {
      profile,
      runtimeLocation: placement.runtimeLocation,
    })
  }
}
