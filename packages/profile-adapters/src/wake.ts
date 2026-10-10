import type { DeploymentProfile } from '@control-plane/deployment'
import {
  ExecutionWorkflowInputSchema,
  type ExecutionWorkflowInput,
} from '@control-plane/orchestration'
import {
  assertProfileCompositionResidency,
  assertProfileGuards,
  type ProfileExecutionGuards,
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
      await assertWakeTopology(input.topology, topologyContext, driver)
      await assertProfileGuards(input.guards, {
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
        },
      })
      await submit(parsed)
      await assertProfileGuards(input.guards, {
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
        },
      })
      await assertWakeTopology(input.topology, topologyContext, driver)
    },
  })
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
