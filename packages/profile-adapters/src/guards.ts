import type { DeploymentProfile } from '@control-plane/deployment'
import type {
  RuntimeAdapter,
  RuntimeDefinition,
  RuntimeExecutionHandle,
  RuntimeTransport,
} from '@control-plane/runtime-sdk'
import type { ExecutionProfile } from './index.js'

export type ProfileGuardOperation =
  | 'compose'
  | 'runtime.start'
  | 'runtime.progress'
  | 'runtime.input'
  | 'runtime.approval'
  | 'runtime.cancel'
  | 'runtime.status'
  | 'runtime.reconcile'
  | 'runtime.session'
  | 'runtime.cleanup'
  | 'workflow.wake'

export type ProfileGuardTarget =
  | { readonly kind: 'composition' }
  | {
      readonly kind: 'plan'
      readonly workspaceId?: string
      readonly executionId?: string
      readonly attemptId: string
      readonly executionPlanId: string
      readonly contentDigest: string
      readonly schemaVersion: number
    }
  | ({ readonly kind: 'handle' } & RuntimeExecutionHandle)
  | {
      readonly kind: 'interaction'
      readonly handleId: string
      readonly attemptId: string
      readonly startedAt: string
      readonly externalSessionId?: string
      readonly interactionId: string
    }
  | {
      readonly kind: 'session'
      readonly operation: string
      readonly sessionId?: string
    }
  | {
      readonly kind: 'workflow'
      readonly executionId: string
      readonly workflowId: string
      readonly executionPlanId: string
      readonly contentDigest: string
      readonly schemaVersion: number
      readonly workspaceId?: string
    }

/** Server-composed placement facts. They are never accepted from task/prompt input. */
export interface TrustedProfilePlacement {
  readonly controlPlaneHostId: string
  readonly runtimeHostId: string
  readonly runtimeLocation: RuntimeDefinition['location']
  readonly coLocated: boolean
}

export interface ProfileGuardContext {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly operation: ProfileGuardOperation
  readonly target: ProfileGuardTarget
  readonly placement: TrustedProfilePlacement
}

/**
 * A server-only closure bound to the authenticated original actor. It must
 * re-read current workspace audience, grants, expiry, and pinned plan/scope,
 * attempt, and full handle tuple. Derive canonical workspace/scope from
 * retained server records and cross-check supplied workspace identifiers; the
 * target contains identifiers, never an authorization claim.
 */
export interface CurrentProfileAuthorityGuard {
  assertCurrent(context: ProfileGuardContext): Promise<void>
}

/**
 * A separate server-only guard over the configured host, stores, and runtime
 * placement. It must reject unauthorized content movement or stale placement.
 */
export interface CurrentProfileResidencyGuard {
  assertCurrent(context: ProfileGuardContext): Promise<void>
}

export interface ProfileExecutionGuards {
  readonly authority: CurrentProfileAuthorityGuard
  readonly residency: CurrentProfileResidencyGuard
}

export interface ProfileRuntimeTopologyContext {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly expectedTransportKind: RuntimeTransport['kind']
  readonly placement: TrustedProfilePlacement
}

/**
 * A server-owned check that these exact adapter and transport instances are
 * the configured route for the supplied topology. Implementations should
 * compare against trusted composition state, not infer routing from
 * RuntimeAdapterWithTransport.transportKind or inspection metadata. The
 * instance references are ephemeral inputs; do not persist or serialize them.
 */
export interface CurrentProfileRuntimeTopologyGuard {
  assertCurrent(
    context: ProfileRuntimeTopologyContext,
    binding: { readonly adapter: RuntimeAdapter; readonly transport: RuntimeTransport }
  ): Promise<void>
}

export async function assertProfileGuards(
  guards: ProfileExecutionGuards,
  context: ProfileGuardContext
): Promise<void> {
  await guards.authority.assertCurrent(context)
  await guards.residency.assertCurrent(context)
}

export async function assertProfileCompositionResidency(input: {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly placement: TrustedProfilePlacement
  readonly guard: CurrentProfileResidencyGuard
}): Promise<void> {
  await input.guard.assertCurrent({
    profile: input.profile,
    deploymentProfile: input.deploymentProfile,
    operation: 'compose',
    target: { kind: 'composition' },
    placement: input.placement,
  })
}
