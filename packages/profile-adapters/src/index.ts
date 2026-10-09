import type { DeploymentComposition, DeploymentProfile } from '@control-plane/deployment'
import { DeploymentProfiles } from '@control-plane/deployment'
import { z } from 'zod'

export const ExecutionProfiles = Object.freeze({
  local: 'local',
  selfHosted: 'self-hosted',
  hosted: 'hosted',
} as const)

export const ExecutionProfileSchema = z.enum([
  ExecutionProfiles.local,
  ExecutionProfiles.selfHosted,
  ExecutionProfiles.hosted,
])

export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>

const executionProfileDisplayLabels: Readonly<Record<string, ExecutionProfile>> = Object.freeze({
  Local: ExecutionProfiles.local,
  'Self-hosted': ExecutionProfiles.selfHosted,
  Hosted: ExecutionProfiles.hosted,
})

export type ProfileCapabilityState = 'supported' | 'conditional' | 'unavailable'

export interface ProfileCapabilityMatrixEntry {
  readonly profile: ExecutionProfile
  readonly deploymentProfiles: readonly DeploymentProfile[]
  readonly storage: {
    readonly state: ProfileCapabilityState
    readonly variants: readonly string[]
  }
  readonly schedulerWake: {
    readonly state: ProfileCapabilityState
    readonly variants: readonly string[]
  }
  readonly runtime: {
    readonly state: ProfileCapabilityState
    readonly reason: string
  }
  readonly residency: string
}

/**
 * Source-level support map, not a live certification. Runtime availability is
 * decided from the supplied adapters, current guards, and exact topology below.
 */
export const ProfileCapabilityMatrix: readonly ProfileCapabilityMatrixEntry[] = Object.freeze([
  Object.freeze({
    profile: ExecutionProfiles.local,
    deploymentProfiles: Object.freeze([DeploymentProfiles.local]),
    storage: Object.freeze({ state: 'supported', variants: Object.freeze(['sqlite']) }),
    schedulerWake: Object.freeze({
      state: 'supported',
      variants: Object.freeze(['embedded-sqlite-queue']),
    }),
    runtime: Object.freeze({
      state: 'conditional',
      reason: 'A configured local RuntimeAdapter and direct-local transport are required.',
    }),
    residency: 'Local project and credential data stay at the user-controlled device by default.',
  }),
  Object.freeze({
    profile: ExecutionProfiles.selfHosted,
    deploymentProfiles: Object.freeze([
      DeploymentProfiles.hostedSimple,
      DeploymentProfiles.hostedServer,
    ]),
    storage: Object.freeze({
      state: 'supported',
      variants: Object.freeze(['hosted-simple:sqlite', 'hosted-server:postgresql']),
    }),
    schedulerWake: Object.freeze({
      state: 'supported',
      variants: Object.freeze(['restate-ingress']),
    }),
    runtime: Object.freeze({
      state: 'conditional',
      reason:
        'The configured adapter, concrete transport, current authority, and user-controlled host residency must agree.',
    }),
    residency:
      'The operator-controlled host and its configured storage remain the execution boundary.',
  }),
  Object.freeze({
    profile: ExecutionProfiles.hosted,
    deploymentProfiles: Object.freeze([DeploymentProfiles.cloud]),
    storage: Object.freeze({ state: 'supported', variants: Object.freeze(['cloud:postgresql']) }),
    schedulerWake: Object.freeze({
      state: 'supported',
      variants: Object.freeze(['restate-ingress']),
    }),
    runtime: Object.freeze({
      state: 'conditional',
      reason:
        'A healthy managed-cloud RuntimeAdapter over the authenticated remote-gateway transport is required, together with the trusted topology, current authority, and residency guards. The Node Pi Durable adapter declares CLOUD_PROFILE_UNQUALIFIED and the unregistered Cloudflare host advertises no capabilities, so both fail closed. No implicit fallback to a local or self-hosted runtime is provided.',
    }),
    residency:
      'Managed-cloud placement requires an explicit current policy; no implicit transfer is allowed.',
  }),
])

export class ProfileAdapterError extends Error {
  constructor(
    readonly code:
      | 'PROFILE_NAME_INVALID'
      | 'PROFILE_DEPLOYMENT_MISMATCH'
      | 'PROFILE_PERSISTENCE_MISMATCH'
      | 'PROFILE_WORKFLOW_MISMATCH'
      | 'PROFILE_WAKE_MISMATCH'
      | 'PROFILE_PLACEMENT_MISMATCH'
      | 'PROFILE_RUNTIME_NOT_QUALIFIED'
      | 'PROFILE_RUNTIME_TRANSPORT_MISMATCH'
      | 'PROFILE_RUNTIME_BINDING_MISMATCH'
      | 'PROFILE_RUNTIME_PROGRESS_INVALID'
      | 'PROFILE_RUNTIME_UNAVAILABLE'
      | 'PROFILE_RUNTIME_CAPABILITY_UNAVAILABLE'
      | 'PROFILE_AUTHORITY_REJECTED'
      | 'PROFILE_RESIDENCY_REJECTED',
    readonly details: Readonly<Record<string, string>> = {}
  ) {
    super('Profile adapter composition is unavailable')
    this.name = 'ProfileAdapterError'
  }
}

export interface ProfileStorageBinding {
  readonly profile: ExecutionProfile
  readonly deploymentProfile: DeploymentProfile
  readonly persistenceDialect: 'sqlite' | 'postgresql'
  readonly deployment: DeploymentComposition
}

/**
 * Maps user-facing profile names to the existing, distinct infrastructure
 * profiles and rejects mismatched persistence/workflow providers.
 */
export function bindProfileStorage(
  profileInput: unknown,
  deployment: DeploymentComposition
): ProfileStorageBinding {
  const profile = resolveExecutionProfile(profileInput)
  if (!profile) throw new ProfileAdapterError('PROFILE_NAME_INVALID')
  const deploymentProfile = deploymentProfileFor(profile, deployment.profile)
  if (!deploymentProfile) {
    throw new ProfileAdapterError('PROFILE_DEPLOYMENT_MISMATCH', {
      profile,
      deploymentProfile: deployment.profile,
    })
  }

  const expectedDialect = expectedPersistenceDialect(deploymentProfile)
  if (
    deployment.persistence.profile !== deploymentProfile ||
    deployment.persistence.dialect !== expectedDialect
  ) {
    throw new ProfileAdapterError('PROFILE_PERSISTENCE_MISMATCH', {
      deploymentProfile,
      persistenceProfile: deployment.persistence.profile,
      dialect: deployment.persistence.dialect,
      expectedDialect,
    })
  }
  if (deployment.workflow.profile !== deploymentProfile) {
    throw new ProfileAdapterError('PROFILE_WORKFLOW_MISMATCH', {
      deploymentProfile,
      workflowProfile: deployment.workflow.profile,
    })
  }

  return Object.freeze({
    profile,
    deploymentProfile,
    persistenceDialect: expectedDialect,
    deployment,
  })
}

function resolveExecutionProfile(profileInput: unknown): ExecutionProfile | undefined {
  const parsedProfile = ExecutionProfileSchema.safeParse(profileInput)
  if (parsedProfile.success) return parsedProfile.data
  if (
    typeof profileInput === 'string' &&
    Object.hasOwn(executionProfileDisplayLabels, profileInput)
  ) {
    return executionProfileDisplayLabels[profileInput]
  }
  return undefined
}

function deploymentProfileFor(
  profile: ExecutionProfile,
  deploymentProfile: DeploymentProfile
): DeploymentProfile | undefined {
  if (profile === ExecutionProfiles.local)
    return deploymentProfile === DeploymentProfiles.local ? deploymentProfile : undefined
  if (profile === ExecutionProfiles.selfHosted) {
    return deploymentProfile === DeploymentProfiles.hostedSimple ||
      deploymentProfile === DeploymentProfiles.hostedServer
      ? deploymentProfile
      : undefined
  }
  return deploymentProfile === DeploymentProfiles.cloud ? deploymentProfile : undefined
}

function expectedPersistenceDialect(profile: DeploymentProfile): 'sqlite' | 'postgresql' {
  return profile === DeploymentProfiles.hostedServer || profile === DeploymentProfiles.cloud
    ? 'postgresql'
    : 'sqlite'
}

export * from './guards.js'
export * from './runtime.js'
export * from './wake.js'
