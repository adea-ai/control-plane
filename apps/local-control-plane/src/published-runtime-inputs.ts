import {
  AgentProfileVersionSchema,
  SkillVersionSchema,
  evaluateVersionApproval,
  type AgentProfileRepository,
  type CatalogApprovalPolicy,
  type CatalogApprovalRepository,
  type SkillRepository,
} from '@control-plane/domain'

export type LocalRuntimeCatalog = Pick<
  AgentProfileRepository & SkillRepository,
  'getAgentProfileVersion' | 'getSkillVersion'
>

/**
 * Optional approval enforcement (#188) for the local runtime-input path:
 * absent leaves pin resolution unchanged; configured, the profile and every
 * referenced skill must pass the shared approval semantics.
 */
export interface LocalRuntimeApprovalGate {
  readonly approvals: Pick<CatalogApprovalRepository, 'list'>
  readonly policy: CatalogApprovalPolicy
}

export interface PublishedRuntimePins {
  readonly profile: {
    readonly profileId: string
    readonly profileVersionId: string
    readonly version: number
    readonly revision: number
    readonly schemaVersion: number
    readonly contentDigest: string
  }
  readonly skills: readonly {
    readonly skillId: string
    readonly skillVersionId: string
    readonly revision: number
    readonly schemaVersion: number
    readonly semanticVersion: string
    readonly contentDigest: string
  }[]
}

/** Shared publication/pin checks; harness-specific instruction rendering stays outside. */
export async function resolvePublishedRuntimeInputs(
  catalog: LocalRuntimeCatalog,
  pins: PublishedRuntimePins,
  errorPrefix: 'MANAGED_PI' | 'ACP',
  approval?: LocalRuntimeApprovalGate
) {
  const [profileValue, ...skillValues] = await Promise.all([
    catalog.getAgentProfileVersion(pins.profile.profileVersionId),
    ...pins.skills.map((pin) => catalog.getSkillVersion(pin.skillVersionId)),
  ])
  const profile =
    profileValue === undefined ? undefined : AgentProfileVersionSchema.parse(profileValue)
  if (
    profile === undefined ||
    profile.profileVersionId !== pins.profile.profileVersionId ||
    profile.profileId !== pins.profile.profileId ||
    profile.version !== pins.profile.version ||
    profile.revision !== pins.profile.revision ||
    profile.definition.schemaVersion !== pins.profile.schemaVersion ||
    profile.contentDigest !== pins.profile.contentDigest ||
    profile.lifecycle !== 'published'
  )
    throw new Error(`${errorPrefix}_PROFILE_PIN_UNRESOLVED`)
  const skills = pins.skills.map((pin, index) => {
    const value = skillValues[index]
    const skill = value === undefined ? undefined : SkillVersionSchema.parse(value)
    if (
      skill === undefined ||
      skill.skillVersionId !== pin.skillVersionId ||
      skill.skillId !== pin.skillId ||
      skill.revision !== pin.revision ||
      skill.manifest.schemaVersion !== pin.schemaVersion ||
      skill.manifest.semanticVersion !== pin.semanticVersion ||
      skill.manifest.contentDigest !== pin.contentDigest ||
      skill.lifecycle !== 'published'
    )
      throw new Error(`${errorPrefix}_SKILL_PIN_UNRESOLVED`)
    return skill
  })
  if (approval !== undefined) {
    await assertRuntimeInputApproved(
      approval,
      'PROFILE',
      'agent_profile',
      pins.profile.profileVersionId,
      {
        revision: profile.revision,
        contentDigest: profile.contentDigest,
        publishedAt: profile.lifecycleMetadata.publishedAt,
      },
      errorPrefix
    )
    for (const skill of skills) {
      await assertRuntimeInputApproved(
        approval,
        'SKILL',
        'skill',
        skill.skillVersionId,
        {
          revision: skill.revision,
          contentDigest: skill.manifest.contentDigest,
          publishedAt: skill.lifecycleMetadata.publishedAt,
        },
        errorPrefix
      )
    }
  }
  return { profile, skills }
}

async function assertRuntimeInputApproved(
  approval: LocalRuntimeApprovalGate,
  label: 'PROFILE' | 'SKILL',
  versionKind: 'agent_profile' | 'skill',
  versionId: string,
  version: {
    readonly revision: number
    readonly contentDigest: string
    readonly publishedAt: string | undefined
  },
  errorPrefix: 'MANAGED_PI' | 'ACP'
): Promise<void> {
  const { verdict } = await evaluateVersionApproval({
    approvals: approval.approvals,
    versionKind,
    versionId,
    policy: approval.policy,
    version,
  })
  if (verdict === 'approved' || verdict === 'grandfathered' || verdict === 'not_required') return
  const suffix = verdict === 'rejected' ? 'APPROVAL_REJECTED' : 'APPROVAL_MISSING'
  throw new Error(`${errorPrefix}_${label}_${suffix}`)
}
